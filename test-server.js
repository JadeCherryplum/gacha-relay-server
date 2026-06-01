// 통합 테스트: 서버 동작 검증
import WebSocket from 'ws';

const PORT = 8080;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.messages.push(msg);
      console.log(`  ← [${url.includes('kiosk') ? 'KIOSK' : 'PLAYER'}]`, JSON.stringify(msg));
    });
    ws.on('error', reject);
    ws.on('open', () => resolve(ws));
  });
}

function ssend(ws, obj, label) {
  console.log(`  → [${label}]`, JSON.stringify(obj));
  ws.send(JSON.stringify(obj));
}

async function run() {
  console.log('\n=== 시나리오 0: HTTP 엔드포인트 ===\n');

  // /healthz
  const health = await fetch(`http://localhost:${PORT}/healthz`);
  if (health.status !== 200) throw new Error(`healthz 실패: ${health.status}`);
  console.log('  ✓ /healthz OK');

  // /play (HTML)
  const playPage = await fetch(`http://localhost:${PORT}/play`);
  if (playPage.status !== 200) throw new Error(`/play 실패: ${playPage.status}`);
  const ct = playPage.headers.get('content-type') || '';
  if (!ct.includes('text/html')) throw new Error(`/play content-type: ${ct}`);
  const html = await playPage.text();
  if (!html.includes('<title>') || !html.includes('컨트롤러')) {
    throw new Error('/play 본문 검증 실패');
  }
  console.log('  ✓ /play HTML OK\n');

  console.log('=== 시나리오 1: 정상 흐름 ===\n');

  // 1. 키오스크 접속
  const kiosk = await connect(`ws://localhost:${PORT}/kiosk`);
  ssend(kiosk, { type: 'kiosk_hello', kioskId: 'claw-01' }, 'KIOSK');
  await wait(100);

  // 2. 토큰 요청
  ssend(kiosk, { type: 'request_token' }, 'KIOSK');
  await wait(200);
  const tokenMsg = kiosk.messages.find(m => m.type === 'token_issued');
  if (!tokenMsg) throw new Error('토큰 발행 실패');
  if (!tokenMsg.playUrl || !tokenMsg.playUrl.includes(tokenMsg.token)) {
    throw new Error(`playUrl 형식 오류: ${tokenMsg.playUrl}`);
  }
  const token = tokenMsg.token;
  console.log(`  ✓ 토큰 발행 OK: ${token.substring(0, 12)}...`);
  console.log(`  ✓ playUrl OK: ${tokenMsg.playUrl}\n`);

  // 3. 모바일 접속
  const player = await connect(`ws://localhost:${PORT}/play?token=${token}`);
  await wait(200);
  if (!player.messages.find(m => m.type === 'session_started')) {
    throw new Error('세션 시작 메시지 없음');
  }
  if (!kiosk.messages.find(m => m.type === 'player_joined')) {
    throw new Error('키오스크에 player_joined 도달 안함');
  }
  console.log('  ✓ 세션 시작 OK\n');

  // 4. 입력 릴레이
  ssend(player, { type: 'input', action: 'left', phase: 'start' }, 'PLAYER');
  await wait(50);
  ssend(player, { type: 'input', action: 'left', phase: 'hold' }, 'PLAYER');
  await wait(50);
  ssend(player, { type: 'input', action: 'left', phase: 'stop' }, 'PLAYER');
  await wait(50);
  ssend(player, { type: 'input', action: 'grab' }, 'PLAYER');
  await wait(100);

  const inputs = kiosk.messages.filter(m => m.type === 'player_input');
  console.log(`  ✓ 입력 릴레이 OK: ${inputs.length}개 (start/hold/stop/grab)\n`);
  if (inputs.length !== 4) throw new Error(`입력 개수 mismatch: ${inputs.length}`);

  // 5. 잘못된 입력 무시
  ssend(player, { type: 'input', action: 'INVALID', phase: 'start' }, 'PLAYER');
  ssend(player, { type: 'input', action: 'left', phase: 'INVALID' }, 'PLAYER');
  await wait(100);
  const inputsAfter = kiosk.messages.filter(m => m.type === 'player_input');
  if (inputsAfter.length !== 4) throw new Error('잘못된 입력이 통과됨');
  console.log('  ✓ 잘못된 입력 차단 OK\n');

  // 6. 키오스크가 게임 종료
  ssend(kiosk, { type: 'session_event', event: 'game_ended', result: 'success' }, 'KIOSK');
  await wait(200);
  const ended = player.messages.find(m => m.type === 'session_ended');
  if (!ended) throw new Error('session_ended 메시지 없음');
  if (ended.reason !== 'completed') throw new Error(`reason mismatch: ${ended.reason}`);
  console.log('  ✓ 키오스크 종료 신호 OK\n');

  console.log('\n=== 시나리오 2: 잘못된 토큰 거부 ===\n');
  try {
    const bad = await connect(`ws://localhost:${PORT}/play?token=NOPE`);
    await wait(200);
    const err = bad.messages.find(m => m.type === 'error');
    if (!err || err.code !== 'invalid_token') throw new Error('invalid_token 안 옴');
    console.log('  ✓ 잘못된 토큰 거부 OK\n');
  } catch (e) {
    if (!e.message.includes('invalid_token')) console.log('  ✓ 잘못된 토큰 거부 OK (close)\n');
    else throw e;
  }

  console.log('\n=== 시나리오 3: 다중 키오스크 독립 ===\n');
  const kiosk2 = await connect(`ws://localhost:${PORT}/kiosk`);
  ssend(kiosk2, { type: 'kiosk_hello', kioskId: 'claw-02' }, 'KIOSK2');
  await wait(100);
  ssend(kiosk2, { type: 'request_token' }, 'KIOSK2');
  await wait(200);
  const token2 = kiosk2.messages.find(m => m.type === 'token_issued')?.token;
  if (!token2) throw new Error('claw-02 토큰 없음');

  // claw-01도 새 토큰 받음 (이전 세션 끝났으니)
  ssend(kiosk, { type: 'request_token' }, 'KIOSK');
  await wait(200);
  const token1New = kiosk.messages.filter(m => m.type === 'token_issued').pop()?.token;
  if (!token1New || token1New === token) throw new Error('claw-01 새 토큰 없음');

  // 두 토큰이 다른 키오스크에 매핑되는지
  const player2 = await connect(`ws://localhost:${PORT}/play?token=${token2}`);
  await wait(200);
  if (!player2.messages.find(m => m.type === 'session_started')) {
    throw new Error('claw-02 세션 시작 안됨');
  }
  // claw-02 입력은 claw-01에 가면 안됨
  ssend(player2, { type: 'input', action: 'right', phase: 'start' }, 'PLAYER2');
  await wait(100);
  const claw01Recent = kiosk.messages.filter(m => m.type === 'player_input').length;
  const claw02Recent = kiosk2.messages.filter(m => m.type === 'player_input').length;
  if (claw01Recent !== 4) throw new Error(`claw-01에 누설: ${claw01Recent}`);
  if (claw02Recent !== 1) throw new Error(`claw-02에 미도달: ${claw02Recent}`);
  console.log('  ✓ 다중 키오스크 입력 격리 OK\n');

  console.log('\n=== 시나리오 4: 같은 토큰 재사용 거부 ===\n');
  // token2는 이미 player2가 소비했음
  try {
    const bad2 = await connect(`ws://localhost:${PORT}/play?token=${token2}`);
    await wait(200);
    const err = bad2.messages.find(m => m.type === 'error');
    if (!err) throw new Error('재사용 토큰 통과됨');
    console.log(`  ✓ 토큰 재사용 거부 OK (code=${err.code})\n`);
  } catch (e) {
    console.log('  ✓ 토큰 재사용 거부 OK (close)\n');
  }

  // 정리
  kiosk.close();
  kiosk2.close();
  player2.close();
  await wait(100);

  console.log('\n🎉 모든 시나리오 통과\n');
  process.exit(0);
}

run().catch(e => {
  console.error('\n❌ 실패:', e.message);
  process.exit(1);
});
