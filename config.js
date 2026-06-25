import { resolve } from 'node:path';

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function floatEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  port: intEnv('PORT', 8080),
  bindHost: process.env.BIND_HOST ?? '127.0.0.1',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${intEnv('PORT', 8080)}`,
  tokenTtlSeconds: intEnv('TOKEN_TTL_SECONDS', 300),
  sessionDurationSeconds: intEnv('SESSION_DURATION_SECONDS', 60),
  heartbeatIntervalMs: intEnv('HEARTBEAT_INTERVAL_MS', 15000),
  rateLimitPerSec: intEnv('RATE_LIMIT_PER_SEC', 30),
  startTimeoutMs: intEnv('START_TIMEOUT_MS', 30000),
  grabResolvedTimeoutMs: intEnv('GRAB_RESOLVED_TIMEOUT_MS', 10000),
  animationDoneTimeoutMs: intEnv('ANIMATION_DONE_TIMEOUT_MS', 30000),
  timezone: process.env.TIMEZONE ?? 'Asia/Seoul',
  openTime: process.env.OPEN_TIME ?? '18:00',
  closeTime: process.env.CLOSE_TIME ?? '23:00',
  silverPStart: floatEnv('SILVER_P_START', 0.01),
  silverPEnd: floatEnv('SILVER_P_END', 0.30),
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  adminSessionHours: intEnv('ADMIN_SESSION_HOURS', 8),
  adminQrLeadMinutes: intEnv('ADMIN_QR_LEAD_MINUTES', 60),
  dbPath: resolve(process.env.DB_PATH ?? './data/gacha.sqlite3'),
  debugInput: process.env.DEBUG_INPUT === '1' || process.env.DEBUG_INPUT === 'true',
  testForcedResult: process.env.TEST_FORCE_RESULT ?? '',
};
