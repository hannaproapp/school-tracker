// Run inside a signed-in Blackbaud tab (wheelerschool.myschoolapp.com).
// Reads the student's own grades from Blackbaud and sends them to the tracker.
// Replace TRACKER, KEY and KID before running.
(async () => {
  const TRACKER = 'https://tracker-production-49fa.up.railway.app';
  const KEY = '__DASHBOARD_KEY__';
  const KID = '__KID__';
  const get = async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${u}`);
    return r.json();
  };
  const d = new Date();
  const y = d.getFullYear();
  const year = d.getMonth() >= 6 ? `${y} - ${y + 1}` : `${y - 1} - ${y}`;
  const ctx = await get('/api/webapp/context');
  const userId = ctx?.UserInfo?.UserId;
  if (!userId) return 'NOT_SIGNED_IN';
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
      } catch { assignments = []; }
    }
    sections.push({ group: g, assignments });
  }
  const r = await fetch(`${TRACKER}/ingest/${KID}?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ year, userId, terms, sections }),
  });
  return `${r.status} ${await r.text()}`;
})();
