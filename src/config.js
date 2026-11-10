import fs from 'fs';
// Kids are defined in kids.json (no secrets). Blackbaud grades come from a daily check
// in the family Chrome where each kid is signed into Blackbaud. Google Classroom
// tokens are stored per kid on the volume after that kid approves access.
const env = process.env;
const kidsFile = new URL('../kids.json', import.meta.url);
const kids = env.KIDS ? JSON.parse(env.KIDS) : JSON.parse(fs.readFileSync(kidsFile, 'utf8'));

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || '').replace(/\/$/, ''),
  dataDir: env.DATA_DIR || '/data',
  dashboardKey: env.DASHBOARD_KEY || '',
  cron: env.RUN_CRON || '0 6,15,20 * * *', // 6am, 3pm, 8pm ET
  aThreshold: Number(env.A_THRESHOLD || 93),
  planDays: Number(env.PLAN_DAYS || 14),
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  },
  blackbaud: {
    base: (env.BB_BASE || 'https://wheelerschool.myschoolapp.com').replace(/\/$/, ''),
    schoolYear: env.BB_SCHOOL_YEAR || '', // e.g. "2026 - 2027"; auto-detected if blank
  },
  mail: {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 465),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    parentTo: (env.PARENT_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean),
  },
  ntfyTopic: env.NTFY_TOPIC || '',
  kids: kids.filter(k => k.active !== false),
};

export const kidBlackbaudBase = kid => (kid.blackbaudUrl || config.blackbaud.base).replace(/\/$/, '');
export const kidAlertEmails = kid => [...(kid.alertEmails?.length ? kid.alertEmails : config.mail.parentTo), ...[].concat(kid.email || [])];

export function kidCreds(kid) {
  return {
    user: process.env[kid.bbUserEnv || `${kid.id.toUpperCase()}_BB_USER`],
    pass: process.env[kid.bbPassEnv || `${kid.id.toUpperCase()}_BB_PASS`],
  };
}
