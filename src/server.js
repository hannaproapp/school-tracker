import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { authUrl, handleCallback, isConnected } from './classroom.js';
import { runAll, runKidById, kidState } from './run.js';
import { buildScorecard, sendScorecards } from './scorecard.js';
import { save, load } from './store.js';
import { normalizeBlackbaud } from './grades.js';
import { dashboardHtml } from './dashboard.js';
import { ingestKey, userscript } from './userscript.js';
import { feedUrl, setFeedUrl, fetchAssignmentFeed } from './ical.js';

const app = express();
app.set('trust proxy', true);
const trackerBase = req => config.baseUrl || `${req.protocol}://${req.get('host')}`;

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui;max-width:720px;margin:40px auto;padding:0 20px"><h1>${title}</h1>${body}</body>`;

function authed(req, res, next) {
  if (!config.dashboardKey) return res.status(500).send('Set DASHBOARD_KEY first.');
  const key = req.query.key || (req.headers.cookie || '').match(/dk=([^;]+)/)?.[1];
  if (decodeURIComponent(key || '') !== config.dashboardKey) return res.status(401).send(page('Link expired', '<p>Open the dashboard with the full link that ends in <code>?key=...</code>. After that this browser stays signed in.</p>'));
  if (req.query.key) res.setHeader('Set-Cookie', `dk=${encodeURIComponent(config.dashboardKey)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  next();
}

// Grades pushed by the School Tracker userscript running in the student's signed-in Blackbaud tab
// (or by collector.js run by hand). Accepts the ingest key or the dashboard key.
app.options('/ingest/:kid', (_req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }).sendStatus(204);
});
app.post('/ingest/:kid', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (!config.dashboardKey || ![config.dashboardKey, ingestKey()].includes(req.query.key)) return res.status(401).send('bad key');
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('unknown kid');
  let raw;
  try { raw = JSON.parse(req.body); } catch { return res.status(400).send('bad json'); }
  const courses = normalizeBlackbaud(raw);
  save(`bb-${kid.id}`, { at: new Date().toISOString(), year: raw.year, courses });
  save(`bb-raw-${kid.id}`, raw);
  runKidById(kid.id).catch(console.error);
  res.send(`ok ${courses.length} classes`);
});

app.get('/health', (_req, res) => res.send('ok'));

// Userscript install link. The path carries the ingest key (not the dashboard key), so it can be
// opened in the kids' Chrome; Tampermonkey offers to install any URL ending in .user.js.
app.get('/sync/:key/school-tracker.user.js', (req, res) => {
  if (!config.dashboardKey || req.params.key !== ingestKey()) return res.status(404).send('not found');
  res.type('text/javascript').send(userscript(trackerBase(req)));
});

// Setup page: userscript install steps and each kid's Blackbaud assignment feed.
const setupPage = (req, msg = '') => {
  const install = `${trackerBase(req)}/sync/${ingestKey()}/school-tracker.user.js`;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = d => d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  return page('School Tracker setup', `${msg ? `<p style="background:#eef7ee;padding:10px;border-radius:8px">${esc(msg)}</p>` : ''}
  <h2>1. Grades: sync script (once per kid's Chrome)</h2>
  <ol>
    <li>In the Chrome where the kid is signed into Blackbaud, install the <a href="https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo" target="_blank">Tampermonkey</a> extension. In Chrome's Extensions page, turn on <b>Developer mode</b> (or <b>Allow User Scripts</b> on Tampermonkey's details page) so it can run scripts.</li>
    <li>Open this link in that same Chrome and click <b>Install</b>:<br><input readonly value="${esc(install)}" style="width:100%;font:13px monospace;padding:6px" onclick="this.select()"></li>
    <li>Have the kid open Blackbaud. A small "Grades synced to School Tracker" note appears in the corner within a few seconds. After that it syncs automatically (at most every 3 hours) whenever Blackbaud is open.</li>
  </ol>
  <p>Last grades received: ${config.kids.map(k => `${esc(k.name)} ${esc(when(load(`bb-${k.id}`, null)?.at))}`).join(' · ')}</p>
  <h2>2. Homework: Blackbaud assignment feed</h2>
  <p>Signed in as the kid, open Blackbaud's <b>Assignment Center</b>, click the calendar-feed (subscribe / iCal) icon, copy the link, and paste it here. The tracker reads it directly, three times a day. It adds Blackbaud assignments and due dates to the plan (not grades or turned-in status).</p>
  ${config.kids.map(k => `<form method="post" action="/kid/${esc(k.id)}/ical" style="margin:12px 0">
    <b>${esc(k.name)}</b> ${feedUrl(k) ? '<span style="color:#1f7a4d">connected</span>' : '<span style="color:#b26a00">not set</span>'}<br>
    <input name="url" placeholder="webcal://…/podium/feed/iCal.aspx?…" style="width:75%;padding:6px" required> <button>Save</button></form>`).join('')}`);
};
app.get('/setup', authed, (req, res) => res.send(setupPage(req)));
app.post('/kid/:kid/ical', authed, express.urlencoded({ extended: false }), async (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('Unknown kid');
  let msg;
  try {
    setFeedUrl(kid, req.body.url);
    const items = await fetchAssignmentFeed(kid);
    msg = `${kid.name}'s feed saved: ${items.length} assignments in the next 6 weeks / last 3 weeks.`;
    runKidById(kid.id).catch(console.error);
  } catch (e) { msg = `${kid.name}: ${e.message}`; }
  res.send(setupPage(req, msg));
});
app.get('/debug/:kid/ical', authed, async (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('Unknown kid');
  try { res.json(await fetchAssignmentFeed(kid)); } catch (e) { res.status(500).send(e.message); }
});

app.get('/about', (_req, res) => res.send(page('Kalus School Tracker', '<p>A private family tool that shows our own children their Google Classroom assignments, due dates and turned-in status, and their school grades, and alerts parents when work is missing or a grade drops. Not available to the public.</p>')));
app.get('/privacy', (_req, res) => res.send(page('Privacy Policy', '<p>This app is used only by the Kalus family. With a student\'s permission it reads that student\'s own Google Classroom courses, assignments and submission status (read-only). The data is stored on a private server, shown only to that student and their parents, and used only to build homework plans and grade alerts. It is never sold, shared with third parties, or used for advertising. Access can be removed at any time at myaccount.google.com/permissions, and stored data is deleted on request.</p>')));
app.get('/terms', (_req, res) => res.send(page('Terms of Service', '<p>Private family tool provided as-is for the Kalus family. No other use is permitted.</p>')));

const kidView = k => ({ ...k, connected: isConnected(k.id), data: kidState(k.id) });

app.get('/', authed, (_req, res) => {
  res.send(dashboardHtml(config.kids.map(kidView), config.aThreshold, null));
});

app.get('/kid/:kid', authed, (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('Unknown kid');
  res.send(dashboardHtml(config.kids.map(kidView), config.aThreshold, kid.id));
});

app.get('/kid/:kid/missing.json', authed, (req, res) => {
  const st = kidState(req.params.kid);
  res.json((st?.homework || []).filter(i => i.status === 'missing').sort((a, b) => new Date(a.due) - new Date(b.due))
    .map(({ course, title, due, link }) => ({ course, title, due, link })));
});

app.get('/code/:kid', authed, (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('Unknown kid');
  res.send(page(`${kid.name}: Blackbaud code`, `<p>Enter the 6-digit code Blackbaud emailed to ${kid.name}'s school address.</p>
    <form method="post"><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus style="font-size:28px;letter-spacing:6px;width:200px;padding:8px">
    <button style="font-size:20px;padding:10px 18px;margin-left:8px">Submit</button></form>`));
});
app.post('/code/:kid', authed, express.urlencoded({ extended: false }), (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!kid || code.length !== 6) return res.status(400).send(page('Try again', '<p>That should be 6 digits.</p>'));
  save(`code-${kid.id}`, { code, at: new Date().toISOString() });
  res.send(page('Got it', `<p>Code sent. ${kid.name}'s grades will appear on the dashboard in about a minute.</p><p><a href="/kid/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}">Back to dashboard</a></p>`));
});

app.get('/debug/:kid/dom', authed, (req, res) => res.json(load(`bb-code-dom-${req.params.kid}`, null)));
app.get('/debug/:kid/screenshot', authed, (req, res) => {
  res.sendFile(`${config.dataDir}/bb-error-${req.params.kid}.png`, err => err && res.status(404).send('none'));
});

app.get('/kid/:kid/scorecard', authed, (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('Unknown kid');
  res.send(buildScorecard(kid, kidState(kid.id)).html);
});
app.post('/kid/:kid/scorecard/send', authed, express.text({ type: '*/*' }), async (req, res) => {
  let opts = {};
  try { opts = JSON.parse(req.body || '{}'); } catch {}
  await sendScorecards(req.params.kid, opts.note, opts.subjectPrefix);
  res.send('sent');
});

app.get('/connect/:kid', (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('Unknown kid');
  res.redirect(authUrl(kid.id, [].concat(kid.email || [])[0]));
});

app.get('/oauth/callback', async (req, res) => {
  if (req.query.error) return res.status(400).send(page('Google sign-in was not completed', `<p>Google returned: <b>${String(req.query.error).replace(/[<>&]/g, '')}</b>.</p>`));
  try {
    if (!config.kids.find(k => k.id === req.query.state)) throw new Error('Unknown kid');
    await handleCallback(req.query.code, req.query.state);
    res.send(page('Connected', `<p>Google Classroom is connected. Homework will appear in about a minute.</p><p><a href="/kid/${encodeURIComponent(req.query.state)}?key=${encodeURIComponent(config.dashboardKey)}">Back to the dashboard</a></p>`));
    runKidById(req.query.state).catch(console.error);
  } catch (e) { res.status(400).send(`Connection failed: ${e.message}`); }
});

app.post('/run', authed, (_req, res) => {
  runAll().catch(console.error);
  res.redirect(`/?key=${encodeURIComponent(config.dashboardKey)}`);
});

app.post('/run/:kid', authed, (req, res) => {
  runKidById(req.params.kid).catch(console.error);
  res.redirect(`/kid/${encodeURIComponent(req.params.kid)}?key=${encodeURIComponent(config.dashboardKey)}`);
});


app.listen(config.port, () => {
  console.log(`listening on ${config.port}; schedule "${config.cron}" ET`);
  cron.schedule(config.cron, () => runAll().catch(console.error), { timezone: 'America/New_York' });
  cron.schedule('55 15 * * 5', () => sendScorecards().catch(console.error), { timezone: 'America/New_York' }); // Fridays 3:55pm
});
