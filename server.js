import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { db, cleanupExpired, closeAt, isoNow, localNow } from './db.js';
import { resolveGrab } from './gacha.js';
import {
  adminCookie,
  consumeAdminAuthToken,
  createAdminSession,
  getAdminSession,
  getOrCreateDailyAuthToken,
  randomToken,
  secureEqual,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAY_HTML = readFileSync(join(__dirname, 'public', 'play.html'), 'utf8');
const ADMIN_HTML = readFileSync(join(__dirname, 'public', 'admin.html'), 'utf8');
const ARTIFACTS_JSON = readFileSync(join(__dirname, 'public', 'artifacts.json'), 'utf8');
const ARTIFACT_DATA = JSON.parse(ARTIFACTS_JSON.replace(/^\uFEFF/, ''));
const ARTIFACT_INDEXES = Array.isArray(ARTIFACT_DATA.artifacts)
  ? ARTIFACT_DATA.artifacts.map((artifact) => Number(artifact.index)).filter(Number.isInteger)
  : [];

const kiosks = new Map();
const tokenIndex = new Map();
const VALID_ACTIONS = new Set(['left', 'right', 'up', 'down', 'grab']);
const VALID_PHASES = new Set(['start', 'hold', 'stop']);

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args);
}

function send(ws, payload) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
}

function randomArtifactIndex(random = Math.random) {
  if (!ARTIFACT_INDEXES.length) return null;
  return ARTIFACT_INDEXES[Math.floor(random() * ARTIFACT_INDEXES.length)];
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function html(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function issuePlayToken(kioskId) {
  const kiosk = kiosks.get(kioskId);
  if (!kiosk) return null;
  if (kiosk.pendingToken) tokenIndex.delete(kiosk.pendingToken.token);
  const token = randomToken(16);
  kiosk.pendingToken = { token, expiresAt: Date.now() + config.tokenTtlSeconds * 1000 };
  tokenIndex.set(token, kioskId);
  return { token, expiresIn: config.tokenTtlSeconds };
}

function consumePlayToken(token) {
  const kioskId = tokenIndex.get(token);
  const kiosk = kioskId ? kiosks.get(kioskId) : null;
  if (!kioskId || !kiosk?.pendingToken || kiosk.pendingToken.token !== token || Date.now() >= kiosk.pendingToken.expiresAt) {
    tokenIndex.delete(token);
    if (kiosk?.pendingToken?.token === token) kiosk.pendingToken = null;
    return null;
  }
  tokenIndex.delete(token);
  kiosk.pendingToken = null;
  return kioskId;
}

function isKioskOnline(kioskId) {
  return kiosks.get(kioskId)?.socket?.readyState === 1;
}

function createResultRecord(sessionId, kioskId) {
  const token = randomToken();
  const now = DateTime.utc();
  const expiresAt = closeAt(localNow()).toUTC();
  db.prepare(`
    INSERT INTO result_tokens(token, session_id, kiosk_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, sessionId, kioskId, now.toISO(), expiresAt.toISO());
  return {
    token,
    resultUrl: `${config.publicBaseUrl}/play?result=${token}`,
    expiresAt: expiresAt.toISO(),
  };
}

function invalidateResult(sessionId) {
  db.prepare('UPDATE result_tokens SET invalidated_at = COALESCE(invalidated_at, ?) WHERE session_id = ?')
    .run(isoNow(), sessionId);
}

function startSession(kioskId, playToken, playerSocket) {
  const kiosk = kiosks.get(kioskId);
  const sessionId = randomToken(18);
  const now = isoNow();
  db.prepare(`
    INSERT INTO play_log(session_id, kiosk_id, started_at)
    VALUES (?, ?, ?)
  `).run(sessionId, kioskId, now);
  const resultRecord = createResultRecord(sessionId, kioskId);
  const session = {
    sessionId,
    playToken,
    resultToken: resultRecord.token,
    resultUrl: resultRecord.resultUrl,
    playerSocket,
    startedAt: Date.now(),
    state: 'playing',
    result: null,
    artifactIndex: null,
    sessionTimer: null,
    tickInterval: null,
    phaseTimer: null,
    rateWindow: Date.now(),
    rateCount: 0,
  };
  kiosk.activeSession = session;

  send(playerSocket, {
    type: 'session_started',
    duration: config.sessionDurationSeconds,
    sessionId,
    resultUrl: resultRecord.resultUrl,
  });
  send(kiosk.socket, { type: 'player_joined', sessionId });

  session.tickInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil(config.sessionDurationSeconds - (Date.now() - session.startedAt) / 1000));
    if (remaining > 0) send(session.playerSocket, { type: 'tick', remaining });
  }, 1000);
  session.sessionTimer = setTimeout(() => endSession(kioskId, 'timeout'), config.sessionDurationSeconds * 1000);
  log('session', `started kioskId=${kioskId} sessionId=${sessionId}`);
}

function clearSessionTimers(session) {
  clearTimeout(session.sessionTimer);
  clearTimeout(session.phaseTimer);
  clearInterval(session.tickInterval);
}

function revealResult(kioskId) {
  const session = kiosks.get(kioskId)?.activeSession;
  if (!session?.result) return;
  const visibleAt = isoNow();
  db.prepare('UPDATE result_tokens SET visible_at = COALESCE(visible_at, ?) WHERE session_id = ?')
    .run(visibleAt, session.sessionId);
  const row = db.prepare('SELECT claim_token, artifact_index FROM result_tokens WHERE session_id = ?').get(session.sessionId);
  send(session.playerSocket, {
    type: 'result',
    result: session.result,
    resultUrl: session.resultUrl,
    artifactIndex: row?.artifact_index ?? session.artifactIndex ?? null,
    claimUrl: row?.claim_token ? `${config.publicBaseUrl}/claim/${row.claim_token}` : null,
  });
}

function endSession(kioskId, reason, errorCode = null) {
  const kiosk = kiosks.get(kioskId);
  const session = kiosk?.activeSession;
  if (!session) return;
  clearSessionTimers(session);

  db.prepare(`
    UPDATE play_log
    SET ended_at = ?, end_reason = ?, error_code = COALESCE(?, error_code)
    WHERE session_id = ?
  `).run(isoNow(), reason, errorCode, session.sessionId);

  if (!session.result) invalidateResult(session.sessionId);
  send(session.playerSocket, { type: 'session_ended', reason, errorCode });
  if (session.playerSocket?.readyState === 1) session.playerSocket.close(1000, 'session_ended');
  if (reason !== 'kiosk_lost' && isKioskOnline(kioskId)) send(kiosk.socket, { type: 'player_left', reason });
  kiosk.activeSession = null;
  log('session', `ended kioskId=${kioskId} reason=${reason}${errorCode ? ` error=${errorCode}` : ''}`);
}

function handleGrab(kioskId) {
  const kiosk = kiosks.get(kioskId);
  const session = kiosk?.activeSession;
  if (!session || session.state !== 'playing') return;

  session.state = 'waiting_grab_resolved';
  clearTimeout(session.sessionTimer);
  clearInterval(session.tickInterval);
  db.prepare('UPDATE play_log SET grabbed_at = ? WHERE session_id = ?').run(isoNow(), session.sessionId);
  send(kiosk.socket, { type: 'player_input', action: 'grab' });
  send(session.playerSocket, { type: 'resolving' });

  session.phaseTimer = setTimeout(() => {
    send(session.playerSocket, { type: 'error', code: 'grab_resolved_timeout' });
    endSession(kioskId, 'error', 'grab_resolved_timeout');
  }, config.grabResolvedTimeoutMs);
}

function handleGrabResolved(kioskId, msg = {}) {
  const kiosk = kiosks.get(kioskId);
  const session = kiosk?.activeSession;
  if (!session || session.state !== 'waiting_grab_resolved') return;
  clearTimeout(session.phaseTimer);

  const physicallyGrabbed = msg.grabbed !== false;
  session.result = physicallyGrabbed ? resolveGrab(kioskId, session.sessionId) : 'fail';
  session.artifactIndex = physicallyGrabbed ? randomArtifactIndex() : null;
  session.state = 'waiting_animation_done';
  const claimToken = session.result === 'gold' || session.result === 'silver' ? randomToken() : null;
  db.prepare(`
    UPDATE play_log SET resolved_at = ?, result = ? WHERE session_id = ?
  `).run(isoNow(), session.result, session.sessionId);
  db.prepare(`
    UPDATE result_tokens SET result = ?, claim_token = ?, artifact_index = ? WHERE session_id = ?
  `).run(session.result, claimToken, session.artifactIndex, session.sessionId);
  send(kiosk.socket, { type: 'grab_result', result: session.result, artifactIndex: session.artifactIndex });

  session.phaseTimer = setTimeout(() => {
    revealResult(kioskId);
    endSession(kioskId, 'completed');
  }, config.animationDoneTimeoutMs);
}

function handleAnimationDone(kioskId) {
  const session = kiosks.get(kioskId)?.activeSession;
  if (!session || session.state !== 'waiting_animation_done') return;
  clearTimeout(session.phaseTimer);
  revealResult(kioskId);
  endSession(kioskId, 'completed');
}

function checkRate(session) {
  const now = Date.now();
  if (now - session.rateWindow >= 1000) {
    session.rateWindow = now;
    session.rateCount = 0;
  }
  session.rateCount += 1;
  return session.rateCount <= config.rateLimitPerSec;
}

function handleKioskConnection(ws) {
  let kioskId = null;
  let identified = false;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!identified) {
      if (msg.type !== 'kiosk_hello' || typeof msg.kioskId !== 'string' || !msg.kioskId.trim()) {
        ws.close(1008, 'bad_hello');
        return;
      }
      kioskId = msg.kioskId.trim();
      identified = true;
      const existing = kiosks.get(kioskId);
      if (existing?.activeSession) endSession(kioskId, 'kiosk_lost', 'kiosk_replaced');
      try { existing?.socket?.close(1000, 'replaced'); } catch {}
      kiosks.set(kioskId, { socket: ws, pendingToken: existing?.pendingToken ?? null, activeSession: null });
      log('kiosk', kioskId + ' connected');
      return;
    }
    handleKioskMessage(kioskId, msg);
  });
  ws.on('close', () => {
    const kiosk = kiosks.get(kioskId);
    if (!kiosk || kiosk.socket !== ws) return;
    const session = kiosk.activeSession;
    if (session?.result) {
      revealResult(kioskId);
      endSession(kioskId, 'completed');
    } else if (session) {
      send(session.playerSocket, { type: 'error', code: 'kiosk_lost' });
      endSession(kioskId, 'kiosk_lost', 'kiosk_lost');
    }
    if (kiosk.pendingToken) tokenIndex.delete(kiosk.pendingToken.token);
    kiosks.delete(kioskId);
    log('kiosk', kioskId + ' disconnected');
  });
  ws.on('error', (error) => log('kiosk', error.message));
}

function handleKioskMessage(kioskId, msg) {
  const kiosk = kiosks.get(kioskId);
  if (!kiosk) return;
  if (msg.type === 'request_token' && !kiosk.activeSession) {
    const issued = issuePlayToken(kioskId);
    send(kiosk.socket, {
      type: 'token_issued',
      ...issued,
      playUrl: `${config.publicBaseUrl}/play?token=${issued.token}`,
    });
    return;
  }
  if (msg.type !== 'session_event') return;
  if (msg.event === 'grab_resolved') handleGrabResolved(kioskId, msg);
  if (msg.event === 'animation_done') handleAnimationDone(kioskId);
}

function handlePlayerConnection(ws, token) {
  const kioskId = consumePlayToken(token);
  if (!kioskId) {
    send(ws, { type: 'error', code: 'invalid_token' });
    ws.close(1008, 'invalid_token');
    return;
  }
  if (!isKioskOnline(kioskId)) {
    send(ws, { type: 'error', code: 'kiosk_offline' });
    ws.close(1011, 'kiosk_offline');
    return;
  }
  if (kiosks.get(kioskId).activeSession) {
    send(ws, { type: 'error', code: 'already_in_use' });
    ws.close(1008, 'already_in_use');
    return;
  }
  startSession(kioskId, token, ws);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const session = kiosks.get(kioskId)?.activeSession;
    if (!session || session.playerSocket !== ws || !checkRate(session) || msg.type !== 'input') return;
    if (!VALID_ACTIONS.has(msg.action)) return;
    if (msg.action === 'grab') {
      handleGrab(kioskId);
      return;
    }
    if (session.state !== 'playing' || !VALID_PHASES.has(msg.phase)) return;
    send(kiosks.get(kioskId).socket, { type: 'player_input', action: msg.action, phase: msg.phase });
  });
  ws.on('close', () => {
    const session = kiosks.get(kioskId)?.activeSession;
    if (!session || session.playerSocket !== ws) return;
    if (session.state === 'playing') endSession(kioskId, 'disconnect', 'player_disconnect');
    else session.playerSocket = null;
  });
  ws.on('error', (error) => log('player', error.message));
}

function resultPayload(row) {
  const now = isoNow();
  if (!row || row.invalidated_at || row.expires_at <= now) return null;
  if (!row.visible_at || !row.result) return { status: 'pending', expiresAt: row.expires_at };
  return {
    status: 'finished',
    result: row.result,
    artifactIndex: row.artifact_index ?? null,
    claimUrl: row.claim_token ? `${config.publicBaseUrl}/claim/${row.claim_token}` : null,
    expiresAt: row.expires_at,
  };
}

function adminPageData() {
  const auth = getOrCreateDailyAuthToken();
  const authUrl = auth ? `${config.publicBaseUrl}/admin/auth/${auth.token}` : null;
  const slots = db.prepare('SELECT * FROM gold_slots ORDER BY start_at DESC LIMIT 20').all();
  const claims = db.prepare(`
    SELECT result, kiosk_id, visible_at, claimed_at
    FROM result_tokens WHERE result IN ('gold', 'silver')
    ORDER BY created_at DESC LIMIT 30
  `).all();
  return { authUrl, slots, claims, now: localNow().toISO() };
}

function claimRow(token) {
  return db.prepare(`
    SELECT r.*, p.grabbed_at, p.resolved_at
    FROM result_tokens r JOIN play_log p ON p.session_id = r.session_id
    WHERE r.claim_token = ? AND r.result IN ('gold', 'silver')
  `).get(token) ?? null;
}

function loginForm(action, title = 'Admin Login') {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><style>body{font-family:sans-serif;max-width:420px;margin:60px auto;padding:20px}input,button{font-size:18px;padding:14px;width:100%;box-sizing:border-box;margin:8px 0}</style>
  <h1>${title}</h1><form method="post" action="${action}"><input type="password" name="password" placeholder="Admin password" required><button>Login</button></form></html>`;
}

function claimPage(row) {
  const expired = row.expires_at <= isoNow();
  const status = row.claimed_at ? `이미 수령 완료 (${row.claimed_at})` : expired ? '수령 기한 만료' : '미수령';
  const button = row.claimed_at || expired ? '' : `<form method="post" action="/claim/${row.claim_token}/complete"><button>수령 완료 처리</button></form>`;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>상품 수령 확인</title><style>body{font-family:sans-serif;max-width:520px;margin:40px auto;padding:20px}dt{color:#666;margin-top:18px}dd{font-size:22px;margin:4px 0}button{font-size:20px;padding:16px;width:100%;margin-top:28px}</style>
  <h1>상품 수령 확인</h1><dl><dt>상품 종류</dt><dd>${row.result.toUpperCase()}</dd><dt>당첨 시각</dt><dd>${row.resolved_at}</dd><dt>키오스크 ID</dt><dd>${row.kiosk_id}</dd><dt>수령 상태</dt><dd>${status}</dd></dl>${button}</html>`;
}
async function handleHttp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  cleanupExpired();

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname === '/artifacts.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(ARTIFACTS_JSON);
  }
  if (url.pathname === '/play') return html(res, 200, PLAY_HTML);

  if (url.pathname.startsWith('/api/results/') && req.method === 'GET') {
    const token = url.pathname.split('/').pop();
    const payload = resultPayload(db.prepare('SELECT * FROM result_tokens WHERE token = ?').get(token));
    return payload ? json(res, payload.status === 'pending' ? 202 : 200, payload) : json(res, 410, { status: 'expired' });
  }

  if (url.pathname === '/qr' && req.method === 'GET') {
    const text = url.searchParams.get('text');
    if (!text || text.length > 2048) return json(res, 400, { error: 'bad_request' });
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  if (url.pathname === '/admin/login' && req.method === 'GET') return html(res, 200, loginForm('/admin/login'));
  if (url.pathname === '/admin/login' && req.method === 'POST') {
    if (!config.adminPassword) return html(res, 503, '<h1>Admin password is not configured.</h1>');
    const body = await readBody(req);
    if (!secureEqual(body.password ?? '', config.adminPassword)) return html(res, 401, loginForm('/admin/login', 'Invalid password'));
    const session = createAdminSession();
    return redirect(res, '/admin', { 'Set-Cookie': adminCookie(session.token, session.expiresAt) });
  }
  if (url.pathname.startsWith('/admin/auth/') && req.method === 'GET') {
    if (!consumeAdminAuthToken(url.pathname.split('/').pop())) return html(res, 410, '<h1>Expired admin auth QR.</h1>');
    const session = createAdminSession();
    return redirect(res, '/admin', { 'Set-Cookie': adminCookie(session.token, session.expiresAt) });
  }

  if (url.pathname === '/admin' && req.method === 'GET') {
    if (!getAdminSession(req)) return redirect(res, '/admin/login');
    return html(res, 200, ADMIN_HTML.replace('__ADMIN_DATA__', JSON.stringify(adminPageData()).replaceAll('<', '\\u003c')));
  }

  if (url.pathname === '/admin/slots' && req.method === 'GET') {
    if (!getAdminSession(req)) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { slots: db.prepare('SELECT * FROM gold_slots ORDER BY start_at').all() });
  }
  if (url.pathname === '/admin/slots/seed' && req.method === 'POST') {
    if (!getAdminSession(req)) return json(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    if (!Array.isArray(body.slots)) return json(res, 400, { error: 'bad_request' });
    const normalized = body.slots.map((slot) => ({
      startAt: DateTime.fromISO(slot.startAt).toUTC(),
      endAt: DateTime.fromISO(slot.endAt).toUTC(),
      pStart: Number(slot.pStart),
      pEnd: Number(slot.pEnd),
    }));
    if (normalized.some((slot) => !slot.startAt.isValid || !slot.endAt.isValid || slot.endAt <= slot.startAt
      || !Number.isFinite(slot.pStart) || !Number.isFinite(slot.pEnd)
      || slot.pStart < 0 || slot.pStart > 1 || slot.pEnd < 0 || slot.pEnd > 1)) {
      return json(res, 400, { error: 'bad_slot' });
    }
    const insert = db.prepare('INSERT INTO gold_slots(start_at, end_at, p_start, p_end) VALUES (?, ?, ?, ?)');
    const seed = db.transaction((slots) => slots.map((slot) => insert.run(
      slot.startAt.toISO(),
      slot.endAt.toISO(),
      slot.pStart,
      slot.pEnd,
    ).lastInsertRowid));
    return json(res, 201, { ids: seed(normalized) });
  }
  if (url.pathname === '/admin/log' && req.method === 'GET') {
    if (!getAdminSession(req)) return json(res, 401, { error: 'unauthorized' });
    const date = url.searchParams.get('date') ?? localNow().toFormat('yyyy-LL-dd');
    return json(res, 200, { logs: db.prepare('SELECT * FROM play_log WHERE started_at LIKE ? ORDER BY started_at DESC').all(`${date}%`) });
  }
  if (url.pathname === '/admin/silver/reset' && req.method === 'POST') {
    if (!getAdminSession(req)) return json(res, 401, { error: 'unauthorized' });
    const date = url.searchParams.get('date');
    if (!date || !DateTime.fromFormat(date, 'yyyy-LL-dd').isValid) return json(res, 400, { error: 'bad_date' });
    db.prepare('INSERT OR IGNORE INTO silver_days(local_date) VALUES (?)').run(date);
    db.prepare('UPDATE silver_days SET consumed_at = NULL, kiosk_id = NULL, session_id = NULL WHERE local_date = ?').run(date);
    return json(res, 200, { ok: true, date });
  }
  if (url.pathname === '/admin/claims' && req.method === 'GET') {
    if (!getAdminSession(req)) return json(res, 401, { error: 'unauthorized' });
    const status = url.searchParams.get('status');
    const where = status === 'claimed' ? 'AND claimed_at IS NOT NULL' : status === 'pending' ? 'AND claimed_at IS NULL' : '';
    return json(res, 200, {
      claims: db.prepare(`
        SELECT result, kiosk_id, resolved_at, expires_at, claimed_at
        FROM result_tokens JOIN play_log USING(session_id)
        WHERE result IN ('gold', 'silver') ${where}
        ORDER BY created_at DESC
      `).all(),
    });
  }

  const claimMatch = url.pathname.match(/^\/claim\/([^/]+)(?:\/(login|complete))?$/);
  if (claimMatch) {
    const [, token, action] = claimMatch;
    const row = claimRow(token);
    if (!row) return html(res, 404, '<h1>Invalid claim QR.</h1>');
    if (action === 'login' && req.method === 'POST') {
      if (!config.adminPassword) return html(res, 503, '<h1>Admin password is not configured.</h1>');
      const body = await readBody(req);
      if (!secureEqual(body.password ?? '', config.adminPassword)) return html(res, 401, loginForm(`/claim/${token}/login`, 'Invalid password'));
      const session = createAdminSession();
      return redirect(res, `/claim/${token}`, { 'Set-Cookie': adminCookie(session.token, session.expiresAt) });
    }
    if (!getAdminSession(req)) return html(res, 401, loginForm(`/claim/${token}/login`));
    if (action === 'complete' && req.method === 'POST') {
      if (!row.claimed_at && row.expires_at > isoNow()) {
        const now = isoNow();
        db.prepare('UPDATE result_tokens SET claimed_at = ?, invalidated_at = ? WHERE claim_token = ? AND claimed_at IS NULL')
          .run(now, now, token);
      }
      return redirect(res, `/claim/${token}`);
    }
    if (!action && req.method === 'GET') return html(res, 200, claimPage(claimRow(token)));
  }

  return json(res, 404, { error: 'not_found' });
}

const httpServer = createServer((req, res) => {
  handleHttp(req, res).catch((error) => {
    log('http', error.stack ?? error.message);
    if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    else res.end();
  });
});

const wssKiosk = new WebSocketServer({ noServer: true });
const wssPlayer = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/kiosk') {
    wssKiosk.handleUpgrade(req, socket, head, (ws) => {
      wssKiosk.emit('connection', ws, req);
      handleKioskConnection(ws);
    });
    return;
  }
  if (url.pathname === '/play' && url.searchParams.get('token')) {
    wssPlayer.handleUpgrade(req, socket, head, (ws) => {
      wssPlayer.emit('connection', ws, req);
      handlePlayerConnection(ws, url.searchParams.get('token'));
    });
    return;
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

function setupHeartbeat(wss, label) {
  wss.on('connection', (ws) => ws.on('pong', () => {
    clearTimeout(ws.pongTimer);
    ws.pongTimer = null;
  }));
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.pongTimer) continue;
      try { ws.ping(); } catch { continue; }
      ws.pongTimer = setTimeout(() => {
        log('heartbeat', `${label} pong timeout`);
        try { ws.terminate(); } catch {}
      }, 5000);
    }
  }, config.heartbeatIntervalMs);
  wss.on('close', () => clearInterval(interval));
}

setupHeartbeat(wssKiosk, 'kiosk');

const adminQrInterval = setInterval(() => getOrCreateDailyAuthToken(), 60_000);
getOrCreateDailyAuthToken();

httpServer.listen(config.port, config.bindHost, () => {
  log('boot', `server started ${config.bindHost}:${config.port} (${config.publicBaseUrl})`);
  if (!config.adminPassword) log('boot', 'warning: ADMIN_PASSWORD is not set; admin login is disabled.');
});

function shutdown() {
  clearInterval(adminQrInterval);
  httpServer.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  log('fatal', error.stack ?? error.message);
  process.exit(1);
});
process.on('unhandledRejection', (error) => log('fatal', error?.stack ?? error));
