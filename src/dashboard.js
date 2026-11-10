const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = d => d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const fmtDay = d => d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }) : '—';

function gradeClass(raw, T) {
  if (raw == null) return 'na';
  const p = Math.round(raw);
  if (p >= T) return 'ok';
  if (p >= 80) return 'warn';
  return 'bad';
}

function kidSection(k, T) {
  const d = k.data || {};
  const hw = (d.homework || []).filter(i => i.due && new Date(i.due) > Date.now() - 14 * 86400000)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const counts = hw.reduce((m, i) => (m[i.status] = (m[i.status] || 0) + 1, m), {});
  const grades = d.grades || [];
  const belowA = grades.filter(g => g.grade != null && g.grade < T).length;

  return `<section id="${esc(k.id)}" class="kid">
  <div class="head"><h2>${esc(k.name)} <span class="sub">Grade ${esc(k.grade || '')}</span></h2>
    <div class="meta">Homework updated ${esc(fmt(d.classroomAt)) || 'never'} · Grades updated ${esc(fmt(d.gradesAt)) || 'never'}</div></div>
  ${!k.connected ? `<div class="banner">Google Classroom isn't connected. <a class="btn" href="/connect/${esc(k.id)}">Connect ${esc(k.name)}'s Google account</a></div>` : ''}
  ${(d.errors || []).filter(e => !e.includes('not connected')).map(e => `<div class="banner err">${esc(e)}</div>`).join('')}

  <div class="tiles">
    <div class="tile"><div class="n ${belowA ? 'badt' : 'okt'}">${belowA}</div><div>classes below an A</div></div>
    <div class="tile"><div class="n ${counts.missing ? 'badt' : 'okt'}">${counts.missing || 0}</div><div>missing</div></div>
    <div class="tile"><div class="n">${counts.todo || 0}</div><div>to do</div></div>
    <div class="tile"><div class="n">${(counts.submitted || 0) + (counts.late || 0)}</div><div>turned in (14 days)</div></div>
  </div>

  <h3>Grade scorecard</h3>
  <table><tr><th>Class</th><th>Teacher</th><th>Current grade</th><th>Letter</th><th>${esc(d.reportTerm || '')} report card</th></tr>
  ${grades.length ? grades.map(g => `<tr><td>${esc(g.course)}${g.source ? ` <span class="muted">(${esc(g.source)})</span>` : ''}</td><td>${esc(g.teacher)}</td>
    <td class="g ${gradeClass(g.grade, T)}">${g.grade != null ? esc(g.grade) + '% <span class="muted">→ ' + Math.round(g.grade) + '</span>' : '—'}</td><td class="g ${g.grade == null && g.letter ? (/^A\+?$/.test(g.letter) ? 'ok' : 'warn') : ''}">${esc(g.letter || '')}</td><td>${esc(g.reportLetter || '')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No grades pulled yet</td></tr>'}
  </table>

  <h3>Homework plan (next 2 weeks)</h3>
  <div class="plan">${(d.plan || []).length ? d.plan.map(day => `<div class="day"><div class="dl">${esc(day.label)}</div>
    ${day.items.map(i => `<div class="it"><a href="${esc(i.link)}" target="_blank">${esc(i.title)}</a><div class="muted">${esc(i.course)} · due ${esc(fmtDay(i.due))}</div></div>`).join('')}</div>`).join('')
    : '<p class="muted">Nothing scheduled</p>'}</div>

  <h3>Homework status</h3>
  <table><tr><th>Due</th><th>Class</th><th>Assignment</th><th>Status</th><th>Score</th></tr>
  ${hw.map(i => `<tr><td>${esc(fmtDay(i.due))}</td><td>${esc(i.course)}</td><td><a href="${esc(i.link)}" target="_blank">${esc(i.title)}</a></td>
    <td><span class="pill ${esc(i.status)}">${esc(i.status)}</span></td>
    <td class="g ${gradeClass(i.pct, T)}">${i.pct != null ? esc(i.pct) + '%' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No homework pulled yet</td></tr>'}
  </table>

  <h3>Recent alerts</h3>
  <ul class="alerts">${(d.recentAlerts || []).slice(0, 15).map(a => `<li><span class="muted">${esc(fmt(a.at))}</span> ${esc(a.text)}</li>`).join('') || '<li class="muted">None</li>'}</ul>
  </section>`;
}

export function dashboardHtml(kids, T, only) {
  const shown = only ? kids.filter(k => k.id === only) : kids;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>School Tracker</title><style>
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1f;--mut:#6b6b70;--ok:#1f7a4d;--warn:#b26a00;--bad:#c0292b;--line:#e6e4df}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;gap:12px;align-items:center;padding:16px 24px;background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0}
header h1{font-size:18px;margin:0 16px 0 0}nav a.on{background:#1d1d1f;color:#fff}nav a{padding:6px 12px;border-radius:20px;text-decoration:none;color:var(--ink);background:#eeece8;margin-right:6px}
form{margin-left:auto}button,.btn{background:#1d1d1f;color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer;text-decoration:none}
main{max-width:1100px;margin:0 auto;padding:24px}.kid{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:28px}
h2{margin:0}.sub{font-weight:400;color:var(--mut);font-size:15px}.meta,.muted{color:var(--mut);font-size:13px}h3{margin:28px 0 10px}
.banner{background:#fff6e5;border:1px solid #f0d9a8;padding:12px;border-radius:10px;margin-top:14px}.banner.err{background:#fdecec;border-color:#f3c2c2}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}.tile{border:1px solid var(--line);border-radius:12px;padding:14px}
.n{font-size:28px;font-weight:700}.okt{color:var(--ok)}.badt{color:var(--bad)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line)}th{font-size:12px;text-transform:uppercase;color:var(--mut)}
.g{font-weight:700}.g.ok{color:var(--ok)}.g.warn{color:var(--warn)}.g.bad{color:var(--bad)}
.pill{padding:2px 8px;border-radius:10px;font-size:12px;background:#eee}.pill.missing{background:#fdecec;color:var(--bad)}.pill.late{background:#fff3e0;color:var(--warn)}
.pill.submitted{background:#e8f5ee;color:var(--ok)}.pill.todo{background:#eef2fb;color:#2c4a8a}
.plan{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.day{border:1px solid var(--line);border-radius:10px;padding:10px}
.dl{font-weight:700;margin-bottom:6px}.it{margin-bottom:8px}.it a{color:var(--ink)}.alerts{padding-left:18px}
@media(max-width:700px){.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><h1>School Tracker</h1><nav><a href="/" class="${only ? '' : 'on'}">All</a>${kids.map(k => `<a href="/kid/${esc(k.id)}" class="${only === k.id ? 'on' : ''}">${esc(k.name)}</a>`).join('')}</nav>
<form method="post" action="${only ? `/run/${esc(only)}` : '/run'}"><button>Refresh ${only ? esc(shown[0]?.name || '') : 'all'} now</button></form></header>
<main>${shown.map(k => kidSection(k, T)).join('') || '<p>No kids configured. Add them to kids.json.</p>'}
<p class="muted">Grades round to the nearest whole percent (.5 rounds up). Alerts fire for anything that rounds below ${T}% and for missing work.</p></main></body></html>`;
}
