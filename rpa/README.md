# 토스플레이스 대시보드 RPA — 메뉴/이미지 자동 등록

> ⚠️ **2026-07-23 사이트 변경**: 등록 포털이 `partners.tossplace.com`(구) → **`dashboard.tossplace.com`**(신) 으로 변경됨.
> 아래 본문 일부는 구 사이트 기준 서술이 남아있으나, **셀렉터·흐름은 `config.js`/`upload-menu.js`에 신규 사이트 기준으로 반영 완료** (메뉴 일괄 + 상품 이미지 2모드, dry-run 검증됨). 상품 목록 조회는 `list-products.js`.

토스플레이스파트너스(토플파, `partners.tossplace.com`)는 공개 API가 없는 **로그인 게이트 파트너 웹포털**이라, 실제 메뉴/이미지 등록 자동화는 **브라우저 자동화(RPA, Playwright)** 로 한다. 이 PoC는 우리 판독 파이프라인이 만든 산출물(`out/<POS>_업로드_<매장>.csv` + 이미지)을 받아 토플파에 대신 업로드한다.

```
슬랙 요청 ─[/메뉴판독: 판독→JSON→양식]─▶ out/*.csv (+이미지)  ← 이미 완성
                                              │
                                              ▼  이 PoC
                          토플파 RPA: 로그인 세션 재사용 → 사업자번호로 가맹점 검색
                          → 상품 한 번에 등록(CSV 업로드) → 이미지 첨부 → (검수) → 등록
                                              │
                                              ▼
                                   슬랙 완료 리액션 → /메뉴등록집계
```

## 왜 RPA인가 (API 아님)
- 토플파는 대리점이 가맹점을 관리하는 **로그인 포털** — 개발자 API 미제공.
- 이미 **‘상품 한 번에 등록’(Excel 일괄 업로드)** UI가 있음 → RPA는 필드 타이핑 없이 **우리 생성 파일을 업로드 버튼에 넣기만** 하면 됨.
- **결정적 이점:** 원격팀 **대리점 계정이 관리 가맹점 전체에 접근** → Open API의 “가맹점별 동의” 문제 없음. 사업자번호로 매장 찾아 바로 처리.

## 안전 원칙 (라이브 POS에 직접 반영되므로)
1. **기본 dry-run** — 화면 이동·파일 업로드·스크린샷까지만 하고 **최종 ‘등록’ 클릭은 생략**. 검수 후 `--confirm` 으로만 실제 등록.
2. **세션 재사용** — 로그인/2FA는 `login.js` 로 1회 수동 처리 후 세션 저장(`.auth/state.json`). 이후 무인 실행.
3. **단계별 스크린샷** — 매 단계 `shots/<사업자번호>-<시각>/` 에 캡처. 실패 시에도 캡처.
4. **사람처럼 천천히**(`slowMo`) — 봇 탐지 완화. 무인 대량 실행 자제.
5. **자격/약관** — 대리점 계정 자격은 `.auth/`(git 제외)에만. 자동화 허용 여부(ToS) 사전 확인.

## 셋업
```bash
cd rpa
npm init -y && npm i -D playwright
npx playwright install chromium
```

## 사용법
```bash
# 1) 최초 1회 — 브라우저에서 직접 로그인(2FA 포함) 후 세션 저장
node rpa/login.js

# 2) 반자동(dry-run 기본) — 등록 직전까지만, 검수 스크린샷 생성
node rpa/upload-menu.js --biz 1234567890 --file out/토스플레이스_업로드_중화호반.csv

# 3) 검수 OK → 실제 등록
node rpa/upload-menu.js --biz 1234567890 --file out/토스플레이스_업로드_중화호반.csv --confirm

# 이미지 동시 첨부
node rpa/upload-menu.js --biz 1234567890 --file out/...csv --images shots/a.jpg,shots/b.jpg
```

## ⚠️ 실제 셀렉터를 채워야 동작함
로그인 게이트라 이 스캐폴드의 셀렉터는 **전부 placeholder(TODO)** 다. 실제 토플파 화면을 보고 `config.js` 의 `SELECTORS` 를 채운다. 가장 쉬운 방법:
```bash
npx playwright codegen https://partners.tossplace.com
```
→ 로그인 후 실제로 [가맹점 검색 → 상품관리 → 상품 한 번에 등록 → 파일 업로드] 를 클릭해보면 Playwright가 각 요소의 셀렉터를 자동 생성해준다. 그 셀렉터를 `config.js` 에 옮겨 담으면 된다.

## 단계적 도입(권장)
- **1단계 (지금)**: 셀렉터 채우고 dry-run 으로 흐름 검증(등록 안 함).
- **2단계**: 한 매장 `--confirm` 실제 등록 → 결과 대조.
- **3단계**: 슬랙 요청 → `/메뉴판독` → 이 RPA 를 잇는 반자동 파이프라인.
- **4단계**: 안정화되면 headless + 완료 시 슬랙 리액션 자동화.
