/*
 * 무인 자동 실행용: 슬랙 API로 여러 채널의 오늘 메시지를 읽어 집계 → slack-data.js 갱신
 * GitHub Actions 에서 매일 실행. 환경변수: SLACK_BOT_TOKEN (필수), TALLY_DATE_OFFSET(0/-1)
 * 실행: node scripts/fetch-and-tally.js
 */
const fs = require('fs');

const TOKEN = process.env.SLACK_BOT_TOKEN;
const OUT = 'slack-data.js';
if (!TOKEN) { console.error('SLACK_BOT_TOKEN 환경변수가 필요합니다.'); process.exit(1); }

// 집계 대상 채널. defaultCat = 카테고리 이모지 없을 때 기본(AS채널만),
// requireCat=true = 해당 카테고리 이모지가 찍힌 것만 집계(원격as가 찍히면 AS로 집계, 무이모지는 미집계)
const CHANNELS = [
  { id: 'C09HRUSG4TX', label: '원격 AS요청', defaultCat: 'as' },                              // 공개: 이모지로 AS/온보딩/외주 구분, 무이모지→AS
  { id: 'C07CL4BV9QT', label: '명의변경',    defaultCat: 'transfer', requireCat: true },      // 원격명의변경 이모지가 찍힌 것만(원격as→AS)
  { id: 'C08740SFT1S', label: '메뉴등록',    defaultCat: 'menu',     requireCat: true },      // 원격메뉴등록 이모지가 찍힌 것만(원격as→AS)
  { id: 'C0ASD02FFML', label: '배달요청',    defaultCat: 'delivery', requireCat: true },      // 원격배달 이모지가 찍힌 것만(원격as→AS)
  { id: 'C07B5E78J23', label: 'VOC',         type: 'voc' },                                   // 설문 응답(점수/업종/사유) 별도 파싱
];

const personMap = { '규빈':'김규빈','선유':'배선유','성현':'심성현','동욱':'김동욱','현기':'김현기','태양':'송태양','기범':'김기범','상원':'서상원','민석':'최민석','경림':'고경림' };
const catMap = { '원격온보딩':'onboarding', '원격as':'as', '원격명의변경':'transfer', '원격메뉴등록':'menu', '원격voc':'voc', '원격배달':'delivery', '원격예약':'booking', '예약':'booking' };
/* 예약(2026-09-24~) — 예약 이모지가 찍히면 다른 카테고리 이모지(원격온보딩·원격as…)가 같이 있어도 예약으로 적재한다.
 * 슬랙 reactions 순서는 '처음 찍힌 순'이라, 우선순위를 안 주면 먼저 찍힌 원격온보딩이 이겨 버린다.
 * 이모지 이름이 '원격예약' 인지 '예약' 인지 확정 전이라 둘 다 받는다. */
const workCatOf = names => names.some(n => catMap[n] === 'booking') ? 'booking'
  : (names.map(n => catMap[n]).find(c => c && c !== 'voc') || null);   // 원격voc는 업무 카테고리로 안 씀(설문 VOC로 별도 집계)

/* 미설치(2026-09-24~, 과거분은 백필) — 본문에 [예약]·(예약) 표기가 있고 아래 세 분이 올린 글.
 * 완료로 적재될 글이면 찍힌 카테고리 이모지(원격온보딩·원격as·원격예약…)와 무관하게 'nosetup' 으로 센다.
 * 외주(원격외주)만은 외주로 둔다. 미처리(부재·확인 후 미완료)로 남으면 pending 의 cat 도 nosetup.
 * users:read 가 막혀 있어 멤버 ID 를 박아 둔다(booking-report.js 와 같은 값). 워크플로 글은 작성자가 봇이라 '요청자:' 줄로 본다. */
const RE_BOOKING = /[\[\(（]\s*예약\s*[\]\)）]/;
const RE_REQUESTER = /요청자\s*[:：]\s*([가-힣]{2,4})/;
const NOSETUP_IDS = { U03SA42QD55: '김봉수', U0BS7HSKJ65: '최승훈', U0BAKTSNZ9P: '김규리' };
const NOSETUP_NAMES = Object.values(NOSETUP_IDS);
function isNoSetup(m) {
  const text = blocksText(m);
  if (!RE_BOOKING.test(text)) return false;
  if (NOSETUP_IDS[m.user]) return true;
  const q = text.match(RE_REQUESTER);
  return !!(q && NOSETUP_NAMES.includes(q[1]));
}
// 이모지 이름 목록은 personMap에서 자동 생성 — 입·퇴사 시 personMap만 고치면 됨
const NAMES = Object.keys(personMap).join('|');
const RE_EMP      = new RegExp('^원격(' + NAMES + ')$');          // 원격OOO (완료 담당자)
const RE_CONFIRM  = new RegExp('^(' + NAMES + ')(_?확인.*)?$');    // OOO / OOO확인 / OOO_확인_ (밑줄 유무 모두)
const RE_CONFIRM2 = new RegExp('^(' + NAMES + ')_?확인_?$');       // OOO_확인_
/* VOC 채널의 '<이름>확인' 이모지 — personMap(원격팀 10명)에 없는 사람도 담당자로 인정한다.
 * 10명만 매칭하던 탓에 유나확인·지혜확인처럼 타팀 담당자의 이모지가 통째로 무시됐고,
 * 실제로 저점 185건의 담당자가 전부 '송태양' 한 명으로만 잡혀 있었다.
 * personMap 에 있으면 풀네임(규빈→김규빈)으로, 없으면 이모지에 적힌 이름을 그대로 쓴다. */
const RE_CONFIRM_ANY = /^([가-힣]{2,6})_?확인_?$/;
// 사람 이름이 아닌 '…확인' 이모지 — 담당자로 오인하면 안 되는 것들
const NOT_PERSON = new Set(['아이샵케어','원격','완료','중복','부재','이중','재차','최종','전체','내용','설문','매장','접수','처리','미확인','확인']);
const unknownConfirms = new Set();   // 목록 밖 담당자 — 실행 로그에 남겨 personMap 보강 여부를 판단
function confirmPersonOf(nm) {
  const mm = String(nm || '').match(RE_CONFIRM_ANY);
  if (!mm) return '';
  const raw = mm[1];
  if (personMap[raw]) return personMap[raw];
  if (NOT_PERSON.has(raw)) return '';
  unknownConfirms.add(raw);
  return raw;
}
/* ── 설치 OB ──────────────────────────────────────────────────────────────
 * 원본: 구글시트 '⚒️설치일정 확인해주세요'.
 *   A=접수시각 · B=연락처(읽지 않음) · C=슬랙링크 · D=확인여부 · E=상태 · F=요청자 · G=설치예정일
 * D열(확인여부)은 평소 TRUE/FALSE 체크박스인데, 여기에 담당자 이름(예: 김규빈)이 적히면
 * 그 사람이 설치 OB 1건을 수행한 것으로 본다. 상태(E)가 부재·점주직접접수여도 OB 자체는 수행된 것.
 *
 * 슬랙 채널 스크래핑에서 이걸로 갈아탄 이유: 문구·이모지 이름·스레드 구조 세 가지에 전부
 * 의존해 깨지기 쉬웠고, 실측상 채널 14일치 4,025건에 <이름>확인 이모지가 0건이었다.
 * 시트는 구조화돼 있어 파싱이 필요 없고 API 호출도 1회로 끝난다. */
const OB_SHEET_ID = process.env.OB_SHEET_ID || '1jtCL6xDxExBNiEej6kq25E1NwOOvqHQg5X9Pu20tT_c';
// 집계 시작일 — 이 날 이전 접수 건은 세지 않는다(시트에 1년치가 쌓여 있어 과거분은 제외).
// '이번 달'을 매번 다시 계산하지 않고 고정값으로 둔다. 안 그러면 달이 바뀔 때 지난달 집계가 통째로 사라진다.
const OB_START = process.env.OB_START || '2026-08-01';
const OB_COL = { at: 0, link: 2, who: 3, status: 4, planDate: 6 };   // B(연락처)는 의도적으로 안 읽는다
const OB_NAMES = Object.values(personMap);                            // D열에서 담당자로 인정할 이름

// VOC 저점 사유 자동분류 규칙 (label = 표시 카테고리, kw = 포함되면 그 카테고리로 분류). 순서대로 첫 매칭 우선.
const VOC_REASON_RULES = [
  { label:'사용중 오류가 자주 발생함',            kw:['오류','에러','렉','버그','튕','멈춤','먹통','안돼','안 돼','안됨','안 됨','재실행','재부팅','느리','지연','오작동'] },
  { label:'단말기 설치나 초기 과정이 어려움',      kw:['설치','초기','세팅','연동','연결','프린터','설정','장비'] },
  { label:'고객센터 연락이 매우 힘듦',            kw:['연락','전화','고객센터','상담','통화','응대','문의','콜'] },
  { label:'구매,계약과정에서 설명이 부족',        kw:['설명','계약','구매','안내','가입','상술'] },
  { label:'필요한 기능이 없거나 몰라서 불편',      kw:['기능','없','몰라','모르','불편','어렵','복잡'] },
  { label:'기타 이슈(정산/직원에 대한 불만/호영님출몰)', kw:['정산','직원','호영','불만','태도'] },
];
const VOC_REASON_ETC = '기타 이슈(정산/직원에 대한 불만/호영님출몰)';
function classifyReason(text){
  if(!text) return VOC_REASON_ETC;
  for(const r of VOC_REASON_RULES){ if(r.kw.some(k=>text.includes(k))) return r.label; }
  return VOC_REASON_ETC;
}

// VOC 업종 버킷 매핑 (원본 업종값 → 표시 버킷). 순서대로 첫 매칭 우선.
const VOC_INDUSTRY_RULES = [
  { label:'서비스[뷰티,헤어]', kw:['뷰티','헤어','미용','네일','피부','에스테틱','왁싱','반영구','바버','속눈썹','메이크업','태닝','이용'] },
  { label:'서비스[학원]',      kw:['학원','교습소','교육','공부방','과외','스터디','어학','음악','미술','태권도','피아노'] },
  { label:'카페',             kw:['카페','커피','디저트','브런치','베이커리','제과','빵','도넛','스무디'] },
  { label:'요식업',           kw:['음식','식당','요식','고기','치킨','분식','한식','중식','일식','양식','주점','술집','포차','횟집','뷔페','국밥','김밥','피자','버거','곱창','족발','보쌈','찜','국수','라멘','파스타','돈까스','포장마차','이자카야'] },
  { label:'서비스[체육]',      kw:['체육','헬스','필라테스','요가','골프','스포츠','피티','운동','클라이밍','수영','복싱'] },
  { label:'서비스[숙박]',      kw:['숙박','호텔','모텔','펜션','게스트','여관','민박','리조트'] },
  { label:'도소매',           kw:['도매','소매','판매','마트','편의점','슈퍼','상점','쇼핑','잡화','문구','의류','세탁'] },
];
function mapIndustry(raw){
  if(!raw) return '';
  for(const r of VOC_INDUSTRY_RULES){ if(r.kw.some(k=>raw.includes(k))) return r.label; }
  return '기타';
}
// 칭찬 판별 키워드 — 직원/응대(원격지원) 관련만 적재 (제품 일반칭찬 제외)
const VOC_PRAISE_KW = ['친절','응대','영상통화','화상통화','전화','설명','신속','대응','사용법','상담','도움','세심','꼼꼼','안내','알려주','알려 주','가르쳐','자세히','차근차근','정성','기사님','기사분','직원','담당자','원격지원','케어','챙겨','상냥'];
// 고점 기준 (만점)
const VOC_HIGH_INSTALL = 5;  // 구매설치 5 (만점)
const VOC_HIGH_NPS = 10;     // 추천의향 10 (만점)
// '확인 후 미완료' 유예: 확인 이모지 뒤에도 완료/카테고리 이모지가 안 찍힌 채 이 시간이 지나야 미처리로 적재.
// (슬랙 API가 이모지 시각을 안 주므로 메시지 게시 시각 기준 경과시간으로 근사)
const CONFIRM_GRACE_SEC = 3600; // 1시간
const RESP_DELAY_MIN = 30;      // 응대 지연 기준: 첫 확인까지 30분 초과 시 '지연'
const pad = n => String(n).padStart(2, '0');

// 집계 대상 날짜: TALLY_DATE_OFFSET (0=오늘, -1=어제). 새벽 최종집계는 -1 로 '전날' 마감.
const offset = parseInt(process.env.TALLY_DATE_OFFSET || '0', 10);
// 업무일 = 05:30 ~ 다음날 01:00 KST.
//  - 05:30 : 새벽 출근자 근무 시작
//  - 01:00 : 야간당직 종료. 00:30 건은 달력상 다음날이지만 '그 전날' 업무로 잡는다.
//  - 01:00~05:30 은 고객센터 운영시간이 아니라 어느 업무일에도 넣지 않는다(사용자 확인).
//    실측 76일 기준 이 구간 3건(0.03%) — 집계에서 빠진다.
const DAY_START_MIN = 5 * 60 + 30;   // 05:30 업무 시작
const DAY_END_MIN = 1 * 60;          // 다음날 01:00 마감
const now = new Date();
// 업무일 기준 '지금' — 05:30 이전이면 아직 전날 업무일(또는 방금 닫힌 업무일)이다
const kstNow = new Date(now.getTime() + 9 * 3600 * 1000 - DAY_START_MIN * 60 * 1000);
const tgt = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() + offset));
const Y = tgt.getUTCFullYear(), M = tgt.getUTCMonth(), D = tgt.getUTCDate();
const targetDate = `${Y}-${pad(M + 1)}-${pad(D)}`;
const oldest = (Date.UTC(Y, M, D) + (DAY_START_MIN - 540) * 60 * 1000) / 1000;          // 대상일 05:30 KST
const latestBound = (Date.UTC(Y, M, D + 1) + (DAY_END_MIN - 540) * 60 * 1000) / 1000;   // 다음날 01:00 KST (상한)
const todayKstDate = `${kstNow.getUTCFullYear()}-${pad(kstNow.getUTCMonth() + 1)}-${pad(kstNow.getUTCDate())}`;  // 완료 처리된 '오늘' 업무일

// 날짜 유틸 (YYYY-MM-DD ↔ KST 하루 경계)
function dateUTC(s) { const [y, mo, da] = s.split('-').map(Number); return Date.UTC(y, mo - 1, da); }
// 업무일 = 05:30 ~ 다음날 01:00 KST (540 = UTC→KST 9시간을 분으로 환산)
function boundsOf(s) { const t = dateUTC(s); return {
  oldest: (t + (DAY_START_MIN - 540) * 60 * 1000) / 1000,
  latestBound: (t + 86400000 + (DAY_END_MIN - 540) * 60 * 1000) / 1000 }; }
function dateList(fromS, toS) { const out = []; for (let t = dateUTC(fromS), e = dateUTC(toS); t <= e; t += 86400000) { const d = new Date(t); out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`); } return out; }

// 백필: BACKFILL_FROM=YYYY-MM-DD 지정 시 그 날부터 오늘까지 모든 카테고리를 날짜별로 다시 적재 (일회성)
const backfillFrom = (process.env.BACKFILL_FROM || '').trim();
// VOC 롤링 재집계 시작일 = min(오늘-VOC_LOOKBACK일, 백필시작일). 과거 설문에 뒤늦게 '확인+완료' 이모지 찍히면 반영.
const VOC_LOOKBACK = 30;
const defMinObj = new Date(Date.UTC(Y, M, D - VOC_LOOKBACK));
const defMin = `${defMinObj.getUTCFullYear()}-${pad(defMinObj.getUTCMonth() + 1)}-${pad(defMinObj.getUTCDate())}`;
const minDate = (backfillFrom && backfillFrom < defMin) ? backfillFrom : defMin;
const oldestWide = boundsOf(minDate).oldest;

/* ── 이모지 규칙 전환 (착수 표시: 'XX확인' → '원격XX') ──────────────────────────
 * 팀이 요청글을 잡을 때 찍는 첫 이모지를 'XX확인' 대신 '원격XX' 로 바꿨다.
 * 완료 시 카테고리 이모지(원격as·원격온보딩·원격명의변경·원격배달·원격예약·원격외주)를 찍는 건 그대로다.
 *
 * 옛 규칙: '원격XX' = 완료 담당자 (AS채널에선 카테고리 이모지가 없어도 완료로 적재)
 * 새 규칙: '원격XX' = 착수 표시 (= 예전의 'XX확인'). 완료는 카테고리 이모지·원격외주가 결정.
 *
 * 전환일 이전 글은 옛 규칙 그대로 둔다 — 롤링 재집계(최근 3일 + 미처리 잔여일)가
 * 과거의 '원격XX만 찍고 끝낸' 완료 건을 누락으로 뒤집으면 안 되기 때문. */
const EMOJI_RULE_CUTOVER = '2026-09-16';                             // 이 업무일부터 새 규칙
const EMOJI_RULE_CUTOVER_TS = boundsOf(EMOJI_RULE_CUTOVER).oldest;   // 그 업무일 시작(05:30 KST)
const newEmojiRule = ts => parseFloat(ts || '0') >= EMOJI_RULE_CUTOVER_TS;

function kstHM(ts) {
  const d = new Date(parseFloat(ts) * 1000 + 9 * 3600 * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function nowKstStamp() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
// 타임스탬프 → 업무일. 00:30 건은 전날(야간당직), 01:00~05:29 는 운영시간 밖이라 ''(제외).
// boundsOf 범위와 정확히 짝을 이룬다 — 여기서 ''로 빠지는 건은 어느 날 범위에도 안 들어간다.
function kstDate(ts) {
  const d = new Date(parseFloat(ts) * 1000 + 9 * 3600 * 1000);
  const mod = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mod < DAY_END_MIN) {                        // 00:00~00:59 → 전날 업무일
    const p = new Date(d.getTime() - 86400000);
    return `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-${pad(p.getUTCDate())}`;
  }
  if (mod < DAY_START_MIN) { return ''; }         // 01:00~05:29 → 운영시간 밖
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function freshVoc() {
  return { responses: 0, install: { count: 0, low: 0 }, nps: { count: 0, low: 0 }, high: { install: 0, nps: 0 }, npsDist: {}, installDist: {}, byIndustry: {}, byTenure: {}, byVan: {}, reasonCounts: {}, alerts: [], praises: [], latest: '' };
}

async function fetchAll(channelId) {
  let cursor = '', msgs = [], guard = 0;
  do {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channelId);
    url.searchParams.set('oldest', String(oldest));
    url.searchParams.set('latest', String(latestBound));
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    msgs = msgs.concat(j.messages || []);
    cursor = (j.response_metadata && j.response_metadata.next_cursor) || '';
  } while (cursor && ++guard < 20);
  return msgs;
}

// 지정 기간(oldest~latest) 메시지 전체 읽기 (VOC 롤링 재집계용)
async function fetchAllRange(channelId, oldestTs, latestTs) {
  let cursor = '', msgs = [], guard = 0;
  do {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channelId);
    url.searchParams.set('oldest', String(oldestTs));
    url.searchParams.set('latest', String(latestTs));
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    msgs = msgs.concat(j.messages || []);
    cursor = (j.response_metadata && j.response_metadata.next_cursor) || '';
  } while (cursor && ++guard < 40);
  return msgs;
}

// 스레드 답글 읽기 (VOC 처리내용 자동 수집용). rate-limit/scope 문제로 실패해도 절대 throw하지 않음.
let repliesFetched = 0, repliesWarned = false;
// 과도한 API 호출/rate-limit 방지 상한 (업무 처리내역 + VOC 공용).
// 일회성 백필은 과거 전체 이력의 note를 한 번에 채워야 하므로 크게, 평시 롤링은 보수적으로.
const MAX_REPLY_FETCH = backfillFrom ? 3000 : 500;
async function fetchReplies(channelId, ts) {
  if (repliesFetched >= MAX_REPLY_FETCH) {
    if (!repliesWarned) { console.log(`  (처리내용 자동수집 상한 ${MAX_REPLY_FETCH}건 도달 — 이후 생략)`); repliesWarned = true; }
    return [];
  }
  repliesFetched++;
  try {
    const url = new URL('https://slack.com/api/conversations.replies');
    url.searchParams.set('channel', channelId);
    url.searchParams.set('ts', ts);
    url.searchParams.set('limit', '50');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) return [];                       // 429 등 HTTP 오류
    const j = await res.json().catch(() => ({})); // JSON 파싱 실패 방어
    if (!j.ok) return [];                          // missing_scope 등
    return (j.messages || []).slice(1); // 첫 메시지(부모=설문)는 제외
  } catch (e) { return []; }
}
// 처리내용 텍스트 정리(멘션/URL/마크다운 제거 후 요약 길이로 컷)
function cleanNote(s) {
  return (s || '')
    .replace(/<https?:\/\/[^>|]+(?:\|[^>]+)?>/g, '')   // slack 링크
    .replace(/https?:\/\/\S+/g, '')                     // 맨 URL
    .replace(/<@[^>]+>/g, '').replace(/<#[^>]+>/g, '')  // 멘션
    .replace(/[*_>`~]/g, '').replace(/:[a-z0-9_+\-]+:/gi, '')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

// 한 채널의 메시지를 공유 counts/pending/done 에 누적
async function tallyInto(msgs, ch, counts, pending, done, opts) {
  done = done || [];
  const priorNotes = (opts && opts.priorNotes) || {};   // 이전 실행에서 이미 수집한 처리내역(재호출 방지)
  // 스레드 처리내역 수집: 이미 있으면 재사용, 없고 답글 있으면 첫 답글들 텍스트를 정리해 저장
  async function grabNote(m, catKey, time, store, biz) {
    const key = time + '|' + store + '|' + biz + '|' + catKey;
    if (priorNotes[key]) return priorNotes[key];
    if ((m.reply_count || 0) > 0 && ch.id) {
      const reps = await fetchReplies(ch.id, m.ts);
      // blocksText는 m.text와 m.blocks의 동일 내용을 둘 다 담아 문구가 중복됨 → 답글별 동일 줄 제거
      const txt = reps.map(r => [...new Set(blocksText(r).split('\n').map(x => x.trim()).filter(Boolean))].join(' ')).join(' / ');
      return cleanNote(txt);
    }
    return '';
  }
  let completed = 0, externCount = 0, dup = 0, latest = '';
  for (const m of msgs) {
    if (m.subtype && m.subtype !== 'bot_message') continue; // 봇 접수 메시지(메뉴채널)는 집계, 시스템 메시지는 제외
    const time = kstHM(m.ts);
    if (time > latest) latest = time;
    const names = (m.reactions || []).map(r => r.name);
    const urgent = names.some(n => /(긴급|사이렌|urgent|siren|rotating_light|경보|비상|sos|alert)/i.test(n)) || undefined;   // 긴급/사이렌 이모지 → '재빠른' 타이틀용
    const text = m.text || '';
    let store = (((text.match(/상호\s*[:：]?\s*(.+)/) || [])[1]) || ((text.match(/매장명\s*[:：]?\s*(.+)/) || [])[1]) || '').trim().split('/')[0].trim();
    if (store.length > 30) store = store.slice(0, 30);
    const biz = ((text.match(/사업자\s*번?호?\s*[:：]?\s*([\d\-]+)/) || [])[1] || '').replace(/-/g, '').trim();
    const req = ((text.match(/내용\s*[:：]?\s*(.+)/) || [])[1] || '').trim().slice(0, 140);   // 요청 '내용' 필드(문제 유형 분류용)
    const hw = ((text.match(/(?:하드웨어|장비|기종|hw)\s*[:：]?\s*(.+)/i) || [])[1] || '').trim().slice(0, 60);   // 하드웨어 필드 → AS 유형 분류 우선 반영(글 수정 시 반영됨)
    // 인입유형(온라인/오프라인) — '인입유형:' 또는 '오프/온라인:' 라벨 파싱. 미기재(미상)는 온라인으로 적재(팀 정책).
    const intakeRaw = ((text.match(/(?:인입\s*유형|오프\s*\/?\s*온라인)\s*[:：]?\s*([^\n\/]*)/) || [])[1] || '');
    const intake = /오프라인/.test(intakeRaw) ? 'offline' : 'online';

    let emp = null;
    for (const n of names) { const pm = n.match(RE_EMP); if (pm) { emp = personMap[pm[1]]; break; } }
    const emojiCat = workCatOf(names);
    const hasVocTag = names.includes('원격voc');
    const hasExtern = names.includes('원격외주');
    let confirmPerson = null;
    for (const n of names) { const cm = n.match(RE_CONFIRM); if (cm) { confirmPerson = personMap[cm[1]]; break; } }
    const hasAbsent = names.some(n => /부재/.test(n));                       // 1차/2차 부재
    const absTag = names.some(n => /2차.?부재/.test(n)) ? '2차 부재' : '1차 부재';
    const hasDup = names.some(n => /중복/.test(n));                          // 팀이 '진짜 중복'에만 찍는 표시
    const hasX = names.includes('x');                                        // ❌ = 잘못 올린 글 표시
    const doer = emp || confirmPerson;
    // 착수(손댐) 표시를 낸 사람 — 새 규칙엔 '원격XX', 옛 규칙엔 'XX확인'
    const newRule = newEmojiRule(m.ts);
    const toucher = newRule ? doer : confirmPerson;
    const invalidPost = hasX && !!toucher;                                   // 착수 + X → 잘못 올린 글 → 부재/미처리 제외
    const ageSec = now.getTime() / 1000 - parseFloat(m.ts || '0');   // 메시지 게시 후 경과(초) — 확인/부재 유예 판정용

    const noSetup = isNoSetup(m);
    const pendCat = noSetup ? 'nosetup' : ch.defaultCat;   // 미처리로 남을 때 표시 카테고리

    if (hasDup) { dup++; continue; }         // 중복 이모지 → 집계 제외 (재처리는 중복 표시 없으니 별개 건으로 정상 집계됨)

    if (hasVocTag && !emojiCat) { continue; }   // 원격voc만 찍힌 순수 VOC 참조 → 업무 집계 제외(설문 VOC로만 관리)

    // requireCat 채널(명의변경/메뉴등록/배달)은 카테고리 이모지가 찍힌 것만 집계 → 카테고리는 항상 emojiCat이 결정.
    // (예: 명의변경 채널에 원격as가 찍히면 AS로 집계, 원격명의변경이 찍혀야 명의변경으로 집계)
    if (hasExtern && doer) {                 // 외주 → 별도 집계
      const who = doer || '미지정';
      counts.extern = counts.extern || {};
      counts.extern[who] = (counts.extern[who] || 0) + 1; externCount++;
      done.push({ time, store, biz, cat: 'extern', emp: who, req, hw, urgent, intake, note: await grabNote(m, 'extern', time, store, biz) });
    } else if (emojiCat || (emp && !ch.requireCat && !newRule)) {   // 카테고리 이모지 있음. (옛 규칙 한정) AS채널은 '원격XX'만 있어도 완료→defaultCat
      const catKey = noSetup ? 'nosetup' : (emojiCat || ch.defaultCat);
      const who = emp || confirmPerson || '미지정';
      counts[catKey] = counts[catKey] || {};
      counts[catKey][who] = (counts[catKey][who] || 0) + 1; completed++;
      done.push({ time, store, biz, cat: catKey, emp: who, req, hw, urgent, intake, note: await grabNote(m, catKey, time, store, biz) });
    } else if (hasAbsent && !invalidPost) {  // 완료·카테고리 이모지 없이 '부재만' (확인+X 잘못올린글 제외)
      // 2차부재(재부재=연락 불가)는 확인필요에서 제외, 1차부재만 — 그것도 1시간 지나야 확인필요로 적재
      if (absTag !== '2차 부재' && ageSec >= CONFIRM_GRACE_SEC) pending.push({ time, store, biz, handler: doer || '미지정', cat: pendCat, intake, reasons: [absTag] });
    } else if (toucher && !invalidPost) { // 착수만 찍힘 → 1시간 지나면 '확인 후 미완료' (착수+X 잘못올린글 제외)
      if (ageSec >= CONFIRM_GRACE_SEC) pending.push({ time, store, biz, handler: toucher, cat: pendCat, intake, reasons: ['확인 후 미완료'] });
    }
  }
  return { completed, externCount, dup, latest };
}

// 따옴표·개행이 든 셀까지 처리하는 최소 CSV 파서
function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
// "2026년 8월 3일 오전 7:48:50" / "2026.8.4" / "2026-08-04" → "2026-08-04" (실패 시 '')
function obParseDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) m = t.match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
}
// 시트 CSV → 설치 OB 수행 건 목록. D열에 직원 이름이 적힌 행만.
function parseObSheet(csv, stats) {
  const st = stats || {};
  const rows = parseCsv(csv);
  const data = rows.slice(2).filter(rw => (rw || []).some(c => String(c || '').trim()));   // 1행 헤더 · 2행 예시
  st.rows = data.length; st.named = 0; st.unknownName = 0; st.beforeStart = 0;
  const seen = {}, out = [];
  const byStatus = {};
  for (const rw of data) {
    const who = String(rw[OB_COL.who] || '').trim();
    if (!who || who === 'TRUE' || who === 'FALSE') continue;      // 체크박스 값은 담당자 아님
    if (!OB_NAMES.includes(who)) { st.unknownName++; continue; }  // 오타·타팀 이름은 세지 않는다
    st.named++;
    const at = String(rw[OB_COL.at] || '').trim();
    const recv = obParseDate(at);
    if (recv && recv < OB_START) { st.beforeStart++; continue; }  // 집계 시작일 이전 접수 건은 제외
    const link = String(rw[OB_COL.link] || '').trim();
    // 같은 (접수시각|링크) 가 겹치는 옛 행이 있어 발생순번을 붙여 키를 유일하게 만든다
    const base = at + '|' + link;
    seen[base] = (seen[base] || 0) + 1;
    const key = base + '#' + seen[base];
    const status = String(rw[OB_COL.status] || '').trim();
    byStatus[status || '(빈칸)'] = (byStatus[status || '(빈칸)'] || 0) + 1;
    out.push({
      key, handler: who, status,
      recvDate: recv,                                  // 접수일 — 첫 집계 분산용
      planDate: obParseDate(rw[OB_COL.planDate]),      // 설치예정일 (없을 수 있음)
      link,
    });
  }
  st.byStatus = byStatus;
  return out;
}
// 시트를 CSV 로 내려받는다. drive.readonly 스코프로 되므로 Sheets API 권한 추가가 필요 없다.
async function fetchObSheet() {
  const { GDRIVE_CLIENT_ID: id, GDRIVE_CLIENT_SECRET: sec, GDRIVE_REFRESH_TOKEN: rt } = process.env;
  if (!id || !sec || !rt) throw new Error('GDRIVE_* 환경변수 없음');
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: sec, refresh_token: rt, grant_type: 'refresh_token' }),
  });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error('토큰 갱신 실패: ' + (tj.error_description || tj.error || '?'));
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${OB_SHEET_ID}/export?mimeType=text%2Fcsv`,
    { headers: { Authorization: 'Bearer ' + tj.access_token } });
  if (!r.ok) throw new Error('시트 export 실패 HTTP ' + r.status);
  return await r.text();
}

// 찾은 완료 건들을 '완료일' 버킷에 넣어 data.days[*].ob 로 기록.
// priorDone: ts→이미 정해진 완료일 · keep: 재조회 창 밖이라 보존해야 할 기존 항목(날짜별)
function applyObResults(data, found, o) {
  const byDay = {};
  for (const it of found) {
    // 첫 집계(기존 OB 데이터가 전혀 없음)면 접수일로 흩뿌린다 — 안 그러면 과거분이 전부 오늘로 몰린다
    const dd = o.priorDone[it.key] || (o.hadAnyOb ? o.todayKstDate : (it.recvDate || o.todayKstDate));
    (byDay[dd] = byDay[dd] || []).push(it);
  }
  // 기존 날짜도 다시 계산한 값으로 덮는다 — 시트에서 이름을 지우거나 행을 삭제하면 반영된다
  const touch = new Set([...Object.keys(byDay), ...Object.keys(data.days).filter(d => data.days[d].ob && d >= o.obMinDate)]);
  let total = 0;
  for (const d of touch) {
    const items = [...((o.keep || {})[d] || []), ...(byDay[d] || [])];
    items.sort((a, b) => String(b.key || '').localeCompare(String(a.key || '')));
    const byEmp = {};
    for (const it of items) byEmp[it.handler] = (byEmp[it.handler] || 0) + 1;
    const de = data.days[d] || { updatedAt: '', counts: {}, pending: [] };
    de.ob = { count: items.length, byEmp, items };
    data.days[d] = de;
    total += items.length;
  }
  return { total, days: touch.size };
}

// ── 폴링식 응답시간 추적 ──
// 슬랙이 이모지(확인) 찍힌 시각을 안 주므로, 10분마다 도는 이 집계가 스냅샷을 비교해 근사:
//  · 확인 이모지 없는 요청 → watch에 담고 매 실행 lastSeen 갱신
//  · 이전에 watch에 있던(=확인 없던) 요청에 확인이 붙으면 → 응답시각 ≈ (lastSeen, now) 중간값 → 응답분 확정
//  · 처음 볼 때 이미 확인됨(측정 불가)·2일 넘게 무응답 → 제외  ⇒ 자연히 '배포 이후' 건만 측정 (해상도 ±폴링간격)
/* 셀프 처리 판정 — 자기가 올린 요청글에 자기가 확인·완료 이모지를 찍은 건.
 * 남을 기다린 시간이 0 이라 응답/소요시간 표본에 넣으면 평균이 실제보다 좋게 나온다.
 * 슬랙 reactions[].users 에 찍은 사람 ID 가 오므로 작성자(m.user)와 대조한다.
 * 봇 접수글(m.user 없음)이나 users 를 안 주는 경우는 판정 불가 → 기존대로 집계. */
function selfHandled(m) {
  const author = m.user;
  if (!author) return false;
  return (m.reactions || []).some(r => {
    if (!Array.isArray(r.users) || !r.users.includes(author)) return false;
    return RE_CONFIRM.test(r.name) || RE_EMP.test(r.name) || r.name === '원격외주'
        || (catMap[r.name] && catMap[r.name] !== 'voc');
  });
}
let selfSkipped = 0;   // 실행 로그용 — 셀프 처리로 제외한 건수
function trackResp(data, msgs, ch) {
  data.resp = data.resp || { watch: {}, days: {} };
  const W = data.resp.watch, DD = data.resp.days;
  const nowSec = now.getTime() / 1000;
  for (const m of msgs) {
    if (m.subtype && m.subtype !== 'bot_message') continue;
    const key = m.ts, postSec = parseFloat(m.ts || '0');
    if (!postSec) continue;
    const names = (m.reactions || []).map(r => r.name);
    if (names.some(n => /중복/.test(n)) || names.includes('x')) { delete W[key]; continue; }   // 중복·X(잘못올린글) → 표본 제외
    if (selfHandled(m)) { selfSkipped++; delete W[key]; continue; }   // 본인이 올린 글에 본인이 찍음 → 대기가 없던 건이라 제외
    const hasCat = names.some(n => catMap[n] && catMap[n] !== 'voc');
    const hasEmp = names.some(n => RE_EMP.test(n));
    const hasConfirm = names.some(n => RE_CONFIRM.test(n));
    const hasExtern = names.includes('원격외주');
    const responded = hasCat || hasEmp || hasConfirm || hasExtern;   // 담당자가 손댐(확인/완료/카테고리/외주)
    // 완료 = 카테고리(원격as·원격온보딩…)·원격외주 이모지. 처리를 끝냈을 때 찍으므로 '소요시간'의 종점.
    // 착수 표시('원격XX' — 옛 규칙에선 'XX확인')는 손댔다는 신호라 응답시간의 종점이고, 소요시간에는 쓰지 않는다.
    // 옛 규칙 글에서는 '원격XX'가 완료 담당자였으므로 그때만 종점으로 인정한다.
    const finished = hasCat || hasExtern || (hasEmp && !newEmojiRule(m.ts));
    const w = W[key];
    if (!w) {
      // 처음 볼 때 이미 이모지가 찍혀 있으면 언제 찍혔는지 알 수 없어 제외. 아무것도 없을 때만 관찰 시작.
      if (!responded) W[key] = { post: key, lastSeen: nowSec };
      continue;
    }
    // 카테고리 판정(tallyInto 규칙). 전 카테고리를 측정해 cat 과 함께 남긴다 — 대시보드가 카테고리별로 나눠 본다.
    // (전체 응답·소요시간 카드는 전 카테고리를 쓴다 — 제외하려면 대시보드 RESP_EXCL_CATS)
    const emojiCat = workCatOf(names);
    const catKey = names.includes('원격외주') ? 'extern' : (isNoSetup(m) ? 'nosetup' : (emojiCat || (ch && ch.defaultCat) || 'as'));
    const day = kstDate(m.ts);
    if (!day) { delete W[key]; continue; }             // 운영시간 밖(01:00~05:30) — 표본에서 제외
    const mid = (w.lastSeen + nowSec) / 2;             // 이모지는 (lastSeen, now) 사이에 찍힘 → 중간값 추정

    if (!w.r && responded) {                           // ① 응답(첫 확인) 확정
      const respMin = Math.max(0, (mid - postSec) / 60);
      DD[day] = DD[day] || { cnt: 0, sumMin: 0, over: 0, items: [] };
      DD[day].items = DD[day].items || [];
      DD[day].cnt++; DD[day].sumMin += respMin; if (respMin > RESP_DELAY_MIN) DD[day].over++;
      // 건별 상세(올라온시간·응답분·상호·담당·카테고리) 저장 — 상세 모달용
      const text = m.text || '';
      let store = (((text.match(/상호\s*[:：]?\s*(.+)/) || [])[1]) || ((text.match(/매장명\s*[:：]?\s*(.+)/) || [])[1]) || '').trim().split('/')[0].trim();
      if (store.length > 30) store = store.slice(0, 30);
      const biz = ((text.match(/사업자\s*번?호?\s*[:：]?\s*([\d\-]+)/) || [])[1] || '').replace(/-/g, '').trim();
      let who = '';
      for (const n of names) { const pm = n.match(RE_EMP); if (pm) { who = personMap[pm[1]]; break; } }
      if (!who) for (const n of names) { const cm = n.match(RE_CONFIRM); if (cm) { who = personMap[cm[1]]; break; } }
      DD[day].items.push({ hm: kstHM(m.ts), min: Math.round(respMin * 10) / 10, store, biz, who, cat: catKey });
      w.r = 1; w.day = day; w.idx = DD[day].items.length - 1;
    }
    if (!w.d && finished) {                            // ② 완료 확정 → 소요시간(dmin)을 같은 건에 붙인다
      const doneMin = Math.max(0, (mid - postSec) / 60);
      const arr = (DD[w.day] && DD[w.day].items) || null;
      const it = arr && w.idx != null ? arr[w.idx] : null;
      if (it) { it.dmin = Math.round(doneMin * 10) / 10; it.cat = catKey; }   // 완료 이모지가 최종 카테고리
      w.d = 1;
    }
    if (w.r && w.d) delete W[key];                     // 둘 다 측정 완료 → 관찰 종료
    else w.lastSeen = nowSec;                          // 아직 남았으면 계속 관찰
  }
  for (const k in W) { if (nowSec - parseFloat(W[k].post) > 2 * 86400) delete W[k]; }   // 무응답 2일 경과 정리
}

// 메시지의 blocks까지 모두 훑어 텍스트 재구성 (봇 리치 메시지 대응)
function collectText(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return; }
  if (typeof node === 'object') {
    if (typeof node.text === 'string') out.push(node.text);
    for (const k in node) { const val = node[k]; if (val && typeof val === 'object') collectText(val, out); }
  }
}
function blocksText(m) {
  const out = [m.text || ''];
  collectText(m.blocks, out);
  collectText(m.attachments, out);
  return out.join('\n');
}

// VOC 설문 응답 파싱 → 점수/업종/저점사유 집계
// opts = { dayDate: 이 메시지들의 날짜(YYYY-MM-DD), todayKstDate, priorMap: {key:{doneDate,autoNote}}, noteSince: ts }
async function tallyVoc(msgs, voc, channelId, opts) {
  opts = opts || {};
  for (const m of msgs) {
    if (m.subtype && m.subtype !== 'bot_message') continue;
    let text = blocksText(m).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    if (!/merchant_service_feedback|서비스 피드백/.test(text)) continue; // 설문 응답만
    const time = kstHM(m.ts);
    if (time > voc.latest) voc.latest = time;

    // 문항(*...*) → 답변(> ...) 페어링
    const qa = []; let curQ = null, curA = [];
    for (let ln of text.split('\n')) {
      ln = ln.trim();
      const qm = ln.match(/^\*(.+?)\*$/);
      if (qm) { if (curQ !== null) qa.push([curQ, curA.join(' ').trim()]); curQ = qm[1].trim(); curA = []; continue; }
      const am = ln.match(/^>\s*(.+)/);
      if (am && curQ !== null) curA.push(am[1].trim());
    }
    if (curQ !== null) qa.push([curQ, curA.join(' ').trim()]);

    let install = NaN, installReason = '', nps = NaN, npsReason = '', industry = '';
    for (let i = 0; i < qa.length; i++) {
      const q = qa[i][0], a = qa[i][1];
      if (/구매설치 경험/.test(q)) { install = parseFloat(a); if (qa[i+1] && /이유/.test(qa[i+1][0])) installReason = qa[i+1][1]; }
      else if (/추천할 의향이 얼마나/.test(q)) { nps = parseFloat(a); if (qa[i+1] && /이유/.test(qa[i+1][0])) npsReason = qa[i+1][1]; }
      else if (/업종을 선택/.test(q)) { industry = a; }
    }
    const attr = (name) => { const mm = text.match(new RegExp('\\*' + name + '\\*\\s*\\n\\s*([^\\n]+)')); return mm ? mm[1].trim() : ''; };
    const store = attr('매장명'), storeId = attr('매장ID'), tenure = attr('수집 유형'), van = attr('밴');

    // VOC 담당자 = '원격voc' 이모지 + '원격OOO'(완료 담당자)가 둘 다 찍힌 경우 그 사람 (설문 적재는 점수대로 유지, 담당자만 이 기준)
    const names = (m.reactions || []).map(r => r.name);
    // 🆕 VOC 처리완료 = OOO_확인_(담당 확인) + 완료완료(완료=아이샵케어 VOC체크) 두 개
    const hasVocTag = names.includes('원격voc');
    const hasIshop = names.includes('완료완료');
    let confirmP = null, remoteP = null;
    for (const nm of names) {
      let mm;
      if (!confirmP) confirmP = confirmPersonOf(nm) || null;
      if (!remoteP  && (mm = nm.match(RE_EMP)))     remoteP = personMap[mm[1]];
    }
    // 확인 + 아이샵케어 VOC체크(ishopcare). 새 규칙에선 담당 확인을 '원격XX'로 찍으므로 그것도 인정한다.
    const autoDone = !!(confirmP || (newEmojiRule(m.ts) && remoteP)) && hasIshop;
    const handler = confirmP || remoteP || '';
    // 담당자(emp): 처리완료면 handler, 아니면 구방식(원격voc+원격OOO) 호환
    const empVal = autoDone ? handler : ((hasVocTag && remoteP) ? remoteP : '');
    const allAns = qa.map(x => x[1]).join(' ');
    const hasPraiseWord = VOC_PRAISE_KW.some(k => allAns.includes(k));

    voc.responses++;
    const indBucket = mapIndustry(industry);       // 원본 업종 → 7개 버킷(+기타)
    if (indBucket) voc.byIndustry[indBucket] = (voc.byIndustry[indBucket] || 0) + 1;
    const reasons = [];
    if (!isNaN(install)) { voc.install.count++; voc.installDist[install] = (voc.installDist[install] || 0) + 1; if (install <= 2) { voc.install.low++; const c = classifyReason(installReason); voc.reasonCounts[c] = (voc.reasonCounts[c] || 0) + 1; reasons.push({ q: '구매설치', score: install, text: installReason, cat: c }); } else if (install >= VOC_HIGH_INSTALL) voc.high.install++; }
    if (!isNaN(nps))     { voc.nps.count++; voc.npsDist[nps] = (voc.npsDist[nps] || 0) + 1;             if (nps <= 5)     { voc.nps.low++;     const c = classifyReason(npsReason);     voc.reasonCounts[c] = (voc.reasonCounts[c] || 0) + 1; reasons.push({ q: '추천의향', score: nps, text: npsReason, cat: c }); } else if (nps >= VOC_HIGH_NPS) voc.high.nps++; }
    const isLow = reasons.length > 0;
    if (tenure) { if (!voc.byTenure[tenure]) voc.byTenure[tenure] = { total: 0, low: 0 }; voc.byTenure[tenure].total++; if (isLow) voc.byTenure[tenure].low++; }
    if (van)    { if (!voc.byVan[van])       voc.byVan[van]       = { total: 0, low: 0 }; voc.byVan[van].total++;       if (isLow) voc.byVan[van].low++; }
    if (reasons.length) {
      const key = (opts.dayDate || '') + '|' + (storeId || '') + '|' + time;   // 대시보드 vocKey와 동일 규칙
      const prior = (opts.priorMap || {})[key] || {};
      // 처리내용 자동 수집: 스레드 답글 텍스트를 정리해서 기입 (이전에 수집한 값이 있으면 재사용 → 안정성·API 절약)
      let autoNote = prior.autoNote || '';
      if (!autoNote && (m.reply_count || 0) > 0 && channelId && (!opts.noteSince || parseFloat(m.ts) >= opts.noteSince)) {
        const reps = await fetchReplies(channelId, m.ts);
        autoNote = cleanNote(reps.map(r => blocksText(r)).join(' / '));
      }
      // 완료일 = 최초로 완료 감지한 날(오늘). 한 번 기록되면 유지 → 이후엔 완료한 날짜대로 일별 분산.
      // (첫 집계 때는 그동안 밀린 완료건이 한 번 '오늘'로 몰릴 수 있음)
      const doneDate = empVal ? (prior.doneDate || opts.todayKstDate || '') : '';
      voc.alerts.push({ time, store, storeId, industry, indBucket, install: isNaN(install) ? null : install, nps: isNaN(nps) ? null : nps, reasons,
        emp: empVal,
        autoStatus: autoDone ? '처리완료' : '', autoEmp: autoDone ? handler : '', autoNote, doneDate });
    }

    // 칭찬/일반 응답 적재: 저점이 아니면서 처리(담당자) 또는 칭찬 문구가 있는 건 (emp 있으면 '처리'로 집계됨)
    if (!reasons.length && (empVal || hasPraiseWord)) {
      const pkey = (opts.dayDate || '') + '|' + (storeId || '') + '|' + time;
      const pprior = (opts.priorMap || {})[pkey] || {};
      const pdoneDate = empVal ? (pprior.doneDate || opts.todayKstDate || '') : '';
      const ptext = (installReason + ' ' + npsReason).trim() || allAns.slice(0, 100);
      voc.praises.push({ time, store, storeId, indBucket, emp: empVal, install: isNaN(install) ? null : install, nps: isNaN(nps) ? null : nps, text: ptext, byReaction: !!empVal, doneDate: pdoneDate });
    }
  }
}

(async () => {
  const vocCh = CHANNELS.find(c => c.type === 'voc');
  const workChs = CHANNELS.filter(c => c.type !== 'voc');

  // 기존 데이터 로드
  let data = { version: 0, days: {} };
  if (fs.existsSync(OUT)) {
    const win = {};
    try { new Function('window', fs.readFileSync(OUT, 'utf8'))(win); if (win.SLACK_DATA) data = win.SLACK_DATA; } catch (e) {}
  }
  data.days = data.days || {};

  // ===== 업무 채널 집계 (백필이면 BACKFILL_FROM~오늘, 아니면 최근 3일 롤링) =====
  // 최근 3일을 매번 다시 훑어, 어제/그제 건에 나중에 찍힌 중복·완료·부재 변경도 반영.
  const wdStartObj = new Date(Date.UTC(Y, M, D - 2));
  const wdStart = `${wdStartObj.getUTCFullYear()}-${pad(wdStartObj.getUTCMonth() + 1)}-${pad(wdStartObj.getUTCDate())}`;
  let workDates = backfillFrom ? dateList(backfillFrom, targetDate) : dateList(wdStart, targetDate);
  if (backfillFrom) console.log(`[백필] ${backfillFrom} ~ ${targetDate} (${workDates.length}일) 재집계`);

  // 미처리가 남아 있는 '오래된 날짜'도 다시 훑는다.
  //
  // 3일 롤링만 돌면, 4일 넘은 누락 건은 슬랙에서 처리해도 그 날짜를 다시 안 보기 때문에
  // pending 에 영원히 남는다(대시보드 '누락 랭킹'에서 안 사라짐 — 실제로 14일·6일 된 건이 있었다).
  // 그렇다고 VOC 처럼 30일을 통째로 훑으면 채널 수만큼 API 호출이 10배가 된다.
  // → 아직 pending 이 남은 날짜만 골라 덧붙인다. 보통 몇 개뿐이고, 처리되면 다음 실행부터 빠진다.
  const STALE_LOOKBACK = 60;      // 이보다 오래된 건 슬랙 히스토리도 못 믿으므로 손대지 않는다
  // 상한. 슬랙 새 글마다 워크플로가 즉시 도는 구조라(2026-08-24 도입) 실행 1회당 API 호출을 묶어둬야 한다.
  // 날짜 하나당 채널 수만큼 호출이 늘어난다. 최근 것부터 처리하고, 처리돼 빠지면 그만큼
  // 더 오래된 날짜가 다음 실행에서 창 안으로 들어온다(자연히 소진된다).
  const STALE_CAP = 10;
  if (!backfillFrom) {
    const lbObj = new Date(Date.UTC(Y, M, D - STALE_LOOKBACK));
    const lbStart = `${lbObj.getUTCFullYear()}-${pad(lbObj.getUTCMonth() + 1)}-${pad(lbObj.getUTCDate())}`;
    const inWindow = new Set(workDates);
    const stale = Object.keys(data.days || {})
      .filter((d) => d >= lbStart && d < wdStart && !inWindow.has(d))
      .filter((d) => (((data.days[d] || {}).pending) || []).length > 0)
      .sort();
    const use = stale.slice(-STALE_CAP);          // 최신 쪽 우선 — 오래된 건 다음 실행에서
    if (stale.length > use.length) {
      console.log(`[미처리 재확인] ${stale.length}일 중 최근 ${use.length}일만 이번에 처리(상한 ${STALE_CAP}) — 나머지는 다음 실행`);
    }
    if (use.length) {
      console.log(`[미처리 재확인] 3일 창 밖에서 미처리가 남은 ${use.length}일 추가 재집계: ${use.join(', ')}`);
      workDates = [...use, ...workDates];
    }
  }
  // 처리내역(note) 수집은 MAX_REPLY_FETCH 상한을 공유하므로, 최신 날짜부터 처리해
  // 사람들이 가장 많이 보는 '오늘' 건의 note가 상한 소진 전에 먼저 채워지도록 한다.
  for (const dstr of [...workDates].reverse()) {
    const b = boundsOf(dstr);
    const counts = {}, pending = [], done = [];
    // 이전 실행에서 수집한 처리내역 보존(재호출 방지) — done 항목 key: time|store|biz|cat
    const priorNotes = {};
    for (const it of (((data.days[dstr] || {}).done) || [])) { if (it.note) priorNotes[it.time + '|' + it.store + '|' + it.biz + '|' + it.cat] = it.note; }
    let completed = 0, externCount = 0, dupTotal = 0, latest = '';
    for (const ch of workChs) {
      let msgs;
      try { msgs = await fetchAllRange(ch.id, b.oldest, b.latestBound); }
      catch (e) { console.error(`  ⚠ [${ch.label} ${dstr}] 읽기 실패(${e.message}) — 건너뜀`); continue; }
      const r = await tallyInto(msgs, ch, counts, pending, done, { priorNotes });
      if (dstr === targetDate) trackResp(data, msgs, ch);   // 오늘 인입 건만 응답시간 폴링 추적
      completed += r.completed; externCount += r.externCount; dupTotal += r.dup; if (r.latest > latest) latest = r.latest;
    }
    pending.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    done.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    const de = data.days[dstr] || {};
    // 아무것도 못 읽었는데 원래 데이터가 있던 날이면 덮어쓰지 않는다.
    // 채널 읽기가 전부 실패했거나(위 catch 는 continue 라 빈 값으로 내려온다) 슬랙 히스토리 보존기간이
    // 지난 오래된 날짜를 다시 훑는 경우, 그대로 대입하면 그 날 집계가 통째로 지워진다.
    const gotNothing = !done.length && !pending.length && !Object.keys(counts).length;
    const hadSomething = (de.done && de.done.length) || (de.pending && de.pending.length) || (de.counts && Object.keys(de.counts).length);
    if (gotNothing && hadSomething) {
      console.log(`  [업무 ${dstr}] 읽은 내용 없음 — 기존 집계 보존(덮어쓰기 생략)`);
      continue;
    }
    // 인입유형 집계 — 전체 원격 건(완료 done + 미처리 pending) 기준 온라인/오프라인/미상
    const intakeAgg = { online: 0, offline: 0, unknown: 0 };
    for (const it of done) intakeAgg[it.intake || 'unknown']++;
    for (const it of pending) intakeAgg[it.intake || 'unknown']++;
    de.counts = counts; de.pending = pending; de.done = done; de.intake = intakeAgg;
    if (latest && latest > (de.updatedAt || '')) de.updatedAt = latest;
    if (!de.updatedAt) de.updatedAt = latest || '';
    data.days[dstr] = de;
    console.log(`  [업무 ${dstr}] 완료 ${completed} · 확인필요 ${pending.length} · 외주 ${externCount} · 중복제외 ${dupTotal}`);
  }

  // ===== 설치 OB 재집계 (구글시트) =====
  // 기준일 = '담당자 이름을 처음 본 날'. 시트에 OB 수행 시각 컬럼이 없어서, 10분마다 도는
  // 이 집계가 새로 등장한 행을 발견한 날을 수행일로 본다(±10분 해상도). 한 번 정해지면 고정.
  // 첫 집계만 예외로 접수일(A열)로 흩뿌린다 — 안 그러면 기존 분이 전부 오늘 하루에 몰린다.
  {
    let csv = null, obErr = '';
    try { csv = await fetchObSheet(); }
    catch (e) { obErr = e.message; console.error(`  ⚠ [설치OB] 시트 읽기 실패(${obErr}) — 이번 실행 생략(기존 값 유지)`); }

    const scan = { at: nowKstStamp(), source: 'sheet', sheet: OB_SHEET_ID, start: OB_START, ok: !!csv, error: obErr,
                   rows: 0, named: 0, unknownName: 0, beforeStart: 0, done: 0, byStatus: {} };
    if (csv) {
      const st = {};
      const found = parseObSheet(csv, st);

      // 이전 실행에서 정해진 수행일(key → 날짜) 보존
      const priorDone = {};
      let hadAnyOb = false;
      for (const d in data.days) for (const it of (((data.days[d].ob) || {}).items) || []) {
        hadAnyOb = true; if (it.key) priorDone[it.key] = d;
      }
      // 시트는 매번 전량을 읽으므로 '창 밖 보존(keep)' 이 필요 없다.
      // obMinDate 를 최소값으로 둬서 기존 ob 날짜를 전부 재계산 대상에 넣는다(행 삭제·이름 지움 반영).
      const r = applyObResults(data, found, { priorDone, keep: {}, hadAnyOb, obMinDate: '0000-00-00', todayKstDate });
      Object.assign(scan, { rows: st.rows, named: st.named, unknownName: st.unknownName,
                            beforeStart: st.beforeStart, done: found.length, byStatus: st.byStatus });
      console.log(`[설치OB] 시트 재집계(${OB_START}~): ${r.total}건 / ${r.days}일 ` +
                  `(시트 ${st.rows}행 · D열 담당자 ${st.named}행` +
                  `${st.beforeStart ? ` · 시작일 이전 제외 ${st.beforeStart}행` : ''}` +
                  `${st.unknownName ? ` · 미등록이름 ${st.unknownName}행` : ''})` +
                  `${hadAnyOb ? '' : ' (첫 집계 — 접수일 기준으로 분산)'}`);
      if (st.named === 0) console.log('  ⚠ D열에 담당자 이름이 적힌 행이 0건 — 아직 아무도 안 적었거나 이름 표기가 다름');
      if (st.unknownName) console.log(`  ⚠ D열에 직원 명단에 없는 이름 ${st.unknownName}행 — 오타이거나 personMap 에 추가 필요`);
    }
    data.obScan = scan;
  }

  // ===== VOC 롤링 재집계 (minDate~오늘) — 과거 설문도 오늘 '확인+완료' 찍히면 오늘 완료로 반영 =====
  let vocDaysTouched = 0, vocResTotal = 0;
  if (vocCh) {
    // 이전 완료일/처리내용 보존용 맵 (완료일은 최초 완료된 날 유지)
    const priorMap = {};
    for (const d in data.days) { const vv = data.days[d].voc; if (!vv) continue; for (const a of [...(vv.alerts || []), ...(vv.praises || [])]) { const k = d + '|' + (a.storeId || '') + '|' + (a.time || ''); priorMap[k] = { doneDate: a.doneDate || '', autoNote: a.autoNote || '' }; } }
    let wide = [];
    try { wide = await fetchAllRange(vocCh.id, oldestWide, latestBound); }
    catch (e) { console.error(`  ⚠ [VOC] 기간 읽기 실패(${e.message}) — VOC 재집계 생략`); }
    const byDate = {};
    for (const m of wide) { if (m.subtype && m.subtype !== 'bot_message') continue; const d = kstDate(m.ts); if (!d || d < minDate) continue; (byDate[d] = byDate[d] || []).push(m); }
    for (const d of Object.keys(byDate).sort()) {
      const vagg = freshVoc();
      try { await tallyVoc(byDate[d], vagg, vocCh.id, { dayDate: d, todayKstDate, priorMap, noteSince: oldestWide }); }
      catch (e) { console.error(`  ⚠ [VOC ${d}] 파싱 실패(${e.message}) — 이 날짜 건너뜀`); continue; }
      if (vagg.responses > 0) {
        const vlatest = vagg.latest; delete vagg.latest;
        const de = data.days[d] || { updatedAt: '', counts: {}, pending: [] };
        de.voc = vagg;
        if (d === targetDate && vlatest && vlatest > (de.updatedAt || '')) de.updatedAt = vlatest;
        data.days[d] = de;
        vocDaysTouched++; vocResTotal += vagg.responses;
      }
    }
  }

  if (unknownConfirms.size) console.log(`[VOC 담당자] personMap 밖 '<이름>확인' 이모지 ${unknownConfirms.size}명 감지: ${[...unknownConfirms].join(', ')} — 원격팀이면 personMap 에 추가(아니면 대시보드 '기타'로 집계)`);
  if (selfSkipped) console.log(`[응답·소요시간] 셀프 처리(본인 글에 본인 이모지) ${selfSkipped}건 표본 제외`);
  console.log(`[완료] 업무 ${workDates.length}일 · VOC ${vocResTotal}응답/${vocDaysTouched}일 재집계`);
  data.version = (data.version || 0) + 1;
  const header = '/*\n * 슬랙 원격 처리 채널(AS요청·명의변경 등) 집계 데이터 (날짜별 누적)\n * GitHub Actions(daily-slack-tally)가 매일 자동 갱신합니다.\n */\n';
  fs.writeFileSync(OUT, header + 'window.SLACK_DATA = ' + JSON.stringify(data, null, 2) + ';\n', 'utf8');
  console.log('✅ slack-data.js 갱신 (version=' + data.version + ', 누적: ' + Object.keys(data.days).join(', ') + ')');
})().catch(e => { console.error(e.message); process.exit(1); });
