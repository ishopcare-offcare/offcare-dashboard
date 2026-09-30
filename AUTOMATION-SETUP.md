# 원격파트 대시보드 — 호스팅 + 완전 자동화 셋업 가이드

대시보드를 인터넷에 올리고(GitHub Pages), 매일 슬랙 채널을 자동 집계(GitHub Actions)하는 방법입니다.
아래 **① 호스팅**과 **② 자동화**를 한 번만 세팅하면, 이후엔 PC를 꺼도 매일 자동으로 갱신됩니다.

---

## ① 호스팅 (GitHub Pages) — 약 2분

1. 브라우저에서 저장소 열기: https://github.com/ishopcare-offcare/offcare-dashboard
2. 상단 **Settings** → 왼쪽 메뉴 **Pages**
3. **Build and deployment** → Source: **Deploy from a branch**
4. Branch: **main** / 폴더: **/ (root)** → **Save**
5. 1~2분 뒤 새로고침하면 상단에 공개 주소가 뜹니다:
   **https://ishopcare-offcare.github.io/offcare-dashboard/**

> ⚠️ 저장소가 **공개(public)** 라 소스가 노출됩니다. 로그인 비번(`시프티`)이 소스에서 보이므로, 강한 보안이 필요하면 저장소를 private로 바꾸고(단, private Pages는 유료 플랜 필요) 별도 로그인 방식을 논의하세요.

---

## ② 매일 자동 집계 (GitHub Actions + 슬랙 봇 토큰)

### A. 슬랙 봇 토큰 만들기 (한 번만)
1. https://api.slack.com/apps → **Create New App** → **From scratch**
   - App Name: `원격집계봇` / 워크스페이스: iShopCare 선택
2. 왼쪽 **OAuth & Permissions** → **Scopes → Bot Token Scopes** 에 추가:
   - `channels:history` (공개 채널 읽기)
   - `channels:read`
   - (채널이 비공개면 `groups:history`, `groups:read` 도 추가)
3. 상단 **Install to Workspace** → 허용 → **Bot User OAuth Token**(`xoxb-...`) 복사
4. 슬랙에서 `#0_원격_as_요청` 채널에 이 봇을 초대: 채널에서 `/invite @원격집계봇`

### B. 토큰을 GitHub에 비밀로 등록
1. 저장소 → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
   - Name: `SLACK_BOT_TOKEN`
   - Secret: 위에서 복사한 `xoxb-...` 붙여넣기 → **Add secret**

### C. Actions 켜고 테스트
1. 저장소 → **Actions** 탭 → (처음이면) 워크플로 사용 허용
2. 왼쪽 **daily-slack-tally** 선택 → **Run workflow** 버튼으로 즉시 1회 테스트
3. 성공하면 `slack-data.js`가 자동 커밋되고, Pages 사이트에 반영됩니다.

이후 매일 **21:00(KST)** 에 자동 실행됩니다. (시간 변경: `.github/workflows/daily-slack-tally.yml`의 cron)

---

## 동작 요약 (하루 2회 실행)
```
① 21:00 KST — 진행 현황 집계 (오늘)      : daily-slack-tally
② 00:30 KST — 어제 최종 마감 집계        : daily-slack-tally-final
     ↑ 야간 직원의 21:00~24:00 업무까지 포함해 '전날'을 완전 확정
  → 각 실행이 slack-data.js 갱신 후 자동 커밋
  → GitHub Pages 자동 재배포
  → 팀 전원이 https://ishopcare-offcare.github.io/offcare-dashboard/ 에서 최신 실적 확인
```
> 집계 대상 날짜는 `TALLY_DATE_OFFSET`(0=오늘, -1=어제)로 제어하며,
> 하루 경계(00:00~24:00 KST)를 정확히 잘라 자정 넘어 실행해도 그날치만 집계합니다.

## 수동 집계(백업)
토큰 없이 Claude Code에서 `/원격집계` 를 실행하면, 슬랙 커넥터로 읽어 `slack-data.js`를 갱신합니다. (로컬 확인용)

## ③ 회사 구글 캘린더 → 공유탭 (지정 회의만)

제목에 **`정기회의` 또는 `타운홀/Town Hall`** 이 들어간 일정만 가져와 공유탭에 파란 **G** 칩으로 표시합니다(읽기 전용). 개인 일정은 가져오지 않습니다.

1. 캘린더 **설정 및 공유 → 캘린더 통합 → iCal 형식의 비공개 주소**(`.../basic.ics`) 복사
2. 저장소 **Settings → Secrets and variables → Actions** → `GCAL_ICAL_URL` 로 등록
3. **Actions → gcal-sync → Run workflow** 1회 실행 → 이후 매시간 자동

> - 가져올 회의 키워드는 `scripts/fetch-calendar.js`의 `KEEP` 또는 워크플로 env `GCAL_KEEP`(쉼표구분)로 조정.
> - 반복 회의는 과거 30일~미래 150일 범위로 펼쳐 저장, KST 기준.

---

## ④ 진짜 30분 자동 — 외부 크론(cron-job.org)으로 GitHub 깨우기

GitHub 예약(schedule)은 부하 시 드롭돼서 불안정합니다. 외부 크론이 GitHub 워크플로를 30분마다 **강제 실행**하면 안정적입니다.

### A. GitHub 토큰(PAT) 발급 (한 번만)
1. GitHub → 우상단 프로필 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. **Repository access**: Only select repositories → `ishopcare-offcare/offcare-dashboard`
3. **Permissions → Repository permissions → Actions: Read and write** (그 외는 No access)
4. Expiration은 길게(1년) → **Generate** → 토큰(`github_pat_...`) 복사
   - ⚠️ 채팅에 붙여넣지 말 것. cron-job.org에만 입력.

### B. cron-job.org에 등록 (무료)
1. https://cron-job.org 가입 → **Create cronjob**
2. **URL**: `https://api.github.com/repos/ishopcare-offcare/offcare-dashboard/actions/workflows/daily-slack-tally.yml/dispatches`
3. **Schedule**: Every 30 minutes (또는 업무시간 09:00~23:00만)
4. **Advanced → Request method**: `POST`
5. **Headers** 추가:
   - `Authorization`: `Bearer github_pat_...(위 토큰)`
   - `Accept`: `application/vnd.github+json`
   - `Content-Type`: `application/json`
6. **Request body**: `{"ref":"main"}`
7. Save → 다음 30분마다 자동으로 GitHub 집계가 돕니다.

> 응답이 **204 No Content** 면 정상(실행 트리거 성공). 401/403이면 토큰 권한 확인.
> 최종 마감(어제 확정)은 GitHub 내장 cron(00:30)이 그대로 담당하거나, 같은 방식으로 `daily-slack-tally-final.yml` 도 별도 등록하면 됩니다.

---

## ⑤ 근실시간 — 슬랙에 새 글이 올라오면 즉시 집계 (권장)

④의 외부 크론은 **새 글이 없어도** 주기마다 무조건 돕니다. 주기를 짧게 잡으면 빨라지지만
그만큼 헛돕니다. ⑤는 반대로 **새 글을 발견했을 때만** 워크플로를 깨웁니다.

```
슬랙 새 글  →  [Apps Script 1분 트리거가 감지]  →  repository_dispatch
            →  워크플로 즉시 실행(~30초, 이미지 판독 포함)  →  Pages 재배포
            →  대시보드 반영   ·  총 1~2분
```

집계 작업 자체는 ~30초, 이미지 판독은 장당 ~13초입니다. 느렸던 건 처리가 아니라
**"언제 시작할지 기다리는 시간"** 이었습니다.

### A. GitHub 토큰 준비
④에서 만든 PAT를 그대로 재사용하면 됩니다. 없다면 ④-A 순서로 발급하되,
**Permissions → Repository permissions → Contents: Read and write** 를 주세요.
(④는 `workflow_dispatch`라 Actions 권한이지만, ⑤는 `repository_dispatch`라 Contents 권한입니다.)

### B. Apps Script에 값 넣기
1. https://script.google.com → 대시보드 백엔드 프로젝트 열기
2. `game-backend.gs` 전체를 저장소 최신 내용으로 교체 → 저장
3. 왼쪽 **프로젝트 설정(⚙️) → 스크립트 속성 → 속성 추가** 로 두 개 등록
   | 속성 | 값 |
   |---|---|
   | `SLACK_BOT_TOKEN` | `xoxb-...` (②-A에서 만든 봇 토큰) |
   | `GITHUB_TOKEN` | `github_pat_...` (위 A) |
   > ⚠️ 스크립트 속성에만 넣으세요. 코드에 직접 쓰면 공개 저장소에 그대로 노출됩니다.

### C. 동작 확인 후 트리거 설치
1. 편집기 상단 함수 선택에서 **`testSlackWatch`** → **실행** → 실행 로그 확인
   - `SLACK_BOT_TOKEN: 있음` / `GITHUB_TOKEN: 있음` / 채널별 `읽기 성공` 이면 정상
   - `읽기 실패` 면 해당 채널에 집계봇이 초대돼 있는지 확인 (`/invite @원격집계봇`)
2. **`installSlackWatchTrigger`** → **실행** (권한 승인 창이 뜨면 허용)
3. 슬랙 `#oc팀_메뉴요청` 에 아무 글이나 올려보고, 1~2분 안에 대시보드에 뜨는지 확인

끄고 싶으면 **`removeSlackWatchTrigger`** 를 실행하면 됩니다.

### 참고
- 감시 채널은 `game-backend.gs` 의 `WATCH_CHANNELS` 에 있습니다. 워크플로는 실행될 때마다
  **모든** 채널을 다시 집계하므로, 메뉴요청·AS요청 두 개만 봐도 나머지까지 최신화됩니다.
- 업무시간(KST 09:00~23:00) 밖에는 트리거가 아무 일도 하지 않습니다 (`WATCH_HOURS`).
- 스레드 댓글로 들어온 요청도 감지합니다 (부모 글의 `latest_reply` 까지 지문에 포함).
- ④의 외부 크론은 **안전망으로 남겨두되 주기를 늘려도 됩니다**(예: 15분 → 1시간).
  ⑤가 도는 동안엔 굳이 자주 돌 이유가 없습니다.
- 워크플로에 `concurrency: slack-tally` 를 걸어 두어, 즉시 실행과 예약 실행이 겹쳐도
  같은 파일을 동시에 커밋하지 않고 순서대로 처리됩니다.

---

## ⑥ 실시간 — 슬랙 이벤트를 바로 받기 (Slack Events API)

⑤의 1분 폴링 대신 슬랙이 글·댓글·수정·**이모지 추가/삭제**를 웹앱으로 바로 보내 줍니다.
감지가 0~60초 → 약 1초로 줄고, ⑤는 이벤트가 유실됐을 때만 도는 안전망이 됩니다.

```
슬랙 변경 → Events API → 웹앱 doPost(handleSlackEvent_) → repository_dispatch → 워크플로
```

1. **Apps Script**: `game-backend.gs` 반영 후 **배포 → 배포 관리 → 연필 → 새 버전 → 배포** (URL 유지. "새 배포" 금지)
2. **스크립트 속성** `SLACK_VERIFY_TOKEN` = 슬랙 앱 **Basic Information → App Credentials → Verification Token**
   (웹앱은 요청 헤더를 못 읽어 서명 검증 대신 본문 token 으로 확인합니다)
3. **슬랙 앱 → OAuth & Permissions → Bot Token Scopes** 에 `reactions:read` 추가 → 상단 배너로 **재설치**
4. **슬랙 앱 → Event Subscriptions** → Enable → Request URL 에 웹앱 `/exec` 주소 → **Verified** 확인
   → **Subscribe to bot events**: `message.channels`, `reaction_added`, `reaction_removed` → Save
5. 확인: 최근 글에 이모지 → 1~2초 안에 Actions 에 `repository_dispatch` 실행

> 이벤트는 봇이 들어가 있는 채널에서만 옵니다. 집계 채널 목록은 `EVENT_CHANNELS` (fetch-and-tally.js CHANNELS 와 맞출 것).
> 슬랙은 3초 안에 응답이 없으면 같은 이벤트를 재전송합니다 — event_id 캐시로 한 번만 처리합니다.

---

## 이모지 규칙(집계 기준)
- 담당자: `원격규빈`=김규빈, `원격선유`=배선유, `원격성현`=심성현, `원격동욱`=김동욱, `원격현기`=김현기, `원격태양`=송태양, `원격기범`=김기범, `원격상원`=서상원, `원격민석`=최민석, `원격경림`=고경림, `원격하림`=박하림
- 카테고리: `원격as`=AS, `원격온보딩`=온보딩
- 확인필요: 담당자/카테고리 이모지 없음 또는 `1차_부재`/`2차_부재`
- 새 이모지가 생기면 `scripts/fetch-and-tally.js`와 `scripts/tally-remote-as.js`의 `personMap`/`catMap`에 추가
