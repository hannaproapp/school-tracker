import { scorecardGrades } from './dashboard.js';
// Weekly scorecard: grade per class now vs. ~a week ago, and the graded work that moved it.
import { config } from './config.js';
import { load, save } from './store.js';
import { email } from './notify.js';
import { toLetter, schoolRound } from './grades.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = d => new Date(d).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
const base = n => String(n || '').replace(/\s*-\s*[A-Z]\s*\([A-Z]\)\s*$/, '').replace(/\s*-\s*\d+$/, '').trim();

// Called after every grade update: keep one snapshot per day (latest wins), ~90 days.
export function recordSnapshot(kidId, grades) {
  const hist = load(`hist-${kidId}`, []);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const snap = {
    day: today,
    at: new Date().toISOString(),
    grades: (grades || []).map(g => ({
      course: g.course, grade: g.grade, letter: g.letter, source: g.source || null,
      assignments: (g.assignments || []).map(a => ({ id: a.id, title: a.title, pct: a.pct, points: a.points, max: a.max, type: a.type })),
    })),
  };
  const i = hist.findIndex(h => h.day === today);
  if (i >= 0) hist[i] = snap; else hist.push(snap);
  save(`hist-${kidId}`, hist.slice(-90));
}

function baseline(hist) {
  const target = Date.now() - 7 * 86400000;
  // latest snapshot at or before a week ago; else the oldest we have
  const older = hist.filter(h => new Date(h.at).getTime() <= target + 12 * 3600000);
  return older.length ? older[older.length - 1] : hist[0];
}

export function buildScorecard(kid, state) {
  const hist = load(`hist-${kid.id}`, []);
  const then = baseline(hist) || { grades: [], at: null };
  const publishedReport = kid.id === 'luke' ? load('report-card-luke', null) : null;
  const reviewedScores = kid.id === 'luke' ? load('reviewed-scores-luke', null) : null;
  const now = publishedReport || reviewedScores
    ? scorecardGrades({ ...kid, data: state, publishedReport, reviewedScores })
    : state?.grades || [];
  const T = config.aThreshold;
  const since = then.at ? new Date(then.at).getTime() : Date.now() - 7 * 86400000;

  const rows = now.map(g => {
    const prev = then.grades.find(p => p.course === g.course) || {};
    const delta = g.grade != null && prev.grade != null ? Math.round((g.grade - prev.grade) * 100) / 100 : null;
    const prevIds = new Map((prev.assignments || []).map(a => [String(a.id ?? a.title), a]));
    const drivers = (g.assignments || []).filter(a => a.pct != null).flatMap(a => {
      const p = prevIds.get(String(a.id ?? a.title));
      if (!p) return [{ ...a, kind: 'new grade' }];
      if (p.pct !== a.pct) return [{ ...a, kind: `changed from ${p.pct}%` }];
      return [];
    });
    return { ...g, prevGrade: prev.grade ?? null, prevLetter: prev.letter ?? null, delta, drivers };
  });

  // Classroom work graded this week (covers classes graded only in Classroom)
  const crGraded = (state?.homework || []).filter(i => i.pct != null && i.updated && new Date(i.updated).getTime() >= since);
  const missing = (state?.homework || []).filter(i => i.status === 'missing' && !/CLASS OF|Wheels|Advisory/i.test(i.course));
  const weekTurnedIn = (state?.homework || []).filter(i => ['submitted', 'late'].includes(i.status) && i.updated && new Date(i.updated).getTime() >= since);

  const dash = `${config.baseUrl}/kid/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}`;
  const arrow = d => d == null ? '<span style="color:#888">–</span>' : d > 0 ? `<span style="color:#1f7a4d">▲ ${d.toFixed(2)}</span>` : d < 0 ? `<span style="color:#c0292b">▼ ${Math.abs(d).toFixed(2)}</span>` : '<span style="color:#888">no change</span>';
  const color = p => p == null ? '#333' : schoolRound(p) >= T ? '#1f7a4d' : schoolRound(p) >= 80 ? '#b26a00' : '#c0292b';

  const table = `<table cellpadding="6" style="border-collapse:collapse;font:14px -apple-system,Segoe UI,sans-serif;width:100%">
<tr style="background:#f3f2ef;text-align:left"><th>Class</th><th>Now</th><th>Last week</th><th>Change</th>${publishedReport ? `<th>${esc(publishedReport.term)} report card</th>` : ''}</tr>
${rows.map(r => `<tr style="border-top:1px solid #e6e4df">
<td><b>${esc(base(r.course))}</b>${r.source ? `<br><span style="color:#888;font-size:12px">${esc(r.source)}</span>` : ''}</td>
<td style="color:${color(r.grade)};font-weight:700">${r.grade != null ? `${r.grade}% → ${schoolRound(r.grade)} (${esc(toLetter(r.grade))})` : esc(r.letter || '—')}</td>
<td>${r.prevGrade != null ? `${r.prevGrade}% (${esc(toLetter(r.prevGrade))})` : esc(r.prevLetter || '—')}</td>
<td>${arrow(r.delta)}</td>${publishedReport ? `<td>${esc(r.reportLetter || '—')}</td>` : ''}</tr>
${r.average ? `<tr><td colspan="5">Classroom average checked ${esc(day(r.average.at))}</td></tr>` : ''}
${r.reviewedRows?.length ? `<tr><td colspan="5"><b>Assignment scores</b> · checked ${esc(state?.classroomAt ? day(state.classroomAt) : reviewedScores?.checked)}<ul>${r.reviewedRows.map(a => `<li>${esc(a.title)}${a.term ? ' (' + esc(a.term) + ')' : ''} — ${esc(a.earned)}/${esc(a.possible)}</li>`).join('')}</ul></td></tr>` : ''}
${r.drivers.length ? `<tr><td colspan="4" style="padding:0 6px 8px 18px;color:#444;font-size:13px">What moved it: ${r.drivers.map(a => `${esc(a.title)} <b style="color:${color(a.pct)}">${a.pct}%</b>${a.kind !== 'new grade' ? ` (${esc(a.kind)})` : ''}`).join('; ')}</td></tr>` : ''}`).join('')}
</table>`;

  const html = `<div style="font:15px -apple-system,Segoe UI,sans-serif;color:#1d1d1f;max-width:720px">
<h2 style="margin:0 0 4px">${esc(kid.name)}'s weekly scorecard</h2>
<p style="color:#666;margin:0 0 16px">Week ending ${day(new Date())} · compared with ${then.at ? day(then.at) : 'first week of tracking'} · grades round to the nearest whole percent</p>
${table}
${crGraded.length ? `<h3>Graded in Google Classroom this week</h3><ul>${crGraded.map(i => `<li>${esc(i.course)}: ${esc(i.title)} <b style="color:${color(i.pct)}">${i.pct}%</b></li>`).join('')}</ul>` : ''}
<h3>Homework</h3>
${kid.classroomOnly && !state?.classroomAt ? '<p>Live homework totals are unavailable.</p>' : `<p>Turned in this week: <b>${weekTurnedIn.length}</b> · Still missing: <b style="color:${missing.length ? '#c0292b' : '#1f7a4d'}">${missing.length}</b></p>`}
${missing.length ? `<ul>${missing.slice(0, 40).map(i => `<li>${esc(i.course)}: <a href="${esc(i.link)}">${esc(i.title)}</a> (due ${day(i.due)})</li>`).join('')}</ul>` : ''}
<p><a href="${dash}" style="background:#1d1d1f;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open ${esc(kid.name)}'s full dashboard</a></p>
</div>`;
  return { html, subject: `${kid.name}'s weekly scorecard – ${day(new Date())}` };
}

export async function sendScorecards(onlyKid, note, subjectPrefix) {
  for (const kid of config.kids) {
    if (onlyKid && kid.id !== onlyKid) continue;
    const state = load(`state-${kid.id}`, null);
    if (!state) continue;
    let { html, subject } = buildScorecard(kid, state);
    if (note) html = `<div style="font:15px -apple-system,Segoe UI,sans-serif;background:#fff6e5;border:1px solid #f0d9a8;border-radius:8px;padding:12px 14px;margin-bottom:18px;max-width:720px">${note}</div>` + html;
    if (subjectPrefix) subject = `${subjectPrefix} ${subject}`;
    const to = [...new Set([...(kid.scorecardEmails || []), ...(config.scorecardParents || [])])];
    await email(to, subject, html);
  }
}
