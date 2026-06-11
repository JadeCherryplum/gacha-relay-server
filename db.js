import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS gold_slots (
    id INTEGER PRIMARY KEY,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    p_start REAL NOT NULL,
    p_end REAL NOT NULL,
    consumed_at TEXT,
    kiosk_id TEXT,
    session_id TEXT
  );

  CREATE TABLE IF NOT EXISTS silver_days (
    local_date TEXT PRIMARY KEY,
    consumed_at TEXT,
    kiosk_id TEXT,
    session_id TEXT
  );

  CREATE TABLE IF NOT EXISTS play_log (
    session_id TEXT PRIMARY KEY,
    kiosk_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    grabbed_at TEXT,
    resolved_at TEXT,
    ended_at TEXT,
    result TEXT,
    end_reason TEXT,
    error_code TEXT
  );

  CREATE TABLE IF NOT EXISTS result_tokens (
    token TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    kiosk_id TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL,
    visible_at TEXT,
    expires_at TEXT NOT NULL,
    invalidated_at TEXT,
    claim_token TEXT UNIQUE,
    claimed_at TEXT,
    FOREIGN KEY (session_id) REFERENCES play_log(session_id)
  );

  CREATE TABLE IF NOT EXISTS admin_auth_tokens (
    local_date TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    available_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_gold_slots_active
    ON gold_slots(start_at, end_at, consumed_at);
  CREATE INDEX IF NOT EXISTS idx_result_tokens_claim
    ON result_tokens(claim_token);
  CREATE INDEX IF NOT EXISTS idx_play_log_started
    ON play_log(started_at);
`);

export function isoNow() {
  return DateTime.utc().toISO();
}

export function localNow() {
  return DateTime.now().setZone(config.timezone);
}

export function localDate(now = localNow()) {
  return now.toFormat('yyyy-LL-dd');
}

export function timeOnLocalDate(now, hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return now.startOf('day').set({ hour, minute, second: 0, millisecond: 0 });
}

export function closeAt(now = localNow()) {
  return timeOnLocalDate(now, config.closeTime);
}

export function cleanupExpired() {
  const now = isoNow();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
}

