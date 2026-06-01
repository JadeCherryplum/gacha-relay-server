// 자동 모바일 흉내 — mock 키오스크 + 서버가 잘 도는지 빠르게 검증
import WebSocket from 'ws';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function fakePlayer(playUrl) {
  // 테스트 환경: 192.168.0.100 같은 외부 IP를 localhost로 치환
  const localUrl = playUrl.replace(/\/\/[^/]+/, '//localhost:8080');
  console.log('\n[fake-player] 접속:', localUrl);
  const wsUrl = localUrl.replace(/^http/, 'ws');
  const ws = new WebSocket(wsUrl);

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log('[fake-player] ←', msg.type, msg.remaining ? `remaining=${msg.remaining}` : '');
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  console.log('[fake-player] 누르고 있음: left (1초)');
  ws.send(JSON.stringify({ type: 'input', action: 'left', phase: 'start' }));
  for (let i = 0; i < 10; i++) {
    await wait(100);
    ws.send(JSON.stringify({ type: 'input', action: 'left', phase: 'hold' }));
  }
  ws.send(JSON.stringify({ type: 'input', action: 'left', phase: 'stop' }));

  await wait(500);

  console.log('[fake-player] grab!');
  ws.send(JSON.stringify({ type: 'input', action: 'grab' }));

  // 서버 또는 mock-kiosk가 게임 종료 신호 보낼 때까지 대기
  await wait(3000);
  ws.close();
}

// 외부에서 playUrl 받아서 실행
const playUrl = process.argv[2];
if (!playUrl) {
  console.error('사용: node fake-player.js <playUrl>');
  process.exit(1);
}
fakePlayer(playUrl).then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
