# Claw Relay Server v2

QR 컨트롤러로 조작하는 클로 머신 키오스크의 메시지 중계 서버.

프로토콜: [protocol-v2.md](../protocol-v2.md) 참고.

## 특징

- 다중 키오스크 지원 (`Map<kioskId, KioskState>`)
- 키오스크 인증 없음 (특설 전시용 톤)
- 토큰은 일회용, 세션 종료 시 자동 갱신
- 입력 지속 모델 + rate limit
- 인메모리 상태 (DB 없음)
- HTML/WS 통합 (모바일 컨트롤러를 같은 도메인에서 서빙)

## 디렉토리

```
relay-server/
├── server.js              ← 단일 파일 서버
├── public/
│   └── play.html          ← 모바일 컨트롤러 페이지
├── package.json
├── .env.example
└── test-server.js         ← 통합 테스트
```

## 실행 (로컬)

```bash
npm install
cp .env.example .env
# .env에서 PUBLIC_BASE_URL을 실제 IP로 (사내 테스트 시)
npm run dev
```

## 내부망 테스트 셋업

서버 PC IP가 `192.168.0.100`인 경우:

**1. 서버 PC에서:**
```
# .env
PUBLIC_BASE_URL=http://192.168.0.100:8080
```
```bash
npm run dev
```

**2. 방화벽**: 서버 PC의 8080 포트가 사내망에서 접근 가능해야 함.
- Windows: 방화벽 인바운드 규칙에 8080 TCP 추가
- macOS/Linux: 보통 기본 허용

**3. 동작 확인 (다른 PC에서):**
- `http://192.168.0.100:8080/healthz` → `ok`
- `http://192.168.0.100:8080/play` → 컨트롤러 페이지 (token 없으면 안내 화면)

**4. 키오스크에서:**
- `ws://192.168.0.100:8080/kiosk` 접속
- `kiosk_hello` → `request_token` → 받은 `playUrl`로 QR 생성

**5. 모바일에서:**
- 키오스크 QR을 카메라로 스캔 → 사내 와이파이로 접속
- ⚠️ 모바일은 반드시 **사내 와이파이**에 연결되어 있어야 함 (LTE/5G로는 사내 IP 접근 불가)

## 엔드포인트

| 경로 | 방식 | 설명 |
|---|---|---|
| `/healthz` | GET | 헬스체크 |
| `/play` | GET | 모바일 컨트롤러 HTML |
| `/play?token=XXX` | WS | 모바일 플레이어 WebSocket (1회용 토큰) |
| `/kiosk` | WS | 키오스크 WebSocket (다수 가능) |

## 빠른 동작 확인

서버 띄우고 통합 테스트:
```bash
npm run dev          # 다른 터미널
node test-server.js  # 시나리오 0~4 자동 검증
```

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 8080 | 서버 포트 |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | QR에 들어갈 base URL |
| `TOKEN_TTL_SECONDS` | 300 | 토큰 유효시간 |
| `SESSION_DURATION_SECONDS` | 60 | 한 세션 길이 |
| `HEARTBEAT_INTERVAL_MS` | 15000 | WS 하트비트 주기 |
| `RATE_LIMIT_PER_SEC` | 30 | 세션당 초당 메시지 한도 |

## 다음 작업

1. ~~서버 1차~~ ✓
2. ~~모바일 컨트롤러 페이지~~ ✓
3. mock 키오스크로 사내 통합 테스트
4. 유니티 클라이언트
5. AWS 배포

## 추후 모듈 분리 예정

현재 단일 파일 구성. 동작 검증 후 다음 모듈로 쪼갤 예정:
- `protocol.js` — 메시지 상수, 화이트리스트
- `state.js` — kiosks Map, tokenIndex
- `token.js` — 토큰 발행/소비
- `session.js` — 세션 라이프사이클
- `kiosk.js` / `player.js` — 핸들러
- `index.js` — HTTP/WS 부팅
