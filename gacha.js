import { DateTime } from 'luxon';
import { config } from './config.js';
import { db, isoNow, localDate, localNow, timeOnLocalDate } from './db.js';

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function linearProbability(nowMs, startMs, endMs, pStart, pEnd) {
  if (endMs <= startMs) return clamp01(pEnd);
  const progress = clamp01((nowMs - startMs) / (endMs - startMs));
  return clamp01(pStart + (pEnd - pStart) * progress);
}

export function getActiveGoldSlot(now = DateTime.utc()) {
  return db.prepare(`
    SELECT * FROM gold_slots
    WHERE consumed_at IS NULL AND start_at <= ? AND end_at > ?
    ORDER BY start_at ASC
    LIMIT 1
  `).get(now.toISO(), now.toISO()) ?? null;
}

export function getCurrentGoldP(now, slot) {
  return linearProbability(
    now.toMillis(),
    DateTime.fromISO(slot.start_at).toMillis(),
    DateTime.fromISO(slot.end_at).toMillis(),
    slot.p_start,
    slot.p_end,
  );
}

export function getCurrentSilverP(now = localNow()) {
  const start = timeOnLocalDate(now, config.openTime);
  const end = timeOnLocalDate(now, config.closeTime);
  if (now < start || now >= end) return 0;
  return linearProbability(now.toMillis(), start.toMillis(), end.toMillis(), config.silverPStart, config.silverPEnd);
}

const resolveTransaction = db.transaction(({ kioskId, sessionId, goldRoll, silverRoll }) => {
  const nowUtc = DateTime.utc();
  const nowLocal = nowUtc.setZone(config.timezone);
  const timestamp = nowUtc.toISO();

  if (config.testForcedResult === 'gold' || config.testForcedResult === 'silver' || config.testForcedResult === 'fail') {
    return consumeForced(config.testForcedResult, nowUtc, nowLocal, kioskId, sessionId);
  }

  const gold = getActiveGoldSlot(nowUtc);
  if (gold && goldRoll < getCurrentGoldP(nowUtc, gold)) {
    const changed = db.prepare(`
      UPDATE gold_slots
      SET consumed_at = ?, kiosk_id = ?, session_id = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(timestamp, kioskId, sessionId, gold.id);
    if (changed.changes === 1) return 'gold';
  }

  const silverP = getCurrentSilverP(nowLocal);
  if (silverP <= 0 || silverRoll >= silverP) return 'fail';

  const date = localDate(nowLocal);
  db.prepare('INSERT OR IGNORE INTO silver_days(local_date) VALUES (?)').run(date);
  const changed = db.prepare(`
    UPDATE silver_days
    SET consumed_at = ?, kiosk_id = ?, session_id = ?
    WHERE local_date = ? AND consumed_at IS NULL
  `).run(timestamp, kioskId, sessionId, date);
  return changed.changes === 1 ? 'silver' : 'fail';
});

function consumeForced(result, nowUtc, nowLocal, kioskId, sessionId) {
  const timestamp = nowUtc.toISO();
  if (result === 'gold') {
    const gold = getActiveGoldSlot(nowUtc);
    if (!gold) return 'fail';
    const changed = db.prepare(`
      UPDATE gold_slots SET consumed_at = ?, kiosk_id = ?, session_id = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(timestamp, kioskId, sessionId, gold.id);
    return changed.changes === 1 ? 'gold' : 'fail';
  }
  if (result === 'silver') {
    const date = localDate(nowLocal);
    db.prepare('INSERT OR IGNORE INTO silver_days(local_date) VALUES (?)').run(date);
    const changed = db.prepare(`
      UPDATE silver_days SET consumed_at = ?, kiosk_id = ?, session_id = ?
      WHERE local_date = ? AND consumed_at IS NULL
    `).run(timestamp, kioskId, sessionId, date);
    return changed.changes === 1 ? 'silver' : 'fail';
  }
  return 'fail';
}

export function resolveGrab(kioskId, sessionId, random = Math.random) {
  return resolveTransaction({ kioskId, sessionId, goldRoll: random(), silverRoll: random() });
}
