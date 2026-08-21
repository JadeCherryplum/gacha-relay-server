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
    SILVER_P_START: '1',
    SILVER_P_END: '1',
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
  throw new Error('server boot failed');
}

async function adminLogin() {
  const response = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=test-admin',
  });
  assert(response.status === 303, `admin login failed ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}

async function seedGold(cookie, count = 1) {
  const now = DateTime.utc();
  const slots = Array.from({ length: count }, (_, index) => ({
    startAt: now.minus({ minutes: 1 }).plus({ seconds: index }).toISO(),
    endAt: now.plus({ minutes: 5 }).toISO(),
    pStart: 1,
    pEnd: 1,
  }));
  const response = await fetch(`${BASE}/admin/slots/seed`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slots }),
  });
  assert(response.status === 201, `gold slot seed failed ${response.status}`);
}

async function createPlayable(kioskId) {
  const kiosk = await connect(`${WS}/kiosk`);
  send(kiosk, { type: 'kiosk_hello', kioskId });
  await wait(30);
  send(kiosk, { type: 'request_token' });
  const issued = await waitFor(() => kiosk.messages.find((m) => m.type === 'token_issued'), `${kioskId} token missing`);
  const player = await connect(`${WS}/play?token=${issued.token}`);
  await waitFor(() => player.messages.find((m) => m.type === 'claimed'), `${kioskId} claimed missing`);
  await waitFor(() => kiosk.messages.find((m) => m.type === 'player_claimed'), `${kioskId} player_claimed missing`);
  send(player, { type: 'start' });
  const started = await waitFor(() => player.messages.find((m) => m.type === 'session_started'), `${kioskId} session start missing`);
  return { kiosk, player, started };
}

async function completeGrab(pair, { grabbed = true, reveal = true, done = true } = {}) {
  send(pair.player, { type: 'input', action: 'grab' });
  await waitFor(() => pair.kiosk.messages.find((m) => m.type === 'player_input' && m.action === 'grab'), 'grab relay missing');
  send(pair.kiosk, { type: 'session_event', event: 'grab_resolved', grabbed });
  const result = await waitFor(() => pair.kiosk.messages.find((m) => m.type === 'grab_result'), 'grab_result missing');
  if (reveal) send(pair.kiosk, { type: 'session_event', event: 'result_visible' });
  if (done) send(pair.kiosk, { type: 'session_event', event: 'animation_done' });
  return result;
}

async function run() {
  await waitForHealth();
  console.log('\n=== HTTP and admin ===');
  const page = await fetch(`${BASE}/play`);
  assert(page.ok && (await page.text()).includes('결과 확인 중'), 'mobile page failed');
  const previewPage = await fetch(`${BASE}/play-test`);
  assert(previewPage.ok && (await previewPage.text()).includes('/play?preview=start'), 'mobile preview page failed');
  const previewMode = await fetch(`${BASE}/play?preview=gold`);
  assert(previewMode.ok && (await previewMode.text()).includes('const preview'), 'mobile preview mode failed');
  const timerFont = await fetch(`${BASE}/gui/Font/GapyeongHanseokbongB.otf`);
  assert(timerFont.ok && timerFont.headers.get('content-type') === 'font/otf', 'timer font asset failed');
  const artifacts = await (await fetch(`${BASE}/artifacts.json`)).json();
  assert(artifacts.artifacts.length === 19, 'artifact count must be 19');
  const cookie = await adminLogin();
  await seedGold(cookie, 3);
  const admin = await fetch(`${BASE}/admin`, { headers: { Cookie: cookie } });
  const adminHtml = await admin.text();
  assert(admin.ok && adminHtml.includes('상품별 재고 현황'), 'admin inventory failed');
  console.log('  ✓ admin and artifact data');

  console.log('\n=== gold count and claim ===');
  const goldPairs = [];
  for (let i = 0; i < 3; i += 1) {
    const pair = await createPlayable(`claw-gold-${i}`);
    goldPairs.push(pair);
    await completeGrab(pair);
  }
  const goldResults = goldPairs.map((pair) => pair.kiosk.messages.find((m) => m.type === 'grab_result'));
  assert(goldResults.every((m) => m.result === 'gold'), 'seeded gold slots should all award gold');
  assert(goldResults.every((m) => m.prizeId === 'gold_crystal_led_tower' && m.prizeName), 'gold prize payload missing');
  const goldMobile = await waitFor(() => goldPairs[0].player.messages.find((m) => m.type === 'result'), 'gold mobile result missing');
  assert(goldMobile.result === 'gold' && goldMobile.claimUrl && goldMobile.prizeName, 'gold mobile payload missing');
  const claimPath = new URL(goldMobile.claimUrl).pathname;
  assert((await fetch(`${BASE}${claimPath}`)).status === 401, 'claim auth guard failed');
  const claimPage = await fetch(`${BASE}${claimPath}`, { headers: { Cookie: cookie } });
  assert(claimPage.ok && (await claimPage.text()).includes('크리스탈 LED 정림사지 오층석탑'), 'claim prize name missing');
  const complete = await fetch(`${BASE}${claimPath}/complete`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } });
  assert(complete.status === 303, 'claim complete failed');
  console.log('  ✓ gold inventory and claim');

  console.log('\n=== silver weighted inventory ===');
  const silverPairs = [];
  for (let i = 0; i < 7; i += 1) {
    const pair = await createPlayable(`claw-silver-${i}`);
    silverPairs.push(pair);
    await completeGrab(pair);
  }
  const silverResults = silverPairs.map((pair) => pair.kiosk.messages.find((m) => m.type === 'grab_result'));
  assert(silverResults.every((m) => m.result === 'silver' && m.prizeId && m.prizeName), 'silver prize payload missing');
  const counts = silverResults.reduce((map, result) => map.set(result.prizeId, (map.get(result.prizeId) ?? 0) + 1), new Map());
  assert(counts.get('usb') === 3, 'usb daily count mismatch');
  assert(['gyeyangbae', 'wooden_pillow', 'handkerchief', 'ceramic_lunchbox'].every((id) => counts.get(id) === 1), 'single silver count mismatch');
  const noSilver = await createPlayable('claw-silver-empty');
  const noSilverResult = await completeGrab(noSilver);
  assert(noSilverResult.result === 'fail' && !noSilverResult.prizeId && noSilverResult.artifactIndex !== null, 'silver depletion should fall back to artifact result');
  console.log('  ✓ silver inventory depletion');

  console.log('\n=== start timeout and physical fail ===');
  const idleKiosk = await connect(`${WS}/kiosk`);
  send(idleKiosk, { type: 'kiosk_hello', kioskId: 'claw-idle' });
  await wait(30);
  send(idleKiosk, { type: 'request_token' });
  const idleIssued = await waitFor(() => idleKiosk.messages.find((m) => m.type === 'token_issued'), 'idle token missing');
  const idlePlayer = await connect(`${WS}/play?token=${idleIssued.token}`);
  await waitFor(() => idlePlayer.messages.find((m) => m.type === 'claimed'), 'idle claimed missing');
  const idleEnded = await waitFor(() => idlePlayer.messages.find((m) => m.type === 'session_ended'), 'start timeout missing');
  assert(idleEnded.reason === 'start_timeout', 'start timeout reason mismatch');

  const failPair = await createPlayable('claw-fail');
  const failServerResult = await completeGrab(failPair, { grabbed: false });
  assert(failServerResult.result === 'fail' && failServerResult.artifactIndex == null && !failServerResult.prizeId, 'physical fail result mismatch');
  const failMobileResult = await waitFor(() => failPair.player.messages.find((m) => m.type === 'result'), 'physical fail mobile result missing');
  assert(failMobileResult.result === 'fail' && failMobileResult.artifactIndex == null, 'physical fail mobile mismatch');
  console.log('  ✓ timeout and physical fail');

  console.log('\n=== result fallback ===');
  const fallbackPair = await createPlayable('claw-fallback');
  const fallbackResult = await completeGrab(fallbackPair, { reveal: false, done: false });
  send(fallbackPair.kiosk, { type: 'session_event', event: 'animation_done' });
  const fallbackMobile = await waitFor(() => fallbackPair.player.messages.find((m) => m.type === 'result'), 'animation_done fallback missing');
  assert(fallbackMobile.result === fallbackResult.result, 'animation_done fallback mismatch');
  console.log('  ✓ animation_done fallback');

  try { idlePlayer.close(); idleKiosk.close(); } catch {}
  for (const pair of [...goldPairs, ...silverPairs, noSilver, failPair, fallbackPair]) {
    try { pair.player.close(); pair.kiosk.close(); } catch {}
  }
  console.log('\nAll integration tests passed');
}

run().catch((error) => {
  console.error('\nIntegration test failed:', error.stack ?? error.message);
  process.exitCode = 1;
}).finally(async () => {
  server.kill('SIGTERM');
  await wait(200);
});
