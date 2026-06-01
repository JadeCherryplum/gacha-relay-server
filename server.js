// 클로 머신 키오스크 — 중계 서버 v2 (1차)
//
// 단일 파일 구성. 동작 검증 후 모듈로 쪼갤 예정.
//
// 엔드포인트:
//   GET  /healthz                 헬스체크
//   WS   /kiosk                   키오스크 연결 (다수 가능, kioskId로 구분)
//   WS   /play?token=XXX          모바일 플레이어 1회 접속

import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const TOKEN_TTL_SECONDS = parseInt(process.env.TOKEN_TTL_SECONDS ?? '300', 10);
const SESSION_DURATION_SECONDS = parseInt(process.env.SESSION_DURATION_SECONDS ?? '60', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? '15000', 10);
const RATE_LIMIT_PER_SEC = parseInt(process.env.RATE_LIMIT_PER_SEC ?? '30', 10);

// 입력 메시지를 로그에 찍을지 여부 (테스트용, 운영에선 끄는 게 좋음)
const DEBUG_INPUT = process.env.DEBUG_INPUT === '1' || process.env.DEBUG_INPUT === 'true';

// 바인딩 호스트.
//   운영(AWS+Caddy):  127.0.0.1  ← 기본값. Caddy가 같은 머신에서 프록시하므로 외부 노출 불필요.
//   로컬 내부망 테스트: 0.0.0.0   ← .env에 BIND_HOST=0.0.0.0 명시.
// 방어선을 한 겹 더 두는 차원. 방화벽 실수 시에도 8080이 인터넷에 그대로 노출되지 않게.
const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1';

// QR에 들어갈 base URL. 키오스크가 토큰 받을 때 이 값을 함께 받아서 QR을 만든다.
// 내부망 테스트: http://192.168.0.100:8080
// 운영: https://your-domain
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

// ─────────────────────────────────────────────────────────────────
// 프로토콜 상수
// ─────────────────────────────────────────────────────────────────

// 키오스크 → 서버
const KIOSK_HELLO = 'kiosk_hello';
const REQUEST_TOKEN = 'request_token';
const SESSION_EVENT = 'session_event';

// 서버 → 키오스크
const TOKEN_ISSUED = 'token_issued';
const PLAYER_JOINED = 'player_joined';
const PLAYER_INPUT = 'player_input';
const PLAYER_LEFT = 'player_left';

// 모바일 → 서버
const INPUT = 'input';

// 서버 → 모바일
const SESSION_STARTED = 'session_started';
const TICK = 'tick';
const SESSION_ENDED = 'session_ended';
const ERROR = 'error';

// 화이트리스트
const VALID_ACTIONS = new Set(['left', 'right', 'up', 'down', 'grab']);
const VALID_PHASES = new Set(['start', 'hold', 'stop']);

// 에러 코드
const ERR_INVALID_TOKEN = 'invalid_token';
const ERR_KIOSK_OFFLINE = 'kiosk_offline';
const ERR_ALREADY_IN_USE = 'already_in_use';
const ERR_BAD_REQUEST = 'bad_request';

// ─────────────────────────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────────────────────────

// kioskId → KioskState
//   KioskState: {
//     socket,            현재 연결된 키오스크 WebSocket
//     pendingToken,      { token, expiresAt } | null
//     activeSession,     { token, playerSocket, startedAt, timer, tickInterval, msgCount } | null
//   }
const kiosks = new Map();

// 토큰 → kioskId 역인덱스 (모바일이 토큰만 들고 와도 어느 키오스크 건지 찾기 위함)
const tokenIndex = new Map();

// ─────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────

function send(ws, obj) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
    }
}

function generateToken() {
    return randomBytes(16).toString('base64url');
}

function log(tag, ...args) {
    console.log(`[${tag}]`, ...args);
}

function getKiosk(kioskId) {
    return kiosks.get(kioskId);
}

function isKioskOnline(kioskId) {
    const k = kiosks.get(kioskId);
    return !!(k && k.socket && k.socket.readyState === 1);
}

// ─────────────────────────────────────────────────────────────────
// 토큰
// ─────────────────────────────────────────────────────────────────

function issueToken(kioskId) {
    const kiosk = kiosks.get(kioskId);
    if (!kiosk) return null;

    // 기존 미사용 토큰이 있으면 폐기
    if (kiosk.pendingToken) {
        tokenIndex.delete(kiosk.pendingToken.token);
    }

    const token = generateToken();
    const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
    kiosk.pendingToken = { token, expiresAt };
    tokenIndex.set(token, kioskId);

    return { token, expiresIn: TOKEN_TTL_SECONDS };
}

// 토큰 검증 + 즉시 소비. 성공 시 kioskId, 실패 시 null.
function consumeToken(token) {
    const kioskId = tokenIndex.get(token);
    if (!kioskId) return null;

    const kiosk = kiosks.get(kioskId);
    if (!kiosk || !kiosk.pendingToken) {
        tokenIndex.delete(token);
        return null;
    }

    if (kiosk.pendingToken.token !== token) return null;

    if (Date.now() >= kiosk.pendingToken.expiresAt) {
        tokenIndex.delete(token);
        kiosk.pendingToken = null;
        return null;
    }

    // 소비
    tokenIndex.delete(token);
    kiosk.pendingToken = null;
    return kioskId;
}

// ─────────────────────────────────────────────────────────────────
// 세션
// ─────────────────────────────────────────────────────────────────

function startSession(kioskId, token, playerSocket) {
    const kiosk = kiosks.get(kioskId);
    if (!kiosk) return;

    const session = {
        token,
        playerSocket,
        startedAt: Date.now(),
        timer: null,
        tickInterval: null,
        // rate limit용 슬라이딩 카운터
        rateWindow: Date.now(),
        rateCount: 0,
    };
    kiosk.activeSession = session;

    // 양쪽에 시작 알림
    send(playerSocket, { type: SESSION_STARTED, duration: SESSION_DURATION_SECONDS });
    send(kiosk.socket, { type: PLAYER_JOINED, sessionId: token });

    // 1초 tick
    session.tickInterval = setInterval(() => {
        const elapsed = (Date.now() - session.startedAt) / 1000;
        const remaining = Math.max(0, Math.ceil(SESSION_DURATION_SECONDS - elapsed));
        if (remaining > 0) {
            send(playerSocket, { type: TICK, remaining });
        }
    }, 1000);

    // 하드 타임아웃
    session.timer = setTimeout(() => {
        endSession(kioskId, 'timeout');
    }, SESSION_DURATION_SECONDS * 1000);

    log('session', `시작 kioskId=${kioskId} token=${token}`);
}

function endSession(kioskId, reason, result = null) {
    const kiosk = kiosks.get(kioskId);
    if (!kiosk || !kiosk.activeSession) return;

    const session = kiosk.activeSession;
    clearTimeout(session.timer);
    clearInterval(session.tickInterval);

    // 모바일 알림 + close
    send(session.playerSocket, { type: SESSION_ENDED, reason, result });
    if (session.playerSocket && session.playerSocket.readyState === 1) {
        session.playerSocket.close(1000, 'session_ended');
    }

    // 키오스크 알림 (단, 키오스크 끊김 사유면 키오스크 소켓이 없음)
    if (reason !== 'kiosk_lost' && isKioskOnline(kioskId)) {
        send(kiosk.socket, { type: PLAYER_LEFT, reason });
    }

    kiosk.activeSession = null;
    log('session', `종료 kioskId=${kioskId} reason=${reason}`);
}

// ─────────────────────────────────────────────────────────────────
// Rate limit
// ─────────────────────────────────────────────────────────────────

// 1초 윈도우 내 메시지 카운트. 초과하면 false 리턴 (드롭).
function checkRate(session) {
    const now = Date.now();
    if (now - session.rateWindow >= 1000) {
        session.rateWindow = now;
        session.rateCount = 0;
    }
    session.rateCount++;
    return session.rateCount <= RATE_LIMIT_PER_SEC;
}

// ─────────────────────────────────────────────────────────────────
// 키오스크 핸들러
// ─────────────────────────────────────────────────────────────────

function handleKioskConnection(ws) {
    let kioskId = null;
    let authed = false;

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return; // 조용히 무시
        }

        // 첫 메시지는 반드시 kiosk_hello
        if (!authed) {
            if (msg.type !== KIOSK_HELLO || typeof msg.kioskId !== 'string' || !msg.kioskId.trim()) {
                log('kiosk', 'hello 형식 오류');
                ws.close(1008, 'bad_hello');
                return;
            }

            kioskId = msg.kioskId.trim();
            authed = true;

            // 같은 kioskId로 이미 연결된 게 있으면 갈아끼움 (last-write-wins)
            const existing = kiosks.get(kioskId);
            if (existing && existing.socket && existing.socket !== ws) {
                log('kiosk', `${kioskId} 기존 연결 교체`);
                // 진행 중 세션이 있다면 종료
                if (existing.activeSession) {
                    endSession(kioskId, 'kiosk_lost');
                }
                try {
                    existing.socket.close(1000, 'replaced');
                } catch { }
            }

            kiosks.set(kioskId, {
                socket: ws,
                pendingToken: existing?.pendingToken ?? null,
                activeSession: null,
            });

            log('kiosk', `${kioskId} 연결됨`);
            return;
        }

        handleKioskMessage(kioskId, msg);
    });

    ws.on('close', () => {
        if (!kioskId) return;
        const kiosk = kiosks.get(kioskId);
        if (!kiosk || kiosk.socket !== ws) return; // 이미 교체된 경우

        log('kiosk', `${kioskId} 연결 종료`);

        // 진행 중 세션 종료
        if (kiosk.activeSession) {
            endSession(kioskId, 'kiosk_lost');
        }
        // 미사용 토큰도 폐기
        if (kiosk.pendingToken) {
            tokenIndex.delete(kiosk.pendingToken.token);
        }
        kiosks.delete(kioskId);
    });

    ws.on('error', (err) => {
        log('kiosk', `소켓 에러 (${kioskId ?? 'unknown'}):`, err.message);
    });
}

function handleKioskMessage(kioskId, msg) {
    const kiosk = kiosks.get(kioskId);
    if (!kiosk) return;

    switch (msg.type) {
        case REQUEST_TOKEN: {
            if (kiosk.activeSession) {
                // 진행 중인데 새 토큰 요청은 의도와 어긋남
                log('kiosk', `${kioskId} 세션 중 토큰 요청 거부`);
                return;
            }
            const result = issueToken(kioskId);
            if (result) {
                // 키오스크가 그대로 QR로 만들 수 있도록 완전한 URL을 함께 보냄
                const playUrl = `${PUBLIC_BASE_URL}/play?token=${result.token}`;
                send(kiosk.socket, {
                    type: TOKEN_ISSUED,
                    token: result.token,
                    expiresIn: result.expiresIn,
                    playUrl,
                });
                log('kiosk', `${kioskId} 토큰 발행 ${result.token.substring(0, 8)}...`);
            }
            break;
        }

        case SESSION_EVENT: {
            if (msg.event === 'game_ended' && kiosk.activeSession) {
                endSession(kioskId, 'completed', msg.result ?? null);
            }
            break;
        }

        default:
            break;
    }
}

// ─────────────────────────────────────────────────────────────────
// 모바일 플레이어 핸들러
// ─────────────────────────────────────────────────────────────────

function handlePlayerConnection(ws, token) {
    // 1. 토큰으로 kioskId 찾기 + 소비
    const kioskId = consumeToken(token);
    if (!kioskId) {
        send(ws, { type: ERROR, code: ERR_INVALID_TOKEN });
        ws.close(1008, ERR_INVALID_TOKEN);
        return;
    }

    // 2. 키오스크가 살아있어야 함
    if (!isKioskOnline(kioskId)) {
        send(ws, { type: ERROR, code: ERR_KIOSK_OFFLINE });
        ws.close(1011, ERR_KIOSK_OFFLINE);
        return;
    }

    // 3. 같은 키오스크에 이미 세션이 있으면 거부
    const kiosk = kiosks.get(kioskId);
    if (kiosk.activeSession) {
        send(ws, { type: ERROR, code: ERR_ALREADY_IN_USE });
        ws.close(1008, ERR_ALREADY_IN_USE);
        return;
    }

    // 통과 → 세션 시작
    startSession(kioskId, token, ws);

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        handlePlayerMessage(kioskId, ws, msg);
    });

    ws.on('close', () => {
        const k = kiosks.get(kioskId);
        if (k && k.activeSession && k.activeSession.playerSocket === ws) {
            log('player', `연결 종료, 세션 중단 kioskId=${kioskId}`);
            endSession(kioskId, 'disconnect');
        }
    });

    ws.on('error', (err) => {
        log('player', `소켓 에러 kioskId=${kioskId}:`, err.message);
    });
}

function handlePlayerMessage(kioskId, ws, msg) {
    const kiosk = kiosks.get(kioskId);
    if (!kiosk || !kiosk.activeSession) return;
    if (kiosk.activeSession.playerSocket !== ws) return;

    // Rate limit
    if (!checkRate(kiosk.activeSession)) {
        return; // 조용히 드롭
    }

    if (msg.type !== INPUT) return;
    if (!VALID_ACTIONS.has(msg.action)) {
        if (DEBUG_INPUT) log('input', `${kioskId} 거부 (action=${msg.action})`);
        return;
    }

    // grab은 단발, 나머지는 phase 검증
    if (msg.action === 'grab') {
        if (DEBUG_INPUT) log('input', `${kioskId} grab`);
        send(kiosk.socket, { type: PLAYER_INPUT, action: 'grab' });
    } else {
        if (!VALID_PHASES.has(msg.phase)) {
            if (DEBUG_INPUT) log('input', `${kioskId} 거부 (action=${msg.action} phase=${msg.phase})`);
            return;
        }
        // hold는 너무 시끄러우므로 start/stop만 기본 로그, hold는 DEBUG_INPUT일 때만
        if (msg.phase !== 'hold') {
            log('input', `${kioskId} ${msg.action} ${msg.phase}`);
        } else if (DEBUG_INPUT) {
            log('input', `${kioskId} ${msg.action} ${msg.phase}`);
        }
        send(kiosk.socket, {
            type: PLAYER_INPUT,
            action: msg.action,
            phase: msg.phase,
        });
    }
}

// ─────────────────────────────────────────────────────────────────
// HTTP + WebSocket 부팅
// ─────────────────────────────────────────────────────────────────

// 모바일 컨트롤러 페이지를 미리 메모리에 로드 (재기동 전까지 캐시)
let PLAY_HTML;
try {
    PLAY_HTML = readFileSync(join(__dirname, 'public', 'play.html'), 'utf8');
} catch (e) {
    console.error('play.html 로드 실패:', e.message);
    PLAY_HTML = '<h1>play.html not found</h1>';
}

const httpServer = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    // /play (GET) → 모바일 컨트롤러 HTML
    // 토큰이 없어도 페이지는 응답 (페이지 안에서 친절하게 안내)
    if (url.pathname === '/play') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end(PLAY_HTML);
        return;
    }

    res.writeHead(404);
    res.end();
});

const wssKiosk = new WebSocketServer({ noServer: true });
const wssPlayer = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    if (url.pathname === '/kiosk') {
        wssKiosk.handleUpgrade(req, socket, head, (ws) => {
            // wss.on('connection') 핸들러들(setupHeartbeat 등)을 발화시키기 위해 명시적 emit 필요.
            // ws 라이브러리의 noServer 모드 공식 예제 패턴.
            wssKiosk.emit('connection', ws, req);
            handleKioskConnection(ws);
        });
    } else if (url.pathname === '/play') {
        const token = url.searchParams.get('token');
        if (!token) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }
        wssPlayer.handleUpgrade(req, socket, head, (ws) => {
            wssPlayer.emit('connection', ws, req);
            handlePlayerConnection(ws, token);
        });
    } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
    }
});

// 하트비트 — 죽은 연결 감지
//
// 정책:
//   - HEARTBEAT_INTERVAL_MS 마다 ping 송출
//   - ping 후 PONG_TIMEOUT_MS 안에 pong 안 오면 강제 종료
//
// 이전 방식("다음 인터벌까지 응답 없으면 죽음")은 마진이 0이라
// 클라이언트 이벤트 루프가 아주 잠깐 막히는 것만으로도 끊김. 이걸 분리.
function setupHeartbeat(wss, label) {
    const PONG_TIMEOUT_MS = 5000;

    wss.on('connection', (ws) => {
        ws.on('pong', () => {
            if (ws._pongTimer) {
                clearTimeout(ws._pongTimer);
                ws._pongTimer = null;
            }
        });
    });

    const interval = setInterval(() => {
        for (const ws of wss.clients) {
            // 이전 ping의 pong이 아직 도착하지 않은 상태에서 다음 ping을 또 보내려는
            // 상황이면 timer가 살아있을 것. 그땐 그대로 두고 새 ping은 안 보냄.
            if (ws._pongTimer) continue;

            try { ws.ping(); } catch { continue; }

            ws._pongTimer = setTimeout(() => {
                log('heartbeat', `${label} pong ${PONG_TIMEOUT_MS}ms 안에 응답 없음 → 강제 종료`);
                ws._pongTimer = null;
                try { ws.terminate(); } catch { }
            }, PONG_TIMEOUT_MS);
        }
    }, HEARTBEAT_INTERVAL_MS);

    wss.on('close', () => clearInterval(interval));
}

setupHeartbeat(wssKiosk, 'kiosk');
// 모바일(wssPlayer)에는 하트비트 적용 안 함.
// 이유: 브라우저 WebSocket API는 ping에 자동 pong 응답을 안 해서,
// 30초쯤 후에 강제 끊김이 발생함. 모바일 세션은 짧고(최대 60초),
// 진짜 끊기면 close 이벤트로 알 수 있어 능동 감지 불필요.

httpServer.listen(PORT, BIND_HOST, () => {
    log('boot', `서버 시작 ${BIND_HOST}:${PORT} (PUBLIC_BASE_URL=${PUBLIC_BASE_URL})`);
    log('boot', `  키오스크: ws://<host>:${PORT}/kiosk`);
    log('boot', `  모바일 페이지: ${PUBLIC_BASE_URL}/play?token=...`);
    log('boot', `  헬스: ${PUBLIC_BASE_URL}/healthz`);
});

// ─────────────────────────────────────────────────────────────────
// 프로세스 레벨 예외 처리
// ─────────────────────────────────────────────────────────────────

// 잡지 못한 예외는 로그에 명시적으로 남기고 죽인다.
// systemd의 Restart=always가 자동으로 재기동. journalctl에서 fatal 태그로 grep 가능.
process.on('uncaughtException', (err) => {
    log('fatal', 'uncaughtException:', err.stack ?? err.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    log('fatal', 'unhandledRejection:', reason);
    // Rejection은 즉시 죽이지는 않음. 누적되면 위에 uncaughtException으로 잡힘.
});

// 우아한 종료
function shutdown() {
    log('boot', '종료 중...');
    httpServer.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
