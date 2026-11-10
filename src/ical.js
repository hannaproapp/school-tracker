// Blackbaud assignment calendar feed (iCal). The feed link carries its own token, so the
// server reads it directly: no sign-in, no browser. Gives assignments and due dates only
// (not grades or turned-in status).
import { kidBlackbaudBase } from './config.js';
import { load, save } from './store.js';

export const feedUrl = kid => process.env[`${kid.id.toUpperCase()}_BB_ICAL`] || load(`ical-${kid.id}`, null)?.url || null;

export function setFeedUrl(kid, url) {
  save(`ical-${kid.id}`, { url: normalizeUrl(url), at: new Date().toISOString() });
}

export function normalizeUrl(url) {
  const u = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  const parsed = new URL(u); // throws on junk
  if (parsed.protocol !== 'https:') throw new Error('Feed link must start with https:// or webcal://');
  return parsed.toString();
}

const unescapeText = s => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const stripHtml = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// Minimal RFC 5545 reader: unfolds lines and returns VEVENTs as { NAME: { value, params } }.
export function parseIcs(text) {
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    cur[name.toUpperCase()] = { value: line.slice(i + 1), params: params.join(';') };
  }
  return events;
}

// ET wall-clock time -> ISO, with the right EST/EDT offset for that date.
function etIso(date, time) {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(noonUtc).find(p => p.type === 'timeZoneName').value.match(/GMT([+-]\d+)/)?.[1] || '-5';
  const sign = off.startsWith('-') ? '-' : '+';
  return new Date(`${date}T${time}${sign}${String(Math.abs(Number(off))).padStart(2, '0')}:00`).toISOString();
}

// Due time: all-day dates count as due by the end of that day (ET).
export function icsDate(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || /VALUE=DATE(?!-)/i.test(prop.params)) {
    m ||= v.match(/^(\d{4})(\d{2})(\d{2})/);
    return etIso(`${m[1]}-${m[2]}-${m[3]}`, '23:59:00');
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  if (m[7]) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString();
  return etIso(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}:${m[6]}`); // floating/TZID times are school-local (ET)
}

// Blackbaud summaries look like "Course - Section (Block): Assignment"; fall back gracefully.
export function splitSummary(summary, fallbackCourse) {
  const s = stripHtml(unescapeText(summary));
  const i = s.indexOf(': ');
  if (i > 0 && i < 80) return { course: s.slice(0, i).trim(), title: s.slice(i + 2).trim() };
  return { course: fallbackCourse || 'Blackbaud', title: s };
}

export function feedItems(kid, text, now = Date.now()) {
  const base = kidBlackbaudBase(kid);
  return parseIcs(text).map(ev => {
    const due = icsDate(ev.DTSTART) || icsDate(ev.DUE);
    if (!due) return null;
    const { course, title } = splitSummary(ev.SUMMARY?.value || '', stripHtml(unescapeText(ev.CATEGORIES?.value || '')));
    const uid = ev.UID?.value || `${course}|${title}|${due}`;
    return {
      source: 'blackbaud',
      id: `bb-${uid}`,
      course,
      title,
      due,
      link: ev.URL?.value || `${base}/app/student#studentmyday/assignment-center`,
      status: new Date(due) >= now ? 'todo' : 'past',
      noTurnIn: true, // the feed has no turned-in status; never alert "not turned in" from it
      notes: stripHtml(unescapeText(ev.DESCRIPTION?.value || '')).slice(0, 500) || null,
    };
  }).filter(Boolean)
    .filter(i => new Date(i.due) > now - 21 * 86400000 && new Date(i.due) < now + 45 * 86400000);
}

export async function fetchAssignmentFeed(kid) {
  const url = feedUrl(kid);
  if (!url) return null;
  const r = await fetch(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`feed returned ${r.status}`);
  const text = await r.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('link did not return a calendar (copy the Assignment Center feed link again)');
  return feedItems(kid, text);
}

// Drop feed items that are the same assignment as a Classroom item (same due day, similar title).
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const day = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export function mergeHomework(classroom, feed) {
  const cr = classroom || [];
  const extra = (feed || []).filter(b => !cr.some(c => c.due && day(c.due) === day(b.due) &&
    (norm(c.title) === norm(b.title) || (norm(b.title).length > 5 && (norm(c.title).includes(norm(b.title)) || norm(b.title).includes(norm(c.title)))))));
  return [...cr, ...extra];
}
