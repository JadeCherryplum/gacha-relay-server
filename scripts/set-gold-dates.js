import 'dotenv/config';
import { DateTime } from 'luxon';
import { db } from '../db.js';
import { config } from '../config.js';

const DEFAULT_GOLD_DATES = ['2026-07-07', '2026-07-19', '2026-07-25'];

function parseProbability(name, fallback) {
  const value = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function parseDate(input, defaultYear) {
  const value = String(input ?? '').trim();
  if (!value) return null;

  const formats = ['yyyy-LL-dd', 'yyyy/M/d', 'M/d', 'M-d'];
  for (const format of formats) {
    const parsed = DateTime.fromFormat(value, format, { zone: config.timezone });
    if (!parsed.isValid) continue;
    return format.startsWith('yyyy')
      ? parsed
      : parsed.set({ year: defaultYear });
  }

  return null;
}

function timeOnDate(date, hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return date.startOf('day').set({ hour, minute, second: 0, millisecond: 0 });
}

const defaultYear = Number.parseInt(process.env.GOLD_DATES_YEAR ?? '', 10) || DateTime.now().setZone(config.timezone).year;
const dateInputs = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : (process.env.GOLD_DATES?.split(',').map((value) => value.trim()).filter(Boolean) ?? DEFAULT_GOLD_DATES);

const dates = dateInputs.map((input) => {
  const parsed = parseDate(input, defaultYear);
  if (!parsed?.isValid) {
    console.error(`Invalid gold date: ${input}`);
    process.exit(1);
  }
  return parsed;
});

const pStart = parseProbability('GOLD_P_START', 0.05);
const pEnd = parseProbability('GOLD_P_END', 0.80);

const slots = dates.map((date) => {
  const startAt = timeOnDate(date, config.openTime);
  const endAt = timeOnDate(date, config.closeTime);
  if (endAt <= startAt) {
    console.error(`Invalid open/close time for ${date.toFormat('yyyy-LL-dd')}: ${config.openTime} ~ ${config.closeTime}`);
    process.exit(1);
  }
  return {
    localDate: date.toFormat('yyyy-LL-dd'),
    startAt,
    endAt,
    startIso: startAt.toUTC().toISO(),
    endIso: endAt.toUTC().toISO(),
  };
});

const sync = db.transaction((nextSlots) => {
  const deleted = db.prepare('DELETE FROM gold_slots WHERE consumed_at IS NULL').run().changes;
  const exists = db.prepare('SELECT id FROM gold_slots WHERE start_at = ? AND end_at = ? LIMIT 1');
  const insert = db.prepare('INSERT INTO gold_slots(start_at, end_at, p_start, p_end) VALUES (?, ?, ?, ?)');
  const inserted = [];
  const preserved = [];

  for (const slot of nextSlots) {
    const existing = exists.get(slot.startIso, slot.endIso);
    if (existing) {
      preserved.push({ ...slot, id: existing.id });
      continue;
    }
    const result = insert.run(slot.startIso, slot.endIso, pStart, pEnd);
    inserted.push({ ...slot, id: result.lastInsertRowid });
  }

  return { deleted, inserted, preserved };
});

const result = sync(slots);

console.log(`Gold date sync complete. deleted_unconsumed=${result.deleted}`);
for (const slot of result.inserted) {
  console.log(`inserted id=${slot.id} ${slot.localDate} ${config.openTime}-${config.closeTime} p=${pStart}->${pEnd}`);
}
for (const slot of result.preserved) {
  console.log(`preserved consumed/existing id=${slot.id} ${slot.localDate} ${config.openTime}-${config.closeTime}`);
}

db.close();
