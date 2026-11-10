// Blackbaud grades arrive from the daily Chrome check (POST /ingest/:kid), which reads
// the student's own signed-in Blackbaud session. This file normalizes that payload.

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

const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

export function normalizeBlackbaud(raw) {
  return (raw.sections || []).map(({ group: g, assignments }) => {
    const pct = num(g.cumgrade ?? g.CumGrade);
    return {
      course: g.sectionidentifier || g.groupname || g.SectionIdentifier,
      teacher: g.groupownername || g.GroupOwnerName || '',
      grade: pct,
      letter: g.cumgradelettergrade || g.lettergrade || (pct != null ? toLetter(pct) : null),
      assignments: (assignments || []).map(a => {
        const pts = num(a.Points), max = num(a.MaxPoints);
        return {
          title: a.AssignmentShortDescription || a.AssignmentDescription,
          type: a.AssignmentType,
          due: a.DateDue,
          points: pts,
          max,
          pct: num(a.AssignmentPercentage) ?? (pts != null && max ? Math.round((pts / max) * 1000) / 10 : null),
          id: a.AssignmentIndexId || a.AssignmentId,
        };
      }).filter(a => a.title),
    };
  }).filter(c => c.course);
}
