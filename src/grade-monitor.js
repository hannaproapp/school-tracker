const zone = 'America/New_York';
const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function eastern(time) {
  const d = Object.fromEntries(clock.formatToParts(time).map(p => [p.type, p.value]));
  return { day: d.year + '-' + d.month + '-' + d.day, minute: +d.hour * 60 + +d.minute };
}

// Check ten minutes after each scheduled start. Compare server receipt times in ET.
export function missedSlot(now, lastReceipt) {
  const local = eastern(now);
  const start = [885, 345].find(m => local.minute >= m + 10);
  if (start === undefined) return null;
  const time = Date.parse(lastReceipt);
  if (Number.isFinite(time)) {
    const last = eastern(time);
    if (last.day === local.day && last.minute >= start) return null;
  }
  return { id: local.day + '/' + start, label: start === 345 ? '5:45 a.m.' : '2:45 p.m.' };
}

export function makeGradeMonitor({ kids, load, save, channels, now = () => new Date() }) {
  let running = false;
  return async function check() {
    if (running) return;
    running = true;
    try {
      for (const kid of kids) {
        const receipt = load('bb-' + kid.id, null)?.at;
        const slot = missedSlot(now(), receipt);
        if (!slot) continue;
        const key = 'grade-delivery-' + kid.id;
        const prior = load(key, {});
        const sent = prior.slot === slot.id ? prior : { slot: slot.id };
        const title = kid.name + ': grade sync missing';
        const last = Number.isFinite(Date.parse(receipt)) ? new Date(receipt).toLocaleString('en-US', { timeZone: zone }) + ' ET' : 'none recorded';
        const message = 'School Tracker has not received ' + kid.name + "'s " + slot.label + ' Eastern grade upload. Last received: ' + last + '. Check the scheduled run on the Mac for the cause.';
        for (const [name, deliver] of Object.entries(channels)) {
          if (sent[name]) continue;
          try {
            await deliver(title, message);
            sent[name] = true;
            save(key, sent);
          } catch (err) {
            console.error('Missed grade notification failed:', kid.id, name, err.code || err.name);
          }
        }
      }
    } finally { running = false; }
  };
}
