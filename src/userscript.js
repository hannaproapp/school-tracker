// Tampermonkey userscript served by the tracker (/sync/<ingestKey>/school-tracker.user.js).
// Installed once in each kid's Chrome. Whenever that kid has Blackbaud open, it reads their
// own grades and posts them to /ingest/<kid> (at most every MIN_HOURS hours).
import crypto from 'crypto';
import { config, kidBlackbaudBase } from './config.js';

// A separate key for the kids' browsers so they never hold the dashboard key.
export const ingestKey = () => config.dashboardKey
  ? crypto.createHmac('sha256', config.dashboardKey).update('ingest').digest('base64url').slice(0, 24)
  : '';

export function userscript(trackerBase) {
  const hosts = [...new Set(config.kids.map(k => new URL(kidBlackbaudBase(k)).host))];
  const kidsByFirstName = Object.fromEntries(config.kids.map(k => [String(k.name).toLowerCase(), k.id]));
  const trackerHost = new URL(trackerBase).hostname;
  return `// ==UserScript==
// @name         School Tracker grade sync
// @namespace    school-tracker
// @version      1.0
// @description  When Blackbaud is open, sends this student's grades to the family School Tracker.
${hosts.map(h => `// @match        https://${h}/*`).join('\n')}
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      ${trackerHost}
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
  'use strict';
  const TRACKER = ${JSON.stringify(trackerBase)};
  const KEY = ${JSON.stringify(ingestKey())};
  const KIDS = ${JSON.stringify(kidsByFirstName)};
  const MIN_HOURS = 3;
  const log = (...a) => console.log('[School Tracker]', ...a);

  const get = async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(r.status + ' ' + u);
    return r.json();
  };
  const post = (url, body) => new Promise((resolve, reject) => GM_xmlhttpRequest({
    method: 'POST', url, data: body, headers: { 'Content-Type': 'text/plain' },
    onload: r => resolve(r.status + ' ' + r.responseText), onerror: () => reject(new Error('network error')),
  }));
  const toast = (text) => {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#1d1d1f;color:#fff;padding:8px 12px;border-radius:8px;font:13px system-ui;opacity:.92';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  let busy = false;
  async function sync() {
    if (busy) return;
    busy = true;
    try {
      const ctx = await get('/api/webapp/context').catch(() => null);
      const userId = ctx && ctx.UserInfo && ctx.UserInfo.UserId;
      if (!userId) return; // not signed in yet
      const kid = KIDS[String(ctx.UserInfo.FirstName || '').toLowerCase()];
      if (!kid) return log('signed-in user is not a tracked student; skipping');
      const last = Number(GM_getValue('last-' + kid, 0));
      if (Date.now() - last < MIN_HOURS * 3600000) return;

      const d = new Date(); const y = d.getFullYear();
      const year = d.getMonth() >= 6 ? y + ' - ' + (y + 1) : (y - 1) + ' - ' + y;
      const terms = await get('/api/DataDirect/StudentGroupTermList/?studentUserId=' + userId + '&schoolYearLabel=' + encodeURIComponent(year) + '&personaId=2');
      const current = terms.filter(t => t.CurrentInd === 1 || t.CurrentInd === true);
      const durationIds = [...new Set((current.length ? current : terms).map(t => t.DurationId))].join(',');
      const groups = await get('/api/datadirect/ParentStudentUserAcademicGroupsGet?userId=' + userId + '&schoolYearLabel=' + encodeURIComponent(year) + '&memberLevel=3&persona=2&durationList=' + durationIds);
      const sections = [];
      for (const g of groups) {
        let assignments = [];
        if (g.markingperiodid) {
          try { assignments = await get('/api/datadirect/GradeBookPerformanceAssignmentStudentList/?sectionId=' + g.sectionid + '&markingPeriodId=' + g.markingperiodid + '&studentUserId=' + userId); } catch (e) {}
        }
        sections.push({ group: g, assignments });
      }
      const res = await post(TRACKER + '/ingest/' + kid + '?key=' + encodeURIComponent(KEY), JSON.stringify({ year, userId, terms, sections }));
      log(res);
      if (res.startsWith('200')) { GM_setValue('last-' + kid, Date.now()); toast('Grades synced to School Tracker'); }
    } catch (e) {
      log('sync failed:', e.message);
    } finally { busy = false; }
  }

  setTimeout(sync, 5000);                 // after Blackbaud finishes loading
  setInterval(sync, 15 * 60000);          // keeps syncing if the tab stays open
})();
`;
}
