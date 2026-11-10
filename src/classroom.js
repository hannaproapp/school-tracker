import { google } from 'googleapis';
import { config } from './config.js';
import { load, save } from './store.js';

const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'openid', 'email',
];

function client() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    `${config.baseUrl}/oauth/callback`,
  );
}

export function authUrl(kidId, loginHint) {
  return client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: kidId,
    login_hint: loginHint,
  });
}

export async function handleCallback(code, kidId) {
  const c = client();
  const { tokens } = await c.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  const all = load('tokens', {});
  all[kidId] = { refresh_token: tokens.refresh_token, connectedAt: new Date().toISOString() };
  save('tokens', all);
}

export function isConnected(kidId) {
  return !!load('tokens', {})[kidId];
}

function dueDate(cw) {
  if (!cw.dueDate) return null;
  const { year, month, day } = cw.dueDate;
  const t = cw.dueTime || {};
  // Classroom due dates are UTC
  return new Date(Date.UTC(year, month - 1, day, t.hours ?? 23, t.minutes ?? 59)).toISOString();
}

async function listAll(fn, key, params) {
  const out = [];
  let pageToken;
  do {
    const { data } = await fn({ ...params, pageToken, pageSize: 100 });
    out.push(...(data[key] || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

export async function fetchClassroom(kidId) {
  const tok = load('tokens', {})[kidId];
  if (!tok) throw new Error('Google Classroom not connected');
  const auth = client();
  auth.setCredentials({ refresh_token: tok.refresh_token });
  const cr = google.classroom({ version: 'v1', auth });

  const courses = await listAll(p => cr.courses.list(p), 'courses', { studentId: 'me', courseStates: ['ACTIVE'] });
  const items = [];
  for (const course of courses) {
    let work = [], subs = [];
    try {
      work = await listAll(p => cr.courses.courseWork.list(p), 'courseWork', { courseId: course.id, orderBy: 'dueDate desc' });
      subs = await listAll(p => cr.courses.courseWork.studentSubmissions.list(p), 'studentSubmissions', { courseId: course.id, courseWorkId: '-', userId: 'me' });
    } catch (e) {
      console.error(`classroom course ${course.name}:`, e.message);
      continue;
    }
    const subByWork = Object.fromEntries(subs.map(s => [s.courseWorkId, s]));
    for (const cw of work) {
      const s = subByWork[cw.id] || {};
      const due = dueDate(cw);
      const turnedIn = ['TURNED_IN', 'RETURNED'].includes(s.state) || !!s.assignmentSubmission?.attachments?.length && s.state !== 'RECLAIMED_BY_STUDENT';
      const graded = s.assignedGrade != null;
      let status;
      if (s.state === 'TURNED_IN' || s.state === 'RETURNED') status = s.late ? 'late' : 'submitted';
      else if (due && new Date(due) < new Date()) status = 'missing';
      else status = 'todo';
      items.push({
        source: 'classroom',
        id: cw.id,
        course: course.name,
        title: cw.title,
        type: cw.workType,
        due,
        link: cw.alternateLink,
        status,
        turnedIn,
        points: cw.maxPoints ?? null,
        score: graded ? s.assignedGrade : null,
        pct: graded && cw.maxPoints ? Math.round((s.assignedGrade / cw.maxPoints) * 1000) / 10 : null,
        updated: s.updateTime || cw.updateTime,
        category: cw.gradeCategory?.id || null,
        courseId: course.id,
      });
    }
  }
  const overall = courses.map(c => ({ course: c.name, ...overallGrade(c, items.filter(i => i.courseId === c.id)) }))
    .filter(c => c.grade != null);
  return { courses: courses.map(c => c.name), items, overall };
}

// Mirrors Classroom's "overall grade": total points, or weighted categories
// (weights renormalized over categories that have graded work).
function overallGrade(course, items) {
  const gs = course.gradebookSettings || {};
  const graded = items.filter(i => i.score != null && i.points > 0);
  if (!graded.length || gs.calculationType === 'NO_GRADE') return { grade: null };
  if (gs.calculationType === 'WEIGHTED_CATEGORIES' && gs.gradeCategories?.length) {
    let wsum = 0, acc = 0;
    for (const cat of gs.gradeCategories) {
      const inCat = graded.filter(i => i.category === cat.id);
      if (!inCat.length || !cat.weight) continue;
      const pct = inCat.reduce((a, i) => a + i.score, 0) / inCat.reduce((a, i) => a + i.points, 0);
      acc += pct * cat.weight; wsum += cat.weight;
    }
    if (wsum) return { grade: Math.round((acc / wsum) * 10000) / 100, method: 'weighted categories' };
  }
  const pts = graded.reduce((a, i) => a + i.score, 0), max = graded.reduce((a, i) => a + i.points, 0);
  return { grade: Math.round((pts / max) * 10000) / 100, method: 'total points' };
}
