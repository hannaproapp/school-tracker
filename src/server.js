import express from 'express';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { authUrl, handleCallback, isConnected } from './classroom.js';
import { runAll, runKidById, kidState } from './run.js';
import { dashboardHtml } from './dashboard.js';

const app = express();

function authed(req, res, next) {
  if (!config.dashboardKey) return res.status(500).send('Set DASHBOARD_KEY first.');
  const key = req.query.key || (req.headers.cookie || '').match(/dk=([^;]+)/)?.[1];
  if (decodeURIComponent(key || '') !== config.dashboardKey) return res.status(401).send('Unauthorized');
  if (req.query.key) res.setHeader('Set-Cookie', `dk=${encodeURIComponent(config.dashboardKey)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  next();
}

app.get('/health', (_req, res) => res.send('ok'));

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
  try {
    if (!config.kids.find(k => k.id === req.query.state)) throw new Error('Unknown kid');
    await handleCallback(req.query.code, req.query.state);
    res.send('<p>Google Classroom connected. You can close this tab.</p>');
    runKidById(req.query.state).catch(console.error);
  } catch (e) { res.status(400).send(`Connection failed: ${e.message}`); }
});

app.post('/run', authed, (_req, res) => {
  runAll().catch(console.error);
  res.redirect('/');
});

app.post('/run/:kid', authed, (req, res) => {
  runKidById(req.params.kid).catch(console.error);
  res.redirect(`/kid/${encodeURIComponent(req.params.kid)}`);
});

app.get('/debug/:kid/screenshot', authed, (req, res) => {
  const f = path.join(config.dataDir, `bb-error-${req.params.kid}.png`);
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('none');
});

app.listen(config.port, () => {
  console.log(`listening on ${config.port}; schedule "${config.cron}" ET`);
  cron.schedule(config.cron, () => runAll().catch(console.error), { timezone: 'America/New_York' });
});
