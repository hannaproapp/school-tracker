// Server-side Blackbaud login with each kid's stored credentials (Railway variables
// <ID>_BB_USER / <ID>_BB_PASS). Plain automated browser; if a sign-in page refuses it,
// the error and a screenshot are saved so the reason is visible on the dashboard.
import { chromium } from 'playwright';
import path from 'path';
import { config, kidCreds, kidBlackbaudBase } from './config.js';
import { save, load } from './store.js';
import { email, push } from './notify.js';
import { kidAlertEmails } from './config.js';
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

// Blackbaud emails a 6-digit code the first time a new device signs in. Ask the kid to
// type it into the tracker (/code/<id>), wait up to 15 minutes, then enter it. The
// browser profile is kept on the volume so Blackbaud remembers this device afterwards.
async function enterEmailedCode(page, kid) {
  save(`code-${kid.id}`, { requestedAt: new Date().toISOString(), code: null });
  const link = `${config.baseUrl}/code/${kid.id}?key=${encodeURIComponent(config.dashboardKey)}`;
  const msg = `Blackbaud just emailed ${kid.name} a 6-digit code. Enter it here within 15 minutes so the grade checker can sign in: ${link}`;
  await push(`${kid.name}: enter Blackbaud code`, msg, link);
  await email(kidAlertEmails(kid), `${kid.name}: enter the Blackbaud code`, `<p>${msg.replace(link, `<a href="${link}">${link}</a>`)}</p>`);
  const until = Date.now() + 15 * 60000;
  while (Date.now() < until) {
    const c = load(`code-${kid.id}`, {});
    if (c.code) {
      const box = page.getByLabel(/confirmation code/i)
        .or(page.locator('[role="dialog"] input:not([type="hidden"])'))
        .or(page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i]')).first();
      try {
        await box.fill(c.code, { timeout: 10000 });
      } catch {
        // Fallback: focus the dialog field by clicking its label, then type.
        await page.locator('text=Confirmation code').first().click();
        await page.keyboard.type(c.code, { delay: 50 });
      }
      await page.locator('button:has-text("Confirm")').first().click();
      save(`code-${kid.id}`, { usedAt: new Date().toISOString(), code: null });
      await sleep(5000);
      return;
    }
    await sleep(5000);
  }
  throw new Error('Blackbaud code was not entered within 15 minutes');
}

// Walks whichever sign-in pages appear: Wheeler/Blackbaud, Blackbaud ID, Google.
async function login(page, base, user, pass, kid) {
  await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded' });
  let deadline = Date.now() + 120000;
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
      const emailBox = page.locator('input[type="email"], input[name="username"]').first();
      if (await page.locator('text=Confirm your account').first().isVisible().catch(() => false)) {
        await enterEmailedCode(page, kid);
        deadline = Date.now() + 120000;
      } else if (await isVisible(page, 'input[type="password"]')) {
        await page.fill('input[type="password"]', pass); await page.keyboard.press('Enter');
      } else if (await emailBox.isVisible().catch(() => false)) {
        if (!(await emailBox.inputValue().catch(() => ''))) await emailBox.fill(user);
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
  const browser = await chromium.launchPersistentContext(path.join(config.dataDir, `browser-${kid.id}`), { args: ['--no-sandbox'] });
  const page = browser.pages()[0] || await browser.newPage();
  try {
    await login(page, base, user, pass, kid);
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
