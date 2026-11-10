import express from 'express';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { authUrl, handleCallback, isConnected } from './classroom.js';
import { runAll, runKidById, kidState } from './run.js';
import { dashboardHtml } from './dashboard.js';

const app = express();

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui;max-width:720px;margin:40px auto;padding:0 20px"><h1>${title}</h1>${body}</body>`;

function authed(req, res, next) {
  if (!config.dashboardKey) return res.status(500).send('Set DASHBOARD_KEY first.');
  const key = req.query.key || (req.headers.cookie || '').match(/dk=([^;]+)/)?.[1];
  if (decodeURIComponent(key || '') !== config.dashboardKey) return res.status(401).send(page('Link expired', '<p>Open the dashboard with the full link that ends in <code>?key=...</code>. After that this browser stays signed in.</p>'));
  if (req.query.key) res.setHeader('Set-Cookie', `dk=${encodeURIComponent(config.dashboardKey)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  next();
}

app.get('/health', (_req, res) => res.send('ok'));

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

app.get('/connect/:kid', authed, (req, res) => {
  const kid = config.kids.find(k => k.id === req.params.kid);
  if (!kid) return res.status(404).send('Unknown kid');
  res.redirect(authUrl(kid.id, kid.email));
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

app.get('/debug/:kid/screenshot', authed, (req, res) => {
  const f = path.join(config.dataDir, `bb-error-${req.params.kid}.png`);
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('none');
});

app.listen(config.port, () => {
  console.log(`listening on ${config.port}; schedule "${config.cron}" ET`);
  cron.schedule(config.cron, () => runAll().catch(console.error), { timezone: 'America/New_York' });
});
