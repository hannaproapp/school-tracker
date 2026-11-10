import { chromium } from 'playwright';
import path from 'path';
import { config, kidCreds, kidBlackbaudBase } from './config.js';
import { save } from './store.js';

function schoolYearLabel() {
  if (config.blackbaud.schoolYear) return config.blackbaud.schoolYear;
  const d = new Date();
  const y = d.getFullYear();
  return d.getMonth() >= 6 ? `${y} - ${y + 1}` : `${y - 1} - ${y}`;
}

const PASSWORD_SELECTORS = [
  '#Password', 'input[name="Passwd"]', 'input[type="password"]:visible',
];

async function login(page, base, user, pass) {
  await page.goto(`${base}/app#login`, { waitUntil: 'domcontentloaded' });
  const email = page.locator('#Username, input[type="email"], input[name="username"]').first();
  await email.waitFor({ timeout: 30000 });
  await email.fill(user);
  await page.locator('#nextBtn, button:has-text("Next"), input[value="Next"]').first().click();

  // Password may appear on Blackbaud, Blackbaud ID, Google, or Microsoft pages.
  const pw = page.locator(PASSWORD_SELECTORS.join(', ')).first();
  await pw.waitFor({ state: 'visible', timeout: 45000 });
  if (page.url().includes('accounts.google.com')) {
    // Google sometimes asks for the email again on its own page.
    const gEmail = page.locator('#identifierId');
    if (await gEmail.isVisible().catch(() => false)) {
      await gEmail.fill(user);
      await page.locator('#identifierNext').click();
      await pw.waitFor({ state: 'visible', timeout: 30000 });
    }
  }
  await pw.fill(pass);
  await pw.press('Enter');

  await page.waitForURL(u => u.toString().startsWith(base) && !u.toString().includes('#login'), { timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

export async function fetchBlackbaud(kid) {
  const { user, pass } = kidCreds(kid);
  if (!user || !pass) throw new Error(`Blackbaud credentials not set for ${kid.name}`);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  try {
    await login(page, kidBlackbaudBase(kid), user, pass);
    const year = schoolYearLabel();

    const result = await page.evaluate(async (year) => {
      const get = async (u) => {
        const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`${r.status} ${u}`);
        return r.json();
      };
      const ctxInfo = await get('/api/webapp/context');
      const userId = ctxInfo?.UserInfo?.UserId;
      const terms = await get(`/api/DataDirect/StudentGroupTermList/?studentUserId=${userId}&schoolYearLabel=${encodeURIComponent(year)}&personaId=2`);
      const current = terms.filter(t => t.CurrentInd === 1 || t.CurrentInd === true);
      const durationIds = [...new Set((current.length ? current : terms).map(t => t.DurationId))].join(',');
      const groups = await get(`/api/datadirect/ParentStudentUserAcademicGroupsGet?userId=${userId}&schoolYearLabel=${encodeURIComponent(year)}&memberLevel=3&persona=2&durationList=${durationIds}`);

      const sections = [];
      for (const g of groups) {
        let assignments = [];
        if (g.markingperiodid) {
          try {
            assignments = await get(`/api/datadirect/GradeBookPerformanceAssignmentStudentList/?sectionId=${g.sectionid}&markingPeriodId=${g.markingperiodid}&studentUserId=${userId}`);
          } catch (e) { assignments = []; }
        }
        sections.push({ group: g, assignments });
      }
      return { userId, terms, sections };
    }, year);

    save(`bb-raw-${kid.id}`, result); // kept for troubleshooting field names

    const courses = result.sections.map(({ group: g, assignments }) => {
      const cum = g.cumgrade ?? g.CumGrade ?? null;
      const pct = cum != null && cum !== '' && !isNaN(Number(cum)) ? Number(cum) : null;
      return {
        course: g.sectionidentifier || g.groupname || g.SectionIdentifier,
        teacher: g.groupownername || g.GroupOwnerName || '',
        grade: pct,
        letter: g.cumgradelettergrade || g.lettergrade || (pct != null ? toLetter(pct) : null),
        assignments: (assignments || []).map(a => ({
          title: a.AssignmentShortDescription || a.AssignmentDescription,
          type: a.AssignmentType,
          due: a.DateDue,
          points: a.Points ?? null,
          max: a.MaxPoints ?? null,
          pct: a.AssignmentPercentage != null ? Number(a.AssignmentPercentage)
            : (a.Points != null && a.MaxPoints ? Math.round(a.Points / a.MaxPoints * 1000) / 10 : null),
          id: a.AssignmentIndexId || a.AssignmentId,
        })).filter(a => a.title),
      };
    }).filter(c => c.course);
    return { year, courses };
  } catch (e) {
    await page.screenshot({ path: path.join(config.dataDir, `bb-error-${kid.id}.png`) }).catch(() => {});
    throw new Error(`Blackbaud login/fetch failed at ${page.url()}: ${e.message}`);
  } finally {
    await browser.close();
  }
}

export function toLetter(p) {
  if (p >= 97) return 'A+';
  if (p >= 93) return 'A';
  if (p >= 90) return 'A-';
  if (p >= 87) return 'B+';
  if (p >= 83) return 'B';
  if (p >= 80) return 'B-';
  if (p >= 77) return 'C+';
  if (p >= 73) return 'C';
  if (p >= 70) return 'C-';
  if (p >= 67) return 'D+';
  if (p >= 60) return 'D';
  return 'F';
}
