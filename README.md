# Claw Gacha Server

Node.js 20+와 `ws`, SQLite를 사용하는 클로 머신 서버입니다.

## 주요 기능

- 다중 키오스크 WebSocket 중계
- 세션당 Grab 1회 및 `playing → resolving → finished` 흐름
- SQLite 트랜잭션 기반 금·은 동시 당첨 방지
- 결과 복구 링크와 당첨 수령 QR
- 관리자 페이지, 일일 운영자 인증 QR, 수령 완료 처리

## 실행

```bash
npm install
copy .env.example .env
npm start
```

로컬 통합 테스트:

```bash
npm test
```

테스트는 `127.0.0.1:18080`과 별도 SQLite 파일을 사용합니다.

## 프로토콜

키오스크 → 서버:

```json
{ "type": "kiosk_hello", "kioskId": "claw-01" }
{ "type": "request_token" }
{ "type": "session_event", "event": "grab_resolved" }
{ "type": "session_event", "event": "animation_done" }
```

서버 → 키오스크:

```json
{ "type": "player_joined", "sessionId": "..." }
{ "type": "player_input", "action": "grab" }
{ "type": "grab_result", "result": "gold" }
{ "type": "player_left", "reason": "completed" }
```

## 금 슬롯 등록

```bash
npm run seed:gold -- "2026-07-04 20:00" "2026-07-04 21:00" 0.05 0.80
```

입력 시간은 `TIMEZONE` 기준이며 DB에는 UTC로 저장됩니다.

## HTTP

- `GET /healthz`
- `GET /play?token=...`
- `GET /play?result=...`
- `GET /admin`
- `GET /admin/slots`
- `POST /admin/slots/seed`
- `GET /admin/log?date=YYYY-MM-DD`
- `POST /admin/silver/reset?date=YYYY-MM-DD`
- `GET /admin/claims?status=pending|claimed`
- `GET /claim/:claimToken`

관리자 페이지는 `ADMIN_PASSWORD`로 로그인합니다. 일일 운영자 인증 QR은 운영 시작 1시간 전에 자동 생성되고 운영 종료 시 만료됩니다.
