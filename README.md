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

## 운영 기간 및 보상 정책

기본 설정은 테스트 운영 `2026-08-26`부터, 정상 운영 `2026-09-07` ~ `2026-09-27`까지입니다.

```env
TEST_OPERATION_START_DATE=2026-08-26
NORMAL_OPERATION_START_DATE=2026-09-07
NORMAL_OPERATION_END_DATE=2026-09-27
TEST_DAILY_GOLD_COUNT=1
TEST_GOLD_P=1
```

- 정상 운영 전 테스트 기간에는 하루 1회 금 당첨 풀이 자동으로 열립니다.
- 정상 운영 기간에는 금 슬롯을 등록한 당일 특정 시간에만 금 당첨이 가능합니다.
- 은 일일 보상은 운영 기간 시작일부터 현재일까지의 누적 수량으로 계산됩니다.
- 당일 미당첨 또는 만료된 미수령 보상은 다음날 재고에 다시 포함됩니다.
- 만료된 미수령 보상은 기록은 남지만 기본 운영툴 목록에서는 숨겨집니다.

## HTTP

- `GET /healthz`
- `GET /play?token=...`
- `GET /play?result=...`
- `GET /p/:playToken`
- `GET /r/:resultToken`
- `GET /admin`
- `GET /a/:adminAuthToken`
- `GET /admin/slots`
- `POST /admin/slots/seed`
- `GET /admin/log?date=YYYY-MM-DD`
- `POST /admin/silver/reset?date=YYYY-MM-DD`
- `GET /admin/claims?status=pending|claimed`
- `GET /claim/:claimToken`
- `GET /c/:claimToken`

새로 생성되는 QR은 짧은 경로(`/p`, `/a`, `/c`)를 사용합니다. 기존 긴 경로(`/play?token=...`, `/admin/auth/...`, `/claim/...`)도 호환됩니다.

관리자 페이지는 `ADMIN_PASSWORD`로 로그인합니다. 일일 운영자 인증 QR은 운영 시작 1시간 전에 자동 생성되고 운영 종료 시 만료됩니다.
