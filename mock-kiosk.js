// Mock Kiosk — 유니티 키오스크 흉내
//
// 실제 키오스크가 해야 할 일을 그대로 시뮬레이션:
//   - /kiosk에 접속 + kiosk_hello
//   - 토큰 받아 콘솔에 ASCII QR로 표시
//   - 모바일 입력 받으면 콘솔에 출력
//   - 세션 종료되면 자동으로 새 토큰 요청
//   - 연결 끊기면 지수 백오프로 재연결
//   - ping 자동 응답
//
// 사용법:
//   node mock-kiosk.js
//   node mock-kiosk.js --id claw-02
//   node mock-kiosk.js --server ws://192.168.0.100:8080
//   node mock-kiosk.js --auto-grab 5    # 모바일 없이 5초 후 grab 입력을 흉내냄

import WebSocket from 'ws';
import qrcode from 'qrcode-terminal';

// ─── 인자 파싱 ────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : defaultValue;
}

const KIOSK_ID = getArg('id', 'claw-01');
const SERVER = getArg('server', 'ws://localhost:8080');
const AUTO_GRAB_AFTER = parseInt(getArg('auto-grab', '0'), 10); // 0이면 비활성
const DEBUG = args.includes('--debug');

// ─── 색상 / 출력 ─────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (tag, color, ...args) =>
  console.log(`${C.dim}${ts()}${C.reset} ${color}[${tag}]${C.reset}`, ...args);

const info  = (...a) => log('INFO',    C.cyan,    ...a);
const ok    = (...a) => log('OK',      C.green,   ...a);
const warn  = (...a) => log('WARN',    C.yellow,  ...a);
const err   = (...a) => log('ERR',     C.red,     ...a);
const event = (...a) => log('EVENT',   C.magenta, ...a);
const input = (...a) => log('INPUT',   C.blue,    ...a);

// ─── 상태 ─────────────────────────────────────────────
let ws = null;
let reconnectAttempt = 0;
let currentToken = null;
let sessionActive = false;
let autoGrabTimer = null;

// ─── QR 출력 ─────────────────────────────────────────
function printQR(playUrl) {
  console.log('\n' + C.bold + '━'.repeat(60) + C.reset);
  console.log(C.bold + `  키오스크: ${KIOSK_ID}` + C.reset);
  console.log(C.bold + `  스캔하세요 ↓` + C.reset);
  console.log('');
  qrcode.generate(playUrl, { small: true });
  console.log(`  URL: ${C.cyan}${playUrl}${C.reset}`);
  console.log(C.bold + '━'.repeat(60) + C.reset + '\n');
}

// ─── 메시지 송신 ──────────────────────────────────────
function send(obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { err('send 실패:', e.message); }
}

// ─── 메시지 처리 ──────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'token_issued': {
      currentToken = msg.token;
      ok(`토큰 발행됨 (만료 ${msg.expiresIn}초)`);
      printQR(msg.playUrl);
      break;
    }

    case 'player_joined': {
      sessionActive = true;
      event(`${C.bold}모바일 접속${C.reset} sessionId=${msg.sessionId.substring(0, 8)}...`);

      // auto-grab 옵션: 일정 시간 후 키오스크 쪽 잡기 완료를 시뮬레이션
      if (AUTO_GRAB_AFTER > 0) {
        info(`${AUTO_GRAB_AFTER}초 후 자동 grab_resolved 시뮬레이션 예정`);
        autoGrabTimer = setTimeout(() => {
          if (sessionActive) {
            warn('[시뮬레이션] grab_resolved 신호 송출');
            send({ type: 'session_event', event: 'grab_resolved' });
          }
        }, AUTO_GRAB_AFTER * 1000);
      }
      break;
    }

    case 'player_input': {
      // 입력 시각화 (방향키 화살표로)
      const arrow = {
        left: '◀', right: '▶', up: '▲', down: '▼', grab: '🤖',
      }[msg.action] ?? msg.action;
      const phaseTag = msg.phase ? ` ${msg.phase}` : '';
      input(`${arrow} ${msg.action}${phaseTag}`);
      if (msg.action === 'grab') {
        setTimeout(() => send({ type: 'session_event', event: 'grab_resolved' }), 1000);
      }
      break;
    }

    case 'grab_result': {
      event(`서버 판정 결과: ${C.bold}${msg.result}${C.reset}`);
      setTimeout(() => send({ type: 'session_event', event: 'animation_done' }), 1500);
      break;
    }

    case 'player_left': {
      sessionActive = false;
      currentToken = null;
      if (autoGrabTimer) { clearTimeout(autoGrabTimer); autoGrabTimer = null; }

      const reasonColor = msg.reason === 'completed' ? C.green : C.yellow;
      event(`모바일 종료 ${reasonColor}reason=${msg.reason}${C.reset}`);

      // 자동으로 새 토큰 요청 (다음 손님 받을 준비)
      info('새 토큰 요청...');
      setTimeout(() => send({ type: 'request_token' }), 500);
      break;
    }

    default:
      warn('알 수 없는 메시지:', JSON.stringify(msg));
  }
}

// ─── 연결 / 재연결 ────────────────────────────────────
function connect() {
  const wsUrl = `${SERVER}/kiosk`;
  info(`연결 시도: ${wsUrl}`);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    reconnectAttempt = 0;
    ok(`연결됨 (kioskId=${KIOSK_ID})`);
    send({ type: 'kiosk_hello', kioskId: KIOSK_ID });
    // hello 보내자마자 토큰 요청
    setTimeout(() => send({ type: 'request_token' }), 200);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(msg);
  });

  // ws 라이브러리는 ping을 받으면 자동으로 pong 응답함 (RFC 6455 spec).
  // 명시적 핸들러가 없을 때만 자동 응답하므로, ping 핸들러는 일부러 안 둔다.

  ws.on('close', (code, reason) => {
    sessionActive = false;
    currentToken = null;
    if (autoGrabTimer) { clearTimeout(autoGrabTimer); autoGrabTimer = null; }

    warn(`연결 끊김 code=${code} reason=${reason || '(없음)'}`);
    scheduleReconnect();
  });

  ws.on('error', (e) => {
    err('소켓 에러:', e.message);
    // close가 따라오므로 재연결은 close에서 처리
  });
}

function scheduleReconnect() {
  reconnectAttempt++;
  // 지수 백오프: 1s, 2s, 5s, 10s, 이후 10s 고정
  const delays = [1000, 2000, 5000, 10000];
  const delay = delays[Math.min(reconnectAttempt - 1, delays.length - 1)];
  info(`${delay / 1000}초 후 재연결 시도 (#${reconnectAttempt})...`);
  setTimeout(connect, delay);
}

// ─── 종료 처리 ────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n');
  info('종료 중...');
  if (autoGrabTimer) clearTimeout(autoGrabTimer);
  if (ws) ws.close();
  process.exit(0);
});

// ─── 시작 ─────────────────────────────────────────────
console.log(C.bold + `\n=== Mock Kiosk: ${KIOSK_ID} ===` + C.reset);
console.log(`서버: ${SERVER}`);
if (AUTO_GRAB_AFTER > 0) {
  console.log(`자동 grab_resolved: ${AUTO_GRAB_AFTER}초 후`);
}
console.log('Ctrl+C로 종료\n');

connect();
