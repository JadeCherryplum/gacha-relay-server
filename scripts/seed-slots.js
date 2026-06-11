import 'dotenv/config';
import { DateTime } from 'luxon';
import { db } from '../db.js';
import { config } from '../config.js';

const [start, end, pStart = '0.05', pEnd = '0.80'] = process.argv.slice(2);
if (!start || !end) {
  console.error('사용법: npm run seed:gold -- "2026-07-04 20:00" "2026-07-04 21:00" [0.05] [0.80]');
  process.exit(1);
}

const startAt = DateTime.fromFormat(start, 'yyyy-LL-dd HH:mm', { zone: config.timezone });
const endAt = DateTime.fromFormat(end, 'yyyy-LL-dd HH:mm', { zone: config.timezone });
if (!startAt.isValid || !endAt.isValid || endAt <= startAt) {
  console.error('날짜 형식 또는 범위가 올바르지 않습니다.');
  process.exit(1);
}

const result = db.prepare(`
  INSERT INTO gold_slots(start_at, end_at, p_start, p_end)
  VALUES (?, ?, ?, ?)
`).run(startAt.toUTC().toISO(), endAt.toUTC().toISO(), Number(pStart), Number(pEnd));
console.log(`금 슬롯 생성 완료 id=${result.lastInsertRowid}`);
console.log(`${startAt.toISO()} ~ ${endAt.toISO()} / ${pStart} → ${pEnd}`);
db.close();
