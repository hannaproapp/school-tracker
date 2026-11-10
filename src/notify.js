import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport;
function mailer() {
  if (!config.mail.user || !config.mail.pass) return null;
  transport ||= nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.port === 465,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  return transport;
}

export async function email(to, subject, html) {
  const m = mailer();
  const list = [...new Set(to.filter(Boolean))];
  if (!m || !list.length) { console.log('[email skipped]', subject); return; }
  await m.sendMail({ from: `School Tracker <${config.mail.user}>`, to: list.join(','), subject, html });
}

export async function push(title, message, url) {
  if (!config.ntfyTopic) return;
  await fetch(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
    method: 'POST',
    body: message,
    headers: { Title: title, Priority: 'high', Tags: 'warning', ...(url ? { Click: url } : {}) },
  }).catch(e => console.error('ntfy', e.message));
}
