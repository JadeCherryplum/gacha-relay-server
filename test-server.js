import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import WebSocket from 'ws';

const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const DB_PATH = join(process.cwd(), 'data', 'integration-test.sqlite3');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const suffix of ['', '-shm', '-wal']) {
  try { rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch {}
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    BIND_HOST: '127.0.0.1',
    PUBLIC_BASE_URL: BASE,
    DB_PATH,
    ADMIN_PASSWORD: 'test-admin',
    OPEN_TIME: '00:00',
    CLOSE_TIME: '23:59',
    GRAB_RESOLVED_TIMEOUT_MS: '500',
    ANIMATION_DONE_TIMEOUT_MS: '500',
    START_TIMEOUT_MS: '150',
    HEARTBEAT_INTERVAL_MS: '60000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (data) => process.stdout.write(`  [server] ${data}`));
server.stderr.on('data', (data) => process.stderr.write(`  [server:err] ${data}`));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(fn, message, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = fn();
    if (value) return value;
    await wait(20);
  }
  throw new Error(message);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.on('message', (raw) => ws.messages.push(JSON.parse(raw.toString())));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {}
    await wait(50);
  }
  throw new Error('서버 부팅 실패');
}

async function adminLogin() {
  const response = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=test-admin',
  });
  assert(response.status === 303, `관리자 로그인 실패 ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}

async function seedGold(cookie) {
  const now = DateTime.utc();
  const response = await fetch(`${BASE}/admin/slots/seed`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slots: [{
        startAt: now.minus({ minutes: 1 }).toISO(),
        endAt: now.plus({ minutes: 5 }).toISO(),
        pStart: 1,
        pEnd: 1,
      }],
    }),
  });
  assert(response.status === 201, `금 슬롯 시드 실패 ${response.status}`);
}

async function createPlayable(kioskId) {
  const kiosk = await connect(`${WS}/kiosk`);
  send(kiosk, { type: 'kiosk_hello', kioskId });
  await wait(30);
  send(kiosk, { type: 'request_token' });
  const issued = await waitFor(() => kiosk.messages.find((m) => m.type === 'token_issued'), `${kioskId} 토큰 없음`);
  const player = await connect(`${WS}/play?token=${issued.token}`);
  await waitFor(() => player.messages.find((m) => m.type === 'claimed'), `${kioskId} 토큰 선점 없음`);
  await waitFor(() => kiosk.messages.find((m) => m.type === 'player_claimed'), `${kioskId} player_claimed 없음`);
  send(player, { type: 'start' });
  const started = await waitFor(() => player.messages.find((m) => m.type === 'session_started'), `${kioskId} 세션 시작 없음`);
  return { kiosk, player, started };
}

async function completeGrab(pair, sendAnimation = true) {
  send(pair.player, { type: 'input', action: 'grab' });
  await waitFor(() => pair.kiosk.messages.find((m) => m.type === 'player_input' && m.action === 'grab'), 'grab 릴레이 없음');
  send(pair.kiosk, { type: 'session_event', event: 'grab_resolved' });
  const result = await waitFor(() => pair.kiosk.messages.find((m) => m.type === 'grab_result'), 'grab_result 없음');
  if (sendAnimation) {
    send(pair.kiosk, { type: 'session_event', event: 'result_visible' });
    send(pair.kiosk, { type: 'session_event', event: 'animation_done' });
  }
  return result;
}

async function run() {
  await waitForHealth();
  console.log('\n=== HTTP 및 관리자 인증 ===');
  const page = await fetch(`${BASE}/play`);
  assert(page.ok && (await page.text()).includes('결과 확인 중'), '모바일 페이지 검증 실패');
  const cookie = await adminLogin();
  await seedGold(cookie);
  console.log('  ✓ 관리자 로그인 및 금 슬롯 시드');

  console.log('\n=== 정상 흐름, 결과 복구, 수령 처리 ===');
  const first = await createPlayable('claw-01');
  send(first.player, { type: 'input', action: 'grab' });
  send(first.player, { type: 'input', action: 'grab' });
  await wait(80);
  assert(first.kiosk.messages.filter((m) => m.type === 'player_input' && m.action === 'grab').length === 1, 'grab 1회 제한 실패');
  send(first.kiosk, { type: 'session_event', event: 'grab_resolved' });
  const firstResult = await waitFor(() => first.kiosk.messages.find((m) => m.type === 'grab_result'), '첫 판정 없음');
  assert(firstResult.result === 'gold', `예상 gold, 실제 ${firstResult.result}`);
  send(first.kiosk, { type: 'session_event', event: 'result_visible' });
  const mobileResult = await waitFor(() => first.player.messages.find((m) => m.type === 'result'), '모바일 결과 없음');
  send(first.kiosk, { type: 'session_event', event: 'animation_done' });
  assert(mobileResult.result === 'gold' && mobileResult.claimUrl, '금 결과/수령 URL 없음');

  const resultToken = new URL(first.started.resultUrl).searchParams.get('result');
  assert((await fetch(`${BASE}/api/results/${resultToken}`)).status === 200, '결과 복구 실패');
  const claimPath = new URL(mobileResult.claimUrl).pathname;
  assert((await fetch(`${BASE}${claimPath}`)).status === 401, '미인증 수령 접근 차단 실패');
  const claimPage = await fetch(`${BASE}${claimPath}`, { headers: { Cookie: cookie } });
  assert(claimPage.ok && (await claimPage.text()).includes('GOLD'), '운영자 수령 확인 실패');
  const complete = await fetch(`${BASE}${claimPath}/complete`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } });
  assert(complete.status === 303, '수령 완료 처리 실패');
  assert((await fetch(`${BASE}/api/results/${resultToken}`)).status === 410, '수령 후 결과 링크 만료 실패');
  const claimedPage = await fetch(`${BASE}${claimPath}`, { headers: { Cookie: cookie } });
  assert((await claimedPage.text()).includes('이미 수령 완료'), '수령 QR 재스캔 상태 실패');
  console.log('  ✓ 정상 판정, 복구 링크, 수령 완료, 즉시 만료');

  console.log('\n=== 동시 금 당첨 방지 ===');
  await seedGold(cookie);
  const left = await createPlayable('claw-02');
  const right = await createPlayable('claw-03');
  send(left.player, { type: 'input', action: 'grab' });
  send(right.player, { type: 'input', action: 'grab' });
  await wait(50);
  send(left.kiosk, { type: 'session_event', event: 'grab_resolved' });
  send(right.kiosk, { type: 'session_event', event: 'grab_resolved' });
  const [leftResult, rightResult] = await Promise.all([
    waitFor(() => left.kiosk.messages.find((m) => m.type === 'grab_result'), '왼쪽 결과 없음'),
    waitFor(() => right.kiosk.messages.find((m) => m.type === 'grab_result'), '오른쪽 결과 없음'),
  ]);
  assert([leftResult.result, rightResult.result].filter((x) => x === 'gold').length === 1, '동시 gold 중복 당첨');
  send(left.kiosk, { type: 'session_event', event: 'result_visible' });
  send(right.kiosk, { type: 'session_event', event: 'result_visible' });
  send(left.kiosk, { type: 'session_event', event: 'animation_done' });
  send(right.kiosk, { type: 'session_event', event: 'animation_done' });
  console.log('  ✓ 동시 요청 중 정확히 1건만 gold');

  console.log('\n=== 시작 버튼 미입력 타임아웃 ===');
  const idleKiosk = await connect(`${WS}/kiosk`);
  send(idleKiosk, { type: 'kiosk_hello', kioskId: 'claw-idle' });
  await wait(30);
  send(idleKiosk, { type: 'request_token' });
  const idleIssued = await waitFor(() => idleKiosk.messages.find((m) => m.type === 'token_issued'), 'idle 토큰 없음');
  const idlePlayer = await connect(`${WS}/play?token=${idleIssued.token}`);
  await waitFor(() => idlePlayer.messages.find((m) => m.type === 'claimed'), 'idle claimed 없음');
  const idleEnded = await waitFor(() => idlePlayer.messages.find((m) => m.type === 'session_ended'), '시작 미입력 종료 없음');
  assert(idleEnded.reason === 'start_timeout', `예상 start_timeout, 실제 ${idleEnded.reason}`);
  await waitFor(() => idleKiosk.messages.find((m) => m.type === 'player_left' && m.reason === 'start_timeout'), '시작 미입력 player_left 없음');
  console.log('  ✓ 시작 미입력 시 세션 종료');

  console.log('\n=== grab_resolved 타임아웃 ===');
  const timeoutPair = await createPlayable('claw-04');
  send(timeoutPair.player, { type: 'input', action: 'grab' });
  const timeoutError = await waitFor(() => timeoutPair.player.messages.find((m) => m.type === 'error'), '타임아웃 오류 없음', 2000);
  assert(timeoutError.code === 'grab_resolved_timeout', `타임아웃 코드 오류 ${timeoutError.code}`);
  const timeoutToken = new URL(timeoutPair.started.resultUrl).searchParams.get('result');
  assert((await fetch(`${BASE}/api/results/${timeoutToken}`)).status === 410, '타임아웃 결과 링크 만료 실패');
  console.log('  ✓ 추첨 없이 오류 종료');

  console.log('\n=== animation_done 타임아웃 ===');
  const animationPair = await createPlayable('claw-05');
  const animationResult = await completeGrab(animationPair, false);
  const animationMobileResult = await waitFor(
    () => animationPair.player.messages.find((m) => m.type === 'result'),
    'animation_done 타임아웃 후 모바일 결과 없음',
    2000,
  );
  assert(animationMobileResult.result === animationResult.result, 'animation_done 타임아웃 결과 불일치');
  console.log('  ✓ 확정 결과 유지 후 모바일 전달');

  try { idlePlayer.close(); idleKiosk.close(); } catch {}
  for (const pair of [first, left, right, timeoutPair, animationPair]) {
    try { pair.player.close(); pair.kiosk.close(); } catch {}
  }
  console.log('\n모든 통합 테스트 통과');
}

run().catch((error) => {
  console.error('\n통합 테스트 실패:', error.stack ?? error.message);
  process.exitCode = 1;
}).finally(async () => {
  server.kill('SIGTERM');
  await wait(200);
});
