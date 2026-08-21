import { DateTime } from 'luxon';
import { config } from './config.js';
import { db, isoNow, localDate, localNow, timeOnLocalDate } from './db.js';

const GOLD_PRIZE = {
  id: 'gold_crystal_led_tower',
  name: '크리스탈 LED 정림사지 오층석탑',
  grade: 'gold',
  scope: 'exhibition',
  count: 3,
};

export const SILVER_PRIZES = [
  { id: 'usb', name: 'USB', grade: 'silver', scope: 'daily', count: 3 },
  { id: 'gyeyangbae', name: '계양배', grade: 'silver', scope: 'daily', count: 1 },
  { id: 'wooden_pillow', name: '목침', grade: 'silver', scope: 'daily', count: 1 },
  { id: 'handkerchief', name: '손수건', grade: 'silver', scope: 'daily', count: 1 },
  { id: 'ceramic_lunchbox', name: '도자기 도시락', grade: 'silver', scope: 'daily', count: 1 },
];

export const PRIZES = [GOLD_PRIZE, ...SILVER_PRIZES];
const SILVER_TOTAL_UNITS = SILVER_PRIZES.reduce((sum, prize) => sum + prize.count, 0);

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function linearProbability(nowMs, startMs, endMs, pStart, pEnd) {
  if (endMs <= startMs) return clamp01(pEnd);
  const progress = clamp01((nowMs - startMs) / (endMs - startMs));
  return clamp01(pStart + (pEnd - pStart) * progress);
}

function periodKey(prize, nowLocal) {
  return prize.scope === 'daily' ? localDate(nowLocal) : 'exhibition';
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

function awardCount(prize, nowLocal) {
  return db.prepare('SELECT COUNT(*) AS count FROM prize_awards WHERE prize_id = ? AND period_key = ?')
    .get(prize.id, periodKey(prize, nowLocal)).count;
}

function remainingUnits(prize, nowLocal) {
  return Math.max(0, prize.count - awardCount(prize, nowLocal));
}

function claimPrize(prize, nowUtc, nowLocal, kioskId, sessionId) {
  const key = periodKey(prize, nowLocal);
  if (remainingUnits(prize, nowLocal) <= 0) return null;

  try {
    db.prepare(`
      INSERT INTO prize_awards(prize_id, prize_name, grade, scope, period_key, session_id, kiosk_id, awarded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(prize.id, prize.name, prize.grade, prize.scope, key, sessionId, kioskId, nowUtc.toISO());
    return { result: prize.grade, prizeId: prize.id, prizeName: prize.name };
  } catch {
    return null;
  }
}

function chooseWeightedPrize(prizes, nowLocal, roll) {
  const weighted = prizes
    .map((prize) => ({ prize, remaining: remainingUnits(prize, nowLocal) }))
    .filter((entry) => entry.remaining > 0);
  const total = weighted.reduce((sum, entry) => sum + entry.remaining, 0);
  if (total <= 0) return null;

  let cursor = clamp01(roll) * total;
  for (const entry of weighted) {
    cursor -= entry.remaining;
    if (cursor < 0) return entry.prize;
  }
  return weighted[weighted.length - 1].prize;
}

const resolveTransaction = db.transaction(({ kioskId, sessionId, goldRoll, silverRoll, silverPrizeRoll }) => {
  const nowUtc = DateTime.utc();
  const nowLocal = nowUtc.setZone(config.timezone);
  const timestamp = nowUtc.toISO();

  if (config.testForcedResult === 'gold' || config.testForcedResult === 'silver' || config.testForcedResult === 'fail') {
    return consumeForced(config.testForcedResult, nowUtc, nowLocal, kioskId, sessionId, silverPrizeRoll);
  }

  const gold = getActiveGoldSlot(nowUtc);
  if (gold && remainingUnits(GOLD_PRIZE, nowLocal) > 0 && goldRoll < getCurrentGoldP(nowUtc, gold)) {
    const changed = db.prepare(`
      UPDATE gold_slots
      SET consumed_at = ?, kiosk_id = ?, session_id = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(timestamp, kioskId, sessionId, gold.id);
    if (changed.changes === 1) {
      const award = claimPrize(GOLD_PRIZE, nowUtc, nowLocal, kioskId, sessionId);
      if (award) return award;
    }
  }

  const silverP = getCurrentSilverP(nowLocal);
  if (silverP <= 0 || silverRoll >= silverP) return { result: 'fail' };

  const silver = chooseWeightedPrize(SILVER_PRIZES, nowLocal, silverPrizeRoll);
  if (!silver) return { result: 'fail' };

  return claimPrize(silver, nowUtc, nowLocal, kioskId, sessionId) ?? { result: 'fail' };
});

function consumeForced(result, nowUtc, nowLocal, kioskId, sessionId, silverPrizeRoll) {
  const timestamp = nowUtc.toISO();
  if (result === 'gold') {
    const gold = getActiveGoldSlot(nowUtc);
    if (!gold || remainingUnits(GOLD_PRIZE, nowLocal) <= 0) return { result: 'fail' };
    const changed = db.prepare(`
      UPDATE gold_slots SET consumed_at = ?, kiosk_id = ?, session_id = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(timestamp, kioskId, sessionId, gold.id);
    if (changed.changes !== 1) return { result: 'fail' };
    return claimPrize(GOLD_PRIZE, nowUtc, nowLocal, kioskId, sessionId) ?? { result: 'fail' };
  }
  if (result === 'silver') {
    const silver = chooseWeightedPrize(SILVER_PRIZES, nowLocal, silverPrizeRoll);
    if (!silver) return { result: 'fail' };
    return claimPrize(silver, nowUtc, nowLocal, kioskId, sessionId) ?? { result: 'fail' };
  }
  return { result: 'fail' };
}

export function prizeInventory(nowLocal = localNow()) {
  const goldAwarded = db.prepare('SELECT COUNT(*) AS count FROM prize_awards WHERE prize_id = ? AND period_key = ?')
    .get(GOLD_PRIZE.id, 'exhibition').count;
  return PRIZES.map((prize) => {
    const key = periodKey(prize, nowLocal);
    const awarded = prize.id === GOLD_PRIZE.id ? goldAwarded : awardCount(prize, nowLocal);
    return {
      id: prize.id,
      name: prize.name,
      grade: prize.grade,
      scope: prize.scope,
      periodKey: key,
      total: prize.count,
      awarded,
      remaining: Math.max(0, prize.count - awarded),
    };
  });
}

export function resolveGrab(kioskId, sessionId, random = Math.random) {
  return resolveTransaction({
    kioskId,
    sessionId,
    goldRoll: random(),
    silverRoll: random(),
    silverPrizeRoll: random(),
  });
}
