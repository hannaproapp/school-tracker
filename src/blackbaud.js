// Server-side Blackbaud login with each kid's stored credentials (Railway variables
// <ID>_BB_USER / <ID>_BB_PASS). Plain automated browser; if a sign-in page refuses it,
// the error and a screenshot are saved so the reason is visible on the dashboard.
import { chromium } from 'playwright';
import path from 'path';
import { config, kidCreds, kidBlackbaudBase } from './config.js';
import { save } from './store.js';
import { normalizeBlackbaud } from './grades.js';

function schoolYearLabel() {
  if (config.blackbaud.schoolYear) return config.blackbaud.schoolYear;
  const d = new Date();
  const y = d.getFullYear();
  return d.getMonth() >= 6 ? `${y} - ${y + 1}` : `${y - 1} - ${y}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isVisible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

async function signedIn(page, base) {
  if (!page.url().startsWith(base) || page.url().includes('#login')) return false;
  return page.evaluate(async () => {
    const r = await fetch('/api/webapp/context', { credentials: 'include' });
    const j = r.ok ? await r.json().catch(() => null) : null;
    return !!j?.UserInfo?.UserId;
  }).catch(() => false);
}

// Walks whichever sign-in pages appear: Wheeler/Blackbaud, Blackbaud ID, Google.
async function login(page, base, user, pass) {
  await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 120000;
  const done = new Set();
  while (Date.now() < deadline) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const url = page.url();
    if (await signedIn(page, base)) return;

    if (url.startsWith(base)) {
      if (await isVisible(page, '#Username') && !done.has('bbuser')) {
        await page.fill('#Username', user); await page.click('#nextBtn'); done.add('bbuser');
      } else if (await isVisible(page, '#Password')) {
        await page.fill('#Password', pass); await page.press('#Password', 'Enter');
      }
    } else if (url.includes('blackbaud.com')) {
      const email = page.locator('input[type="email"], input[name="username"]').first();
      if (await isVisible(page, 'input[type="password"]')) {
        await page.fill('input[type="password"]', pass); await page.keyboard.press('Enter');
      } else if (await email.isVisible().catch(() => false)) {
        if (!(await email.inputValue().catch(() => ''))) await email.fill(user);
        await page.locator('button:has-text("Continue")').first().click().catch(() => {});
      }
    } else if (url.includes('accounts.google.com')) {
      if (await isVisible(page, '#identifierId')) {
        await page.fill('#identifierId', user); await page.click('#identifierNext');
      } else if (await isVisible(page, 'input[name="Passwd"]')) {
        await page.fill('input[name="Passwd"]', pass); await page.click('#passwordNext');
      } else if (await isVisible(page, `[data-identifier="${user}"]`)) {
        await page.click(`[data-identifier="${user}"]`);
      } else if (await isVisible(page, 'button:has-text("Continue")')) {
        await page.locator('button:has-text("Continue")').first().click();
      } else if (url.includes('/challenge/') || url.includes('/rejected') || url.includes('deniedsigninrejected')) {
        const msg = (await page.locator('h1, h2, [role="heading"]').allInnerTexts().catch(() => [])).join(' / ');
        throw new Error(`Google stopped the sign-in: ${msg || url.split('?')[0]}`);
      }
    }
    await sleep(2500);
  }
  const msg = (await page.locator('h1, h2, [role="heading"]').allInnerTexts().catch(() => [])).join(' / ');
  throw new Error(`Sign-in did not finish (stuck at ${page.url().split('?')[0]}${msg ? `: ${msg}` : ''})`);
}

export function hasCreds(kid) {
  const { user, pass } = kidCreds(kid);
  return !!(user && pass);
}

export async function fetchBlackbaud(kid) {
  const { user, pass } = kidCreds(kid);
  const base = kidBlackbaudBase(kid);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  try {
    await login(page, base, user, pass);
    const year = schoolYearLabel();
    const raw = await page.evaluate(async (year) => {
      const get = async (u) => {
        const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`${r.status} ${u}`);
        return r.json();
      };
      const userId = (await get('/api/webapp/context'))?.UserInfo?.UserId;
      const terms = await get(`/api/DataDirect/StudentGroupTermList/?studentUserId=${userId}&schoolYearLabel=${encodeURIComponent(year)}&personaId=2`);
      const current = terms.filter(t => t.CurrentInd === 1 || t.CurrentInd === true);
      const durationIds = [...new Set((current.length ? current : terms).map(t => t.DurationId))].join(',');
      const groups = await get(`/api/datadirect/ParentStudentUserAcademicGroupsGet?userId=${userId}&schoolYearLabel=${encodeURIComponent(year)}&memberLevel=3&persona=2&durationList=${durationIds}`);
      const sections = [];
      for (const g of groups) {
        let assignments = [];
        if (g.markingperiodid) {
          try { assignments = await get(`/api/datadirect/GradeBookPerformanceAssignmentStudentList/?sectionId=${g.sectionid}&markingPeriodId=${g.markingperiodid}&studentUserId=${userId}`); } catch { assignments = []; }
        }
        sections.push({ group: g, assignments });
      }
      return { year, userId, terms, sections };
    }, year);
    const courses = normalizeBlackbaud(raw);
    save(`bb-raw-${kid.id}`, raw);
    save(`bb-${kid.id}`, { at: new Date().toISOString(), year: raw.year, courses, via: 'railway' });
    return courses;
  } catch (e) {
    await page.screenshot({ path: path.join(config.dataDir, `bb-error-${kid.id}.png`) }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}
