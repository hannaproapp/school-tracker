import { config, kidAlertEmails } from './config.js';
import { load, save } from './store.js';
import { fetchClassroom, isConnected } from './classroom.js';
import { toLetter, schoolRound } from './grades.js';
import { email, push } from './notify.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

  const bb = load(`bb-${kid.id}`, null);
  if (bb) {
    out.grades = bb.courses.map(c => ({ ...c, letter: c.grade != null ? toLetter(c.grade) : c.letter }));
    out.schoolYear = bb.year;
    out.gradesAt = bb.at;
    if (Date.now() - new Date(bb.at) > 36 * 3600000) out.errors.push(`Blackbaud: grades not refreshed since ${new Date(bb.at).toLocaleString('en-US', { timeZone: 'America/New_York' })}. Check that ${kid.name} is still signed into Blackbaud in Chrome.`);
  } else out.errors.push(`Blackbaud: no grades received yet (daily Chrome check)`);

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

  // ---- morning plan email (first run of the day) ----
  const today = dayKey(new Date());
  if (out.lastDigest !== today && new Date().getHours() < 11) {
    const plan = out.plan.slice(0, 7);
    const html = `<h3>${esc(kid.name)} – homework plan</h3>` +
      plan.map(d => `<p><b>${esc(d.label)}</b></p><ul>${d.items.map(i => `<li>${esc(i.course)}: ${esc(i.title)} <i>(due ${esc(dayLabel(i.due))})</i></li>`).join('')}</ul>`).join('') +
      (out.missing.length ? `<p style="color:#b00"><b>Missing:</b> ${out.missing.map(i => esc(`${i.course} – ${i.title}`)).join('; ')}</p>` : '') +
      `<p><a href="${config.baseUrl}/kid/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}">Full dashboard</a></p>`;
    await email(kidAlertEmails(kid), `${kid.name}'s homework plan – ${dayLabel(new Date())}`, html);
    out.lastDigest = today;
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
