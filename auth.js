import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { config } from './config.js';
import { db, isoNow, localDate, localNow, timeOnLocalDate } from './db.js';

export const ADMIN_COOKIE = 'claw_admin';

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...rest] = part.trim().split('=');
    return [key, decodeURIComponent(rest.join('='))];
  }).filter(([key]) => key));
}

export function createAdminSession() {
  const token = randomToken();
  const now = DateTime.utc();
  const expiresAt = now.plus({ hours: config.adminSessionHours });
  db.prepare('INSERT INTO admin_sessions(token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(token, now.toISO(), expiresAt.toISO());
  return { token, expiresAt };
}

export function getAdminSession(req) {
  const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  if (!token) return null;
  return db.prepare('SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?')
    .get(token, isoNow()) ?? null;
}

export function adminCookie(token, expiresAt) {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toHTTP()}${secure}`;
}

export function getOrCreateDailyAuthToken(now = localNow()) {
  const date = localDate(now);
  const availableAt = timeOnLocalDate(now, config.openTime).minus({ minutes: config.adminQrLeadMinutes });
  const expiresAt = timeOnLocalDate(now, config.closeTime);
  if (now < availableAt || now >= expiresAt) return null;

  const existing = db.prepare('SELECT * FROM admin_auth_tokens WHERE local_date = ?').get(date);
  if (existing) return existing;

  const token = randomToken();
  db.prepare(`
    INSERT INTO admin_auth_tokens(local_date, token, available_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(date, token, availableAt.toUTC().toISO(), expiresAt.toUTC().toISO());
  return db.prepare('SELECT * FROM admin_auth_tokens WHERE local_date = ?').get(date);
}

export function consumeAdminAuthToken(token) {
  return db.prepare(`
    SELECT * FROM admin_auth_tokens
    WHERE token = ? AND available_at <= ? AND expires_at > ?
  `).get(token, isoNow(), isoNow()) ?? null;
}
