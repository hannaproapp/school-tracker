import { config, kidAlertEmails } from './config.js';
import { load, save } from './store.js';
import { fetchClassroom, isConnected } from './classroom.js';
import { toLetter, schoolRound } from './grades.js';
import { fetchBlackbaud, hasCreds } from './blackbaud.js';
import { recordSnapshot } from './scorecard.js';
import { fetchAssignmentFeed, feedUrl, mergeHomework } from './ical.js';
import { email, push } from './notify.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const etHour = () => process.env.FORCE_ET_HOUR ? Number(process.env.FORCE_ET_HOUR) : Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));
const etWeekday = () => new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const dayKey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const dayLabel = d => new Date(d).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });

function doOnDate(due) {
  const d = new Date(due);
  d.setDate(d.getDate() - 1);
  if (d < new Date()) return new Date();
  return d;
}

export function buildPlan(items) {
  const now = new Date();
  const horizon = new Date(now.getTime() + config.planDays * 86400000);
  const upcoming = items.filter(i => i.due && new Date(i.due) <= horizon && (i.status === 'todo' || new Date(i.due) >= now));
  const byDay = {};
  for (const i of upcoming) {
    if (i.status !== 'todo') continue;
    const k = dayKey(doOnDate(i.due));
    (byDay[k] ||= []).push(i);
  }
  return Object.keys(byDay).sort().map(k => ({
    day: k,
    label: dayLabel(k + 'T12:00:00-05:00'),
    items: byDay[k].sort((a, b) => new Date(a.due) - new Date(b.due)),
  }));
}

async function runKid(kid, state, alertsSent) {
  const prev = state[kid.id] || {};
  const out = { ...prev, name: kid.name, gradeLevel: kid.grade, lastRun: new Date().toISOString(), errors: [] };

  if (isConnected(kid.id)) {
    try {
      const cr = await fetchClassroom(kid.id);
      out.homework = cr.items;
      out.classroomAt = new Date().toISOString();
    } catch (e) { out.errors.push(`Google Classroom: ${e.message}`); }
  } else out.errors.push('Google Classroom not connected yet');

  // Blackbaud assignment calendar feed: adds assignments that aren't in Classroom.
  if (feedUrl(kid)) {
    try {
      out.bbAssignments = await fetchAssignmentFeed(kid);
      out.bbAssignmentsAt = new Date().toISOString();
    } catch (e) { out.errors.push(`Blackbaud assignment feed: ${e.message}`); }
  }
  const classroomHw = (out.homework || []).filter(i => i.source !== 'blackbaud');
  if (classroomHw.length || out.bbAssignments?.length) out.homework = mergeHomework(classroomHw, out.bbAssignments);

  let bbError = null;
  if (hasCreds(kid)) {
    try { await fetchBlackbaud(kid); }
    catch (e) { bbError = e.message; console.error(`blackbaud ${kid.id}:`, e.message); }
  }
  const bb = load(`bb-${kid.id}`, null);
  if (bbError) out.errors.push(`Blackbaud login: ${bbError}`);
  if (bb) {
    out.grades = bb.courses.map(c => ({ ...c, letter: c.grade != null ? toLetter(c.grade) : c.letter }));
    out.schoolYear = bb.year;
    out.gradesAt = bb.at;
    if (Date.now() - new Date(bb.at) > config.gradeStaleHours * 3600000) out.errors.push(`Blackbaud: grades not refreshed since ${new Date(bb.at).toLocaleString('en-US', { timeZone: 'America/New_York' })}. Grades sync when ${kid.name} opens Blackbaud in Chrome with the School Tracker sync script installed.`);
  } else out.errors.push(`Blackbaud: no grades received yet. Install the sync script (see /setup), then have ${kid.name} open Blackbaud in Chrome.`);

  // Latest Blackbaud report-card letters (kids.json reportCards). Used as the grade for
  // classes with no running Blackbaud gradebook (e.g. Chinese).
  const terms = Object.keys(kid.reportCards || {});
  const lastTerm = terms[terms.length - 1];
  const rc = lastTerm ? kid.reportCards[lastTerm] : {};
  const base = n => String(n || '').replace(/\s*-\s*[A-Z]\s*\([A-Z]\)\s*$/, '').replace(/\s*-\s*\d+$/, '').trim().toLowerCase();
  out.reportTerm = lastTerm || null;
  const excluded = (kid.excludeClasses || []).map(x => x.toLowerCase());
  const isExcluded = n => excluded.some(x => String(n || '').toLowerCase().startsWith(x));
  out.grades = (out.grades || []).filter(g => !isExcluded(g.course));
  if (out.homework) out.homework = out.homework.filter(i => !isExcluded(i.course));
  out.grades = (out.grades || []).map(g => {
    const letter = Object.entries(rc).find(([c]) => c.toLowerCase() === base(g.course))?.[1] || null;
    const manual = Object.entries(kid.manualGrades || {}).find(([c]) => c.toLowerCase() === base(g.course))?.[1];
    if (g.grade == null && manual) return { ...g, reportLetter: letter, grade: manual.grade, letter: toLetter(manual.grade), source: manual.note || 'entered manually' };
    return { ...g, reportLetter: letter, ...(g.grade == null && letter ? { letter, source: `${lastTerm} report card` } : {}) };
  });

  if (out.grades?.length) recordSnapshot(kid.id, out.grades);

  out.plan = buildPlan(out.homework || []);
  out.missing = (out.homework || []).filter(i => i.status === 'missing');

  // ---- alerts ----
  const T = config.aThreshold;
  const alerts = [];
  for (const c of out.grades || []) {
    if (c.grade == null && c.reportLetter && !/^A\+?$/.test(c.reportLetter)) {
      const key = `${kid.id}|rc|${out.reportTerm}|${c.course}|${c.reportLetter}`;
      if (!alertsSent[key]) alerts.push({ key, text: `${c.course}: ${c.reportLetter} on ${out.reportTerm} report card (no running grade in Blackbaud)` });
    }
    if (c.grade != null && schoolRound(c.grade) < T) {
      const key = `${kid.id}|course|${c.course}|${schoolRound(c.grade)}`;
      if (!alertsSent[key]) alerts.push({ key, text: `${c.course}: overall ${c.grade}% → ${schoolRound(c.grade)} (${toLetter(c.grade)})` });
    }
    for (const a of c.assignments || []) {
      if (a.pct != null && schoolRound(a.pct) < T) {
        const key = `${kid.id}|bbassign|${c.course}|${a.id || a.title}`;
        if (!alertsSent[key]) alerts.push({ key, text: `${c.course} – ${a.title}: ${a.pct}%` });
      }
    }
  }
  for (const i of out.homework || []) {
    if (i.pct != null && schoolRound(i.pct) < T) {
      const key = `${kid.id}|crgrade|${i.id}`;
      if (!alertsSent[key]) alerts.push({ key, text: `${i.course} – ${i.title}: ${i.pct}% (Classroom)` });
    }
    if (i.status === 'missing') {
      const key = `${kid.id}|missing|${i.id}`;
      if (!alertsSent[key]) alerts.push({ key, text: `MISSING: ${i.course} – ${i.title} (was due ${dayLabel(i.due)})` });
    }
  }
  const stale = out.errors.find(e => e.includes('not refreshed'));
  if (stale && !prev.errors?.some(e => e.includes('not refreshed'))) {
    alerts.push({ key: `${kid.id}|err|${Date.now()}`, text: stale });
  }

  if (alerts.length) {
    const dash = `${config.baseUrl}/kid/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}`;
    const html = `<p><b>${esc(kid.name)}</b> – below an A / missing work:</p><ul>${alerts.map(a => `<li>${esc(a.text)}</li>`).join('')}</ul><p><a href="${dash}">Open dashboard</a></p>`;
    await email(kidAlertEmails(kid), `⚠️ ${kid.name}: ${alerts.length} grade/homework alert${alerts.length > 1 ? 's' : ''}`, html);
    await push(`${kid.name}: ${alerts.length} alert${alerts.length > 1 ? 's' : ''}`, alerts.map(a => a.text).join('\n').slice(0, 3500), dash);
    for (const a of alerts) alertsSent[a.key] = new Date().toISOString();
  }
  out.recentAlerts = [...alerts.map(a => ({ at: new Date().toISOString(), text: a.text })), ...(prev.recentAlerts || [])].slice(0, 50);

  // ---- new assignments posted in Classroom since the last check ----
  if (out.homework?.length) {
    let seen = load(`seen-${kid.id}`, null);
    const ids = out.homework.map(i => i.id);
    // First time the Blackbaud feed is connected: treat its existing assignments as already seen.
    const bbIds = out.homework.filter(i => i.source === 'blackbaud').map(i => i.id);
    if (seen && bbIds.length && !load(`ical-seeded-${kid.id}`, false)) {
      seen = [...seen, ...bbIds];
      save(`ical-seeded-${kid.id}`, true);
    }
    if (seen) {
      const known = new Set(seen);
      const fresh = out.homework.filter(i => !known.has(i.id) && i.status === 'todo' && i.due && !/CLASS OF|Wheels|Advisory/i.test(i.course))
        .sort((a, b) => new Date(a.due) - new Date(b.due));
      if (fresh.length) {
        const dash = `${config.baseUrl}/kid/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}`;
        const html = `<p><b>New assignment${fresh.length > 1 ? 's' : ''} posted for ${esc(kid.name)}:</b></p><ul>${fresh.map(i => `<li><b>${esc(i.course)}</b>: <a href="${esc(i.link)}">${esc(i.title)}</a>, due <b>${esc(dayLabel(i.due))}</b> <i>(${i.source === 'blackbaud' ? 'Blackbaud' : 'Google Classroom'})</i></li>`).join('')}</ul><p>If you already worked ahead this week, add ${fresh.length > 1 ? 'these' : 'this'} to your plan.</p><p><a href="${dash}">Dashboard</a></p>`;
        await email(kidAlertEmails(kid), `🆕 ${kid.name}: ${fresh.length} new assignment${fresh.length > 1 ? 's' : ''} posted`, html);
        await push(`${kid.name}: ${fresh.length} new assignment${fresh.length > 1 ? 's' : ''}`, fresh.map(i => `${i.course}: ${i.title} (due ${dayLabel(i.due)})`).join('\n').slice(0, 3500), dash);
        out.recentAlerts = [{ at: new Date().toISOString(), text: `New: ${fresh.map(i => `${i.course} – ${i.title} (due ${dayLabel(i.due)})`).join('; ')}` }, ...(out.recentAlerts || [])].slice(0, 50);
      }
    }
    save(`seen-${kid.id}`, [...new Set([...(seen || []), ...ids])]);
  }

  // A newly enrolled Classroom-only student has no homework data until the first import.
  if (kid.classroomOnly && !out.classroomAt) return out;

  // ---- morning plan email (first run of the day) ----
  const today = dayKey(new Date());
  const luke = kid.id === 'luke';
  const saturday = luke && etWeekday() === 'Sat';
  const homework = out.homework || [];
  const sorted = items => items.slice().sort((a, b) => new Date(a.due) - new Date(b.due));
  const listWork = items => '<ul>' + sorted(items).map(i => '<li>' + esc(dayLabel(i.due)) + ' · ' + esc(i.course) + ': <a href="' + esc(i.link) + '">' + esc(i.title) + '</a> (' + esc(i.noTurnIn ? 'check completion' : i.status === 'todo' ? 'not turned in' : i.status) + ')</li>').join('') + '</ul>';
  // Use Eastern calendar dates across daylight-saving changes.
  const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const freshHomework = !out.errors.some(e => e.startsWith('Google Classroom:') || e.includes('not connected'));
  if (saturday && freshHomework && out.weekPlan?.sent !== today) {
    const end = addDays(today, 7);
    const week = homework.filter(i => i.due && dayKey(i.due) >= today && dayKey(i.due) <= end);
    const html = '<h3>Luke’s week-ahead homework plan</h3><p>Work due today through ' + esc(dayLabel(end + 'T12:00:00Z')) + ', including work already turned in.</p>' +
      (week.length ? listWork(week) : '<p>No dated assignments listed for this period.</p>') +
      (out.missing.length ? '<h4>Earlier missing work</h4>' + listWork(out.missing.filter(i => i.due && dayKey(i.due) < today)) : '');
    await email(kidAlertEmails(kid), 'Luke’s Saturday homework plan – ' + dayLabel(new Date()), html);
    out.weekPlan = { sent: today, end, seen: week.map(i => i.id) };
    out.lastDigest = today;
  }
  if (!saturday && out.lastDigest !== today && etHour() < 11) {
    const plan = out.plan.slice(0, 7);
    const html = `<h3>${esc(kid.name)} – homework plan</h3>` +
      plan.map(d => `<p><b>${esc(d.label)}</b></p><ul>${d.items.map(i => `<li>${esc(i.course)}: ${esc(i.title)} <i>(due ${esc(dayLabel(i.due))})</i></li>`).join('')}</ul>`).join('') +
      (out.missing.length ? `<p style="color:#b00"><b>Missing:</b> ${out.missing.map(i => esc(`${i.course} – ${i.title}`)).join('; ')}</p>` : '') +
      `<p><a href="${config.baseUrl}/kid/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}">Full dashboard</a></p>`;
    await email(kidAlertEmails(kid), `${kid.name}'s homework plan – ${dayLabel(new Date())}`, html);
    out.lastDigest = today;
  }

  // ---- what's due next school day: 4pm email, 8pm not-turned-in alert ----
  const ahead = { Fri: 3, Sat: 2 }[etWeekday()] || 1; // Fri/Sat look through Monday
  const nextDays = Array.from({ length: ahead }, (_, n) => dayKey(Date.now() + (n + 1) * 86400000));
  const dueNext = (out.homework || []).filter(i => i.due && nextDays.includes(dayKey(i.due)))
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const dash = `${config.baseUrl}/kid/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}`;
  const label = ahead > 1 ? `through ${dayLabel(nextDays[nextDays.length - 1] + 'T12:00:00-05:00')}` : `tomorrow (${dayLabel(nextDays[0] + 'T12:00:00-05:00')})`;
  const row = i => i.noTurnIn
    ? `<li>• <b>${esc(i.course)}</b>: <a href="${esc(i.link)}">${esc(i.title)}</a> <i>(Blackbaud – check it's done)</i></li>`
    : `<li>${i.status === 'todo' ? '☐' : '☑'} <b>${esc(i.course)}</b>: <a href="${esc(i.link)}">${esc(i.title)}</a> <i>(${esc(i.status === 'todo' ? 'not turned in' : i.status)})</i></li>`;

  if ((!luke || freshHomework) && etHour() >= 16 && out.lastTomorrowEmail !== today) {
    const baseline = luke && out.weekPlan;
    const additions = baseline && today <= baseline.end ? homework.filter(i => i.due && dayKey(i.due) >= baseline.sent && dayKey(i.due) <= baseline.end && !baseline.seen.includes(i.id)) : [];
    const weekUpdate = baseline && today <= baseline.end ? (additions.length ? '<h3>Added to this week since your last email</h3>' + listWork(additions) : '<p>No new assignments added to your Saturday plan since the last check.</p>') : '';
    const html = weekUpdate + `<h3>${esc(kid.name)} – homework due ${esc(label)}</h3>` +
      (dueNext.length ? `<ul>${dueNext.map(row).join('')}</ul>` : '<p>Nothing due in Google Classroom or Blackbaud.</p>') +
      `<p>Anything not turned in to Google Classroom by 8pm will trigger an alert.</p><p><a href="${dash}">Dashboard</a></p>`;
    await email(kidAlertEmails(kid), `${kid.name}: ${dueNext.length} due ${label}`, html);
    if (additions.length) baseline.seen.push(...additions.map(i => i.id));
    out.lastTomorrowEmail = today;
  }

  if (etHour() >= 20 && out.lastEveningCheck !== today) {
    const open = dueNext.filter(i => i.status === 'todo' && !i.noTurnIn);
    if (open.length) {
      const html = `<p><b>${esc(kid.name)}</b> has ${open.length} assignment${open.length > 1 ? 's' : ''} due ${esc(label)} not turned in as of 8pm:</p><ul>${open.map(row).join('')}</ul><p><a href="${dash}">Dashboard</a></p>`;
      await email(kidAlertEmails(kid), `⚠️ ${kid.name}: ${open.length} not turned in, due ${label}`, html);
      await push(`${kid.name}: ${open.length} not turned in`, open.map(i => `${i.course}: ${i.title}`).join('\n').slice(0, 3500), dash);
      out.recentAlerts = [{ at: new Date().toISOString(), text: `8pm check: ${open.length} not turned in, due ${label}` }, ...(out.recentAlerts || [])].slice(0, 50);
    }
    out.lastEveningCheck = today;
  }
  return out;
}

const running = new Set();
export async function runKidById(kidId) {
  const kid = config.kids.find(k => k.id === kidId);
  if (!kid || running.has(kid.id)) return;
  running.add(kid.id);
  try {
    const prev = load(`state-${kid.id}`, {});
    const alertsSent = load(`alerts-${kid.id}`, {});
    const out = await runKid(kid, { [kid.id]: prev }, alertsSent);
    save(`state-${kid.id}`, out);
    save(`alerts-${kid.id}`, alertsSent);
  } catch (e) { console.error(kid.id, e); }
  finally { running.delete(kid.id); }
}

export async function runAll() {
  for (const kid of config.kids) await runKidById(kid.id);
}

export const kidState = kidId => load(`state-${kidId}`, null);
