# 교회 장소예약

교회 공간(본당·소예배실·교육관 등) 주간 예약 웹앱. 휴대폰·PC 브라우저 모두 지원.
**여러 교회에 배포 가능** — 교회 이름, 장소, 부서·교구 목록을 각 교회 관리자가 화면에서 직접 설정합니다.

## 여러 교회에 배포하는 방식

**교회 1곳 = 서버 1개 + DB 파일 1개** (교회마다 같은 코드를 따로 배포)
- 교회끼리 데이터·관리자 비밀번호가 완전히 분리됨
- 한 교회의 장애나 실수가 다른 교회에 영향 없음
- 교회마다 주소가 다름 (예: `kamram.onrender.com`, `saemmul.onrender.com`)

### 원클릭 배포 링크 (교회 담당자에게 전달)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dongju715/church-booking)

https://render.com/deploy?repo=https://github.com/dongju715/church-booking

담당자가 링크를 열고 → Render 가입/로그인 → `ADMIN_PASSWORD`, `CHURCH_NAME` 입력 → **Apply** 하면 그 교회 전용 서버(Starter, 월 약 $7 + 디스크 1GB)가 만들어집니다. 완료 후 나오는 `https://….onrender.com` 주소를 교인들에게 공유하면 됩니다.

새 교회 추가 절차 (수동):
1. 같은 GitHub 저장소로 Render 서비스(또는 서버)를 하나 더 만든다
2. 환경변수 `ADMIN_PASSWORD`, `SESSION_SECRET`, `DB_PATH`, `CHURCH_NAME`(초기값)을 그 교회 것으로 넣는다
3. 그 교회 담당자에게 주소와 관리자 비밀번호를 전달
4. 담당자가 **관리자 → 기본 정보 / 장소 / 부서·교구** 탭에서 직접 설정

| 관리자 탭 | 설정 내용 |
|---|---|
| 기본 정보 | 교회 이름(화면 제목 “○○교회 장소예약”), 영문 부제, 목록에 없는 부서 직접 입력 허용 여부 |
| 장소 | 추가 · 이름 변경 · 삭제 (앞으로 있을 예약이 남아 있으면 삭제 거부, 지난 기록은 보존) |
| 부서 · 교구 | 분류(부서/교구/기관/선교회/기타)와 이름 추가 · 수정 · 삭제. 예약 화면에서 분류별 목록으로 선택 |

> 코드를 고치면 모든 교회 서비스가 같은 저장소에서 자동 재배포되므로, 업데이트는 한 번에 반영됩니다.
> 교회가 아주 많아져(수십 곳 이상) 관리 부담이 커지면, 하나의 서버에서 교회별 주소(`/c/교회코드`)로 나누는 방식으로 전환할 수 있습니다.

**흐름:** 공간 선택 → 주간 시간표에서 빈 칸 누르기 → 종료 시간·부서명·취소용 비밀번호(숫자 4자리) 입력 → 예약 완료

## 구성

| 구분 | 내용 |
|---|---|
| 서버 | Node.js 22.13 이상, **외부 패키지 없음** (`npm install` 불필요) |
| DB | SQLite (Node 내장 `node:sqlite`), WAL 모드, 파일 1개 |
| 실시간 갱신 | Server-Sent Events (`/api/events`) + 1분 주기 새로고침 |
| 프런트엔드 | `public/` 정적 HTML/CSS/JS — 비밀값 없음 |

### 중복 예약 방지 (3중)
1. **화면**: 예약된 시간은 시작 시간 목록에서 빠지고, 종료 시간은 다음 예약 직전까지만 선택 가능
2. **서버**: `BEGIN IMMEDIATE` 트랜잭션으로 쓰기 잠금을 잡은 뒤 겹침 검사 → 저장
3. **DB**: 트리거(`trg_no_overlap_insert/update`)가 같은 공간의 활성 예약끼리 겹치면 저장 자체를 거부

겹침 조건은 `기존.시작 < 새.종료 AND 기존.종료 > 새.시작` 이라 10:00~11:00 다음에 11:00~12:00은 허용됩니다.

### 권한
- **예약 취소**: 예약 시 정한 숫자 4자리 비밀번호(서버에 scrypt 해시로 저장) 또는 관리자
- **관리자**: `ADMIN_PASSWORD`로 로그인 → 서버가 HMAC 서명 토큰(12시간) 발급. 공간 추가·모든 예약 취소는 서버에서 토큰 검증
- 로그인 5회/10분, 예약별 비밀번호 10회/10분 시도 제한
- **이력**: 상단 ‘예약 이력’에서 예약·취소·공간추가 기록 확인 (관리자에게만 IP 표시)

## 로컬 실행

```bash
cp .env.example .env   # 그리고 ADMIN_PASSWORD, SESSION_SECRET 수정
npm start              # http://localhost:3000 (현재 .env는 3010)
npm test               # 통합 테스트 12개 (동시 20건 요청 → 1건만 성공 포함)
```

## 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `ADMIN_PASSWORD` | ✅ | 관리자 비밀번호. 없으면 관리자 로그인 불가 |
| `SESSION_SECRET` | ✅ | 토큰 서명키. `openssl rand -hex 32`로 생성. 바뀌면 관리자 재로그인 |
| `PORT` | | 기본 3000 |
| `DB_PATH` | | 기본 `./data/reservations.db`. 클라우드에서는 **영구 디스크 경로** |
| `TRUST_PROXY` | | 프록시 뒤(Render/Fly/Nginx)면 `1` — 실제 접속자 IP로 시도 제한 |
| `MAX_DAYS_AHEAD` | | 예약 가능 기간(일), 기본 180 |
| `CHURCH_NAME` | | **처음 실행 시** 교회 이름 초기값 (이후엔 관리자 화면에서 변경) |
| `CHURCH_SUBTITLE` | | 처음 실행 시 영문 부제 초기값 |
| `DEFAULT_SPACES` | | 처음 실행 시 장소 목록, 쉼표 구분 (기본 `본당,소예배실,교육관`) |

관리자 설정: 서버 환경변수에 `ADMIN_PASSWORD`를 넣고 재시작 → 화면 우측 상단 ‘관리자’ → 로그인 → 기본 정보·장소·부서·교구 탭에서 설정.
비밀번호 변경은 환경변수를 바꾸고 재시작하면 됩니다.

## 배포 (권장: 서버 1대 + 영구 디스크)

SQLite는 **서버 1대(인스턴스 1개)** 에서 써야 합니다. 300명 규모(동시 접속 수십 명, 하루 예약 수십 건)는 가장 작은 서버로 충분합니다.

### A. Render (가장 쉬움)
1. 이 폴더를 GitHub 저장소로 올리기
2. Render → New → Web Service → 저장소 선택, Runtime Node, Start Command `npm start`
3. 유료 인스턴스(Starter) 선택 후 **Disks**에서 디스크 추가, Mount Path `/var/data`
4. Environment에 `ADMIN_PASSWORD`, `SESSION_SECRET`, `DB_PATH=/var/data/reservations.db`, `TRUST_PROXY=1`
5. 배포 후 발급된 `https://….onrender.com` 주소를 교인들에게 공유 (원하면 Custom Domain 연결)

> 무료 인스턴스는 디스크가 없어 재시작 시 데이터가 사라지므로 쓰지 마세요.

### B. Fly.io
```bash
fly launch --no-deploy
fly volumes create data --size 1
```
`fly.toml`에 `[mounts] source="data" destination="/data"` 추가, `fly secrets set ADMIN_PASSWORD=… SESSION_SECRET=… DB_PATH=/data/reservations.db TRUST_PROXY=1` 후 `fly deploy`. 머신 수는 1대로 유지(`fly scale count 1`).

### C. 교회 PC/NAS 또는 VPS(Lightsail 등)
Node 22.13+ 설치 → `npm start`를 pm2 또는 systemd로 상시 실행 → Nginx/Caddy로 HTTPS. Nginx는 SSE를 위해 `proxy_buffering off;` 권장.

### 예상 비용 (2026년 기준 대략, 환율·요금 변동 가능)
전제: 교인 300명, 동시 접속 최대 50명 내외, 데이터 연 수 MB.
- Render Starter + 1GB 디스크: 월 약 $7~8
- Fly.io shared-cpu 256MB + 1GB 볼륨: 월 약 $2~5
- Lightsail 최소 VPS: 월 약 $5
- 교회 내 PC: 전기료만 (단, 외부 접속용 고정 주소/HTTPS 설정 필요)

## 백업
- DB는 파일 하나입니다. 실행 중에도 안전하게 복사하려면:
  ```bash
  sqlite3 /var/data/reservations.db ".backup '/var/data/backup-$(date +%F).db'"
  ```
  또는 Node만 있다면 `node -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" 원본.db 백업.db`
- 매일 cron으로 위 명령 실행 + 외부(구글 드라이브, S3 등)로 복사 권장. Render/Fly는 디스크 스냅샷 기능도 제공.
- 복구: 서버를 멈추고 백업 파일을 `DB_PATH` 위치로 복사 후 재시작.

## 확장
- 현재 구조로 수천 명까지 무리 없음 (요청당 수 ms).
- 서버를 여러 대로 늘려야 한다면 DB를 PostgreSQL로 옮기고, 중복 방지는
  `EXCLUDE USING gist (space_id WITH =, tsrange(start_at, end_at) WITH &&) WHERE (status='active')` 제약으로, 실시간 갱신은 `LISTEN/NOTIFY` 또는 Redis pub/sub으로 대체하면 됩니다.
- 반복 예약(매주 같은 시간) 등은 `server.js`의 `routes`에 API 추가로 확장 가능.

## 파일
```
server.js          서버 (API, DB, 실시간, 정적 파일)
public/index.html  화면
public/style.css   디자인 (초록 + 크림 배경, 큰 글씨/버튼, 모바일 요일 탭)
public/app.js      시간표·예약·취소·관리자 로직
test/api.test.js   통합 테스트
```

LIGHTUP MEDIA.
