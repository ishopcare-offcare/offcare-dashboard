/*
 * 무인 자동 실행용: #oc팀_메뉴요청 채널의 최근 요청 글을 읽어 대시보드 '메뉴등록' 카테고리 데이터로 적재.
 * GitHub Actions 에서 주기 실행. 환경변수: SLACK_BOT_TOKEN (필수), MENU_REQ_DAYS(기본 7)
 * 실행: node scripts/fetch-menu-requests.js  →  menu-requests.js (window.MENU_REQUESTS) 갱신
 *
 * 룰 기반 파싱만 사용(LLM 불필요): 상호/사업자번호/연락처/POS/요청내용/이미지링크/처리상태(이모지).
 * 메뉴 항목의 세부 해석(가격표 초안)은 대시보드(브라우저)와 /메뉴판독 스킬에서 수행.
 */
const fs = require('fs');
const path = require('path');

// 판독(API 호출) 오류로 메뉴 적재 자체가 멈추면 안 된다 — 판독 계열 오류만 조용히 흡수.
const isOcrErr = (e) => /anthropic|api|fetch|ECONN|ETIMEDOUT|ERR_|rate.?limit|overloaded/i.test(String((e && (e.message || e.name)) || e || ''));
process.on('unhandledRejection', (e) => { if (isOcrErr(e)) { console.log('판독 경고(무시):', String(e && e.message || e).slice(0, 120)); } else { throw e; } });
process.on('uncaughtException', (e) => { if (isOcrErr(e)) { console.log('판독 경고(무시):', String(e && e.message || e).slice(0, 120)); } else { console.error(e); process.exit(1); } });

const TOKEN = process.env.SLACK_BOT_TOKEN;
const OUT = 'menu-requests.js';
if (!TOKEN) { console.error('SLACK_BOT_TOKEN 환경변수가 필요합니다.'); process.exit(1); }

const CHANNEL = 'C08740SFT1S';                      // #oc팀_메뉴요청
const WORKSPACE = 'w1659946222-hxm266180.slack.com'; // 퍼머링크용
const DAYS = parseInt(process.env.MENU_REQ_DAYS || '30', 10);   // 매장조회(이력) 위해 30일 적재

const pad = (n) => String(n).padStart(2, '0');
const personMap = { '규빈': '김규빈', '선유': '배선유', '성현': '심성현', '동욱': '김동욱', '현기': '김현기', '태양': '송태양', '기범': '김기범', '상원': '서상원', '민석': '최민석', '경림': '고경림', '하림': '박하림' };
const NAMES = Object.keys(personMap).join('|');
const kstHM = (ts) => { const d = new Date(parseFloat(ts) * 1000 + 9 * 3600 * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const kstDate = (ts) => { const d = new Date(parseFloat(ts) * 1000 + 9 * 3600 * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

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

// 스레드 댓글 읽기 (요청사항이 댓글에 달리는 경우 대응). rate-limit 보호: 실행당 상한 + 변경 스레드만 호출.
const REPLY_FETCH_CAP = 80;
let replyFetched = 0;
async function fetchReplies(channelId, ts) {
  if (replyFetched >= REPLY_FETCH_CAP) return null;   // null = 상한 도달(캐시 유지)
  replyFetched++;
  const url = new URL('https://slack.com/api/conversations.replies');
  url.searchParams.set('channel', channelId);
  url.searchParams.set('ts', ts);
  url.searchParams.set('limit', '30');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const j = await res.json();
  if (!j.ok) return [];
  return (j.messages || []).slice(1);   // [0]은 원글
}
const cleanReply = (t) => scrubPII(String(t || '')
  .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '').replace(/<(https?:[^>|]+)(\|[^>]*)?>/g, '$1')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim().slice(0, 600));

// 슬랙 첨부파일 다운로드 — 대시보드에서 직접 받게 저장소(menu-files/)에 실어둠. 최근 FILE_DAYS만 유지(롤링).
const FILE_DIR = 'menu-files';
const FILE_DAYS = 7;                          // 파일 보관 기간(용량 관리) — 지나면 자동 삭제, 슬랙 원문 링크로 폴백
const FILE_MAX = 10 * 1024 * 1024;            // 10MB 초과 파일 제외
const FILE_PER_MSG = 6;                       // 저장소에 남길 첨부 수(대시보드 썸네일용) — 용량 때문에 제한
// 판독은 저장과 분리한다. 메뉴판을 여러 장 나눠 올리는 요청(POS 화면 10장 이상)이 흔한데
// 저장 상한에 묶여 6장에서 잘리고 있었다. 판독 결과는 텍스트라 용량 부담이 없다.
const JUDGE_PER_MSG = Number(process.env.JUDGE_PER_MSG || 30);
const RFX_VER = 3;                            // 댓글 첨부 수집 규칙 버전 (올리면 기존 요청 재스캔)
let truncated = 0;                            // 상한에 걸려 못 본 첨부 수(조용히 사라지지 않게 로그로)
let fileDownloaded = 0;
const FILE_DL_CAP = 40;                       // 실행당 다운로드 상한(rate 보호) — 나머지는 다음 실행에서
async function downloadSlackFile(url, dest) {
  if (fileDownloaded >= FILE_DL_CAP) return false;
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > FILE_MAX) return false;
    // 토큰 없이 접근 시 슬랙이 로그인 HTML을 주는 경우 방지
    if (buf.slice(0, 15).toString().toLowerCase().includes('<!doctype')) return false;
    fs.writeFileSync(dest, buf);
    fileDownloaded++;
    return true;
  } catch (e) { return false; }
}
function cleanupOldFiles(nowSec) {
  if (!fs.existsSync(FILE_DIR)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(FILE_DIR)) {
    const ts = parseFloat(String(f).split('-')[0].replace('_', '.'));
    if (ts && nowSec - ts > FILE_DAYS * 86400) { try { fs.unlinkSync(`${FILE_DIR}/${f}`); removed++; } catch (e) {} }
  }
  return removed;
}

// ─── 메뉴 이미지 판독 (Claude 비전) ────────────────────────────────────────
// 무료 Tesseract 는 실측 정확도 47.6% 로 손글씨·POS 캡처에서 쓸 수 없는 수준이었다
// (ocr-eval/README.md 비교표). Opus 5 는 95.2%.
// 실측 비용(2.3MB 메뉴판 사진 기준): 입력 6,035tok + 출력 802tok = 장당 약 ₩69.
// README 의 ₩16 추산은 작은 POS 캡처 기준이라 실제 사진은 그보다 비싸다.
// OCR_MODEL 환경변수로 claude-sonnet-5(장당 약 ₩27, 추출 일치율 28/31)로 낮출 수 있다.
// 한 번의 호출로 '이미지 종류 판별 + 메뉴 추출' 을 같이 시킨다 — 상품사진(전체의 약 70%)은
// 빈 배열로 돌아오고 kind 가 캐시되므로 다시 호출하지 않는다.
// 결과는 att[].menu / datt[].menu 에 구조화된 배열로 캐시. 신규 이미지에만 1회 호출.
const OCR_EXT = /\.(jpe?g|png|webp|bmp|gif)$/i;
const OCR_CAP = Number(process.env.OCR_CAP || 12);   // 실행당 신규 판독 상한(비용·런타임 보호)
// API 가 받는 이미지 상한은 base64 기준 5MB. 여유를 두고 4.5MB 를 넘으면 축소본을 쓴다.
const OCR_MAX_BYTES = 4.5 * 1024 * 1024;
// 용량과 별개로 픽셀 상한도 있다 — 한 변이 8000px 를 넘으면 400. 안드로이드 스크롤 스크린샷은
// 용량은 1MB 도 안 되면서 세로가 1만을 넘어 여기 걸린다(2026-09-09 판독 정지의 원인).
const OCR_MAX_PX = 8000;
let thumbUsed = 0, pxShrunk = 0;
const OCR_MODEL = process.env.OCR_MODEL || 'claude-opus-5';
const OCR_PRICE = { in: 5, out: 25 };                // $/1M tok — 로그의 비용 추정용
const KRW_PER_USD = Number(process.env.KRW_PER_USD || 1380);
let ocrDone = 0, ocrUsd = 0;
const OCR_MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
// PDF 는 이미지가 아니라 document 블록으로 보낸다(모델이 페이지를 직접 읽는다).
// HEIF(아이폰 원본)는 API 가 받지 않아 제외 — 요청자가 jpg 로 다시 올려야 한다.
const OCR_PDF = '.pdf';
// 자유 텍스트 필드를 두지 않는다 — 이미지에 연락처가 찍혀 있어도 결과로 새어나올 구멍이 없다.
// (이 저장소는 public 이라 판독 결과가 그대로 공개된다)
const OCR_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['menu_board', 'pos_screen', 'product_photo', 'other'],
            description: '이미지 종류. 메뉴판 사진=menu_board, POS 관리자 화면 캡처=pos_screen, 배달앱용 음식/상품 사진=product_photo, 그 외=other' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '메뉴가 속한 분류. 이미지에 분류 표기가 없으면 빈 문자열.' },
          name: { type: 'string', description: '메뉴명. 이미지 표기 그대로. 맞춤법 교정 금지.' },
          price: { type: 'integer', description: '가격. 콤마 없는 정수. 가격이 안 보이면 0.' },
        },
        required: ['category', 'name', 'price'],
        additionalProperties: false,
      },
    },
  },
  required: ['kind', 'items'],
  additionalProperties: false,
};
const OCR_PROMPT = `이 이미지에서 등록 대상 메뉴(상품명과 가격)를 추출하세요.

먼저 이미지 종류를 판별하세요:
- menu_board : 매장 메뉴판(인쇄물·손글씨·POS 출력물 등) 사진
- pos_screen : POS 프로그램 관리자 화면 캡처
- product_photo : 배달앱 등록용 음식/상품 사진 (메뉴명·가격 목록이 아님)
- other : 그 외

추출 규칙:
- product_photo 와 other 는 items 를 빈 배열로 두세요.
- 메뉴명은 보이는 표기 그대로 적습니다. 맞춤법을 고치지 마세요.
- 가격은 콤마를 빼고 정수로 적습니다. 가격이 안 보이면 0 으로 둡니다.
- 분류(주류/식사류 등) 표기가 있으면 category 에 넣고, 없으면 빈 문자열로 둡니다.
- 글자가 흐릿해 확신이 없으면 그 항목은 넣지 마세요. 추측해서 채우지 마세요.
- 매장 전화번호·주소·사업자번호 같은 연락처 정보는 절대 넣지 마세요.`;

let _anthropic = null;   // null=미초기화, 'FAIL'=사용불가, 그 외=client
function getAnthropic() {
  if (_anthropic === 'FAIL') return null;
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) { console.log('판독 비활성: ANTHROPIC_API_KEY 없음'); _anthropic = 'FAIL'; return null; }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic();
    return _anthropic;
  } catch (e) { console.log('판독 비활성:', e.message); _anthropic = 'FAIL'; return null; }
}
// 판독 텍스트는 공개 저장소에 커밋된다 → 메뉴·가격이 아닌 개인 식별 번호는 지우고 저장한다.
// 가격(3~6자리, 콤마 포함)은 건드리지 않는 패턴만 사용.
function scrubPII(t) {
  return String(t || '')
    // 마스킹 토큰은 한글을 쓰지 않는다 — 브라우저의 ocrExtractMenu 가 한글 2자 이상을
    // 메뉴명으로 잡아 '번호 | ' 같은 가짜 행을 만들기 때문. '···' 는 이름·가격 어디에도 안 걸린다.
    .replace(/\b0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}\b/g, '···')   // 전화·휴대폰
    .replace(/\b\d{3}[-. ]\d{2}[-. ]\d{5}\b/g, '···')          // 사업자번호 000-00-00000
    .replace(/\b\d{10,11}\b/g, '···')                          // 하이픈 없는 10~11자리
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '···');
}
// 반환: {kind, menu:[{category,name,price}]} → 캐시(재호출 안 함) · null → 상한/키없음/일시오류(다음 실행 재시도)
/* 판독을 더 해봐야 소용없는 상태(크레딧 소진·키 오류 등)면 이번 실행은 즉시 중단한다.
 * 2026-08-11 에 크레딧이 떨어졌는데, 400 이 그냥 '판독 실패'로 처리되는 바람에 10분마다
 * 12번씩 같은 400 을 맞으면서 하루 넘게 0건 판독이 이어졌다. 원인도 데이터에 안 남았다. */
let ocrHalt = null;                    // {status, message} — 설정되면 이번 실행의 남은 판독을 건너뛴다
const OCR_FATAL = new Set([400, 401, 403, 404]);   // 잔액·키·모델명 문제 — 재시도해도 같은 결과
/* 단, 400 에는 성격이 다른 두 가지가 섞여 있다.
 *   ① 계정 문제(크레딧 소진 등) — 다음 장도 똑같이 실패한다 → 이번 실행 중단이 맞다
 *   ② 이 사진 한 장의 문제(픽셀 8000 초과·디코드 실패 등) — 다른 사진은 멀쩡하다
 * ②까지 중단으로 처리하면 그 한 장이 큐 맨 앞에 박혀 파이프라인이 영구히 멈춘다.
 * 2026-09-09 에 1080x10879 안드로이드 스크롤 스크린샷 한 장 때문에 13:28부터 판독이 0건이 됐다.
 * API 는 요청 본문의 어느 필드가 문제인지 'messages.0.content.0.image.source…' 로 짚어준다
 * — 이 접두사가 붙은 400 은 ②로 보고 그 첨부만 판독 불가로 표시하고 다음 장으로 넘어간다. */
const OCR_BAD_INPUT = /messages\.\d+\.content|invalid[_ ]image|could not process (image|document)/i;
// sharp 는 optionalDependencies — 설치가 안 돼도 판독은 그대로 돌아간다(초과분만 건너뜀).
let _sharp = null;   // null=미확인, 'FAIL'=사용불가
function getSharp() {
  if (_sharp === 'FAIL') return null;
  if (_sharp) return _sharp;
  try { _sharp = require('sharp'); return _sharp; }
  catch (e) { console.log('축소 비활성: sharp 없음 — 8000px 초과 사진은 판독을 건너뜁니다'); _sharp = 'FAIL'; return null; }
}
/* 한 변이 상한을 넘으면 상한 안으로 줄인 임시 JPEG 를 만든다.
 *   null            = 줄일 필요 없음(그대로 보내면 된다)
 *   {ok:true,path}  = 줄인 파일
 *   {ok:false}      = 줄여야 하는데 못 줄임 → 보내봐야 400 이라 판독 불가로 굳힌다 */
async function shrinkToLimit(src) {
  const sharp = getSharp();
  if (!sharp) return null;   // 크기를 볼 수단이 없다 — 일단 보내고 400 이면 판독 불가로 처리된다
  let md;
  try { md = await sharp(src).metadata(); } catch (e) { return null; }
  if (Math.max(md.width || 0, md.height || 0) <= OCR_MAX_PX) return null;
  try {
    const out = `${DRIVE_TMP}/px-${path.basename(src)}.jpg`;
    await sharp(src)
      .resize({ width: OCR_MAX_PX, height: OCR_MAX_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(out);
    pxShrunk++;
    console.log(`↧ ${md.width}x${md.height} → 상한 ${OCR_MAX_PX}px 안으로 축소해 판독: ${src}`);
    return { ok: true, path: out };
  } catch (e) { console.log('축소 실패:', src, String(e.message || e).slice(0, 100)); return { ok: false }; }
}
async function readMenuImage(dest) {
  if (ocrHalt) return null;
  if (ocrDone >= OCR_CAP) return null;
  const client = getAnthropic();
  if (!client) return null;
  const ext = path.extname(dest).toLowerCase();
  let media = OCR_MEDIA[ext];
  const isPdf = ext === OCR_PDF;
  if (!media && !isPdf) return null;
  let src = dest, shrunk = null;
  if (!isPdf) {
    const sh = await shrinkToLimit(dest);
    if (sh && !sh.ok) { console.log(`판독 건너뜀(한 변 ${OCR_MAX_PX}px 초과 · 축소 불가):`, dest); return { bad: true }; }
    if (sh) { src = sh.path; shrunk = sh.path; media = 'image/jpeg'; }
  }
  let buf = null;
  try { buf = fs.readFileSync(src); } catch (e) {}
  if (shrunk) { try { fs.unlinkSync(shrunk); } catch (e) {} }   // 데이터는 buf 에 있다 — 바로 정리
  if (!buf || !buf.length) return null;
  if (buf.length > OCR_MAX_BYTES) {   // 상한 초과 — 보내봐야 400 이다. 호출하지 않고 건너뛴다
    console.log(`판독 건너뜀(용량 ${(buf.length / 1048576).toFixed(1)}MB > ${(OCR_MAX_BYTES / 1048576).toFixed(1)}MB):`, dest);
    return null;
  }
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
  try {
    const res = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 4096,
      // thinking 은 붙이지 않는다. 같은 이미지로 실측했을 때 출력 토큰(802)·추출 결과(31/31)가
      // 완전히 동일한데 지연만 13.4s → 100.6s 로 늘었다. 10분 주기 크론이라 실행이 겹칠 위험이 크다.
      // (effort:'low' 는 유지 — 인식 작업에 필요 이상의 추론을 막는다)
      output_config: { format: { type: 'json_schema', schema: OCR_SCHEMA }, effort: 'low' },
      messages: [{ role: 'user', content: [block, { type: 'text', text: OCR_PROMPT }] }],
    });
    ocrDone++;
    const u = res.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    ocrUsd += inTok / 1e6 * OCR_PRICE.in + (u.output_tokens || 0) / 1e6 * OCR_PRICE.out;
    if (res.stop_reason === 'refusal') { console.log('판독 거부:', dest); return { kind: 'other', menu: [] }; }
    const text = (res.content.find((b) => b.type === 'text') || {}).text || '{}';
    let parsed; try { parsed = JSON.parse(text); } catch (e) { console.log('판독 JSON 파싱 실패:', dest); return null; }
    const menu = (parsed.items || [])
      .map((x) => ({ category: scrubPII(String(x.category || '')).slice(0, 30),
                     name: scrubPII(String(x.name || '')).slice(0, 60),
                     price: Number(x.price) || 0 }))
      .filter((x) => x.name)
      .slice(0, 200);
    return { kind: parsed.kind || 'other', menu };
  } catch (e) {
    const st = e.status || 0;
    const msg = String((e.error && e.error.error && e.error.error.message) || e.message || e).slice(0, 200);
    if (st === 400 && OCR_BAD_INPUT.test(msg)) {   // 이 첨부 하나의 문제 — 다시 보내도 같은 400 이다
      ocrDone++;
      console.log('판독 불가(이 첨부만 건너뜀):', dest, msg.slice(0, 120));
      return { bad: true };
    }
    if (OCR_FATAL.has(st)) {          // 잔액 부족·키 오류 등 — 이번 실행은 여기서 판독을 접는다
      ocrHalt = { status: st, message: msg };
      console.log(`⛔ 판독 중단(HTTP ${st}): ${msg}`);
      return null;
    }
    ocrDone++;   // 일시적 실패만 상한에 넣는다 — 한 실행이 오류로 무한 재시도하지 않도록
    console.log('판독 실패:', dest, msg.slice(0, 100));
    return null;
  }
}

// 메일로 온 엑셀·CSV 메뉴 파일 판독. POS사(비버 등)가 내려주는 메뉴 파일은 양식이 제각각이라
// 열 이름을 규칙으로 맞추는 대신 이미지와 같은 스키마로 모델에게 뽑게 한다.
// 엑셀 → CSV 변환은 메일함 쪽 Apps Script(mail-attach.gs)가 해 둔다.
const TEXT_MAX_CHARS = 60000;                       // 약 3만 토큰 — 이보다 긴 파일은 앞부분만
const TEXT_PROMPT = `아래는 매장 메뉴 파일(엑셀/CSV)을 텍스트로 옮긴 것입니다. 등록 대상 메뉴(상품명과 가격)를 추출하세요.

추출 규칙:
- 메뉴명은 파일 표기 그대로 적습니다. 맞춤법을 고치지 마세요.
- 가격은 콤마를 빼고 정수로 적습니다. 가격 열이 없거나 비어 있으면 0 으로 둡니다.
- 분류(카테고리) 열이나 구분 행이 있으면 category 에 넣고, 없으면 빈 문자열로 둡니다.
- 옵션·추가 선택 항목만 모아 둔 시트는 제외하고 판매 메뉴만 넣으세요.
- 제목 행·합계 행·빈 행은 넣지 마세요.
- 전화번호·주소·사업자번호 같은 정보는 절대 넣지 마세요.
- kind 는 menu_board 로 두세요.`;
async function readMenuText(dest) {
  if (ocrHalt) return null;
  if (ocrDone >= OCR_CAP) return null;
  const client = getAnthropic();
  if (!client) return null;
  let text = '';
  try { text = fs.readFileSync(dest, 'utf8').replace(/^﻿/, ''); } catch (e) { return null; }
  if (!text.trim()) return { bad: true };
  if (text.length > TEXT_MAX_CHARS) { console.log(`메뉴 파일이 길어 앞 ${TEXT_MAX_CHARS}자만 판독: ${dest}`); text = text.slice(0, TEXT_MAX_CHARS); }
  try {
    const res = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 16000,
      output_config: { format: { type: 'json_schema', schema: OCR_SCHEMA }, effort: 'low' },
      messages: [{ role: 'user', content: [{ type: 'text', text: '<menu_file>\n' + text + '\n</menu_file>' }, { type: 'text', text: TEXT_PROMPT }] }],
    });
    ocrDone++;
    const u = res.usage || {};
    ocrUsd += (u.input_tokens || 0) / 1e6 * OCR_PRICE.in + (u.output_tokens || 0) / 1e6 * OCR_PRICE.out;
    if (res.stop_reason === 'refusal') return { kind: 'menu_file', menu: [] };
    let parsed; try { parsed = JSON.parse((res.content.find((b) => b.type === 'text') || {}).text || '{}'); } catch (e) { console.log('메뉴 파일 JSON 파싱 실패:', dest); return null; }
    const menu = (parsed.items || [])
      .map((x) => ({ category: scrubPII(String(x.category || '')).slice(0, 30),
                     name: scrubPII(String(x.name || '')).slice(0, 60),
                     price: Number(x.price) || 0 }))
      .filter((x) => x.name)
      .slice(0, 500);
    return { kind: 'menu_file', menu };
  } catch (e) {
    const st = e.status || 0;
    const msg = String((e.error && e.error.error && e.error.error.message) || e.message || e).slice(0, 200);
    if (OCR_FATAL.has(st)) { ocrHalt = { status: st, message: msg }; console.log(`⛔ 판독 중단(HTTP ${st}): ${msg}`); return null; }
    ocrDone++;
    console.log('메뉴 파일 판독 실패:', dest, msg.slice(0, 100));
    return null;
  }
}

// ─── Google Drive 링크 이미지 수집 ─────────────────────────────────────────
// 메뉴 이미지는 슬랙 직접 첨부보다 Drive 링크로 들어오는 쪽이 많다. 접근 가능한 파일만
// 내려받아 슬랙 첨부와 똑같이 OCR 대상에 넣는다.
// GDRIVE_* 시크릿이 없거나 권한이 없으면 조용히 건너뛴다 — 적재 자체는 절대 멈추지 않는다.
// 차단(403 cannotDownloadFile)은 blocked 로 표시만 하고 매 실행 재시도한다(권한이 풀리면 자동 복구).
// ⚠️ 이 저장소는 공개(public)다. Drive 이미지는 고객 소유 파일이고 파일명에 개인 이름이
// 섞여 들어오므로(예: "IMG_5886 - OOO.png") 저장소에 커밋하지 않는다.
// → OS 임시 디렉터리에 받아 OCR 만 하고 즉시 삭제하고, 남기는 건 판독 텍스트뿐이다.
//   파일명도 저장하지 않는다(대시보드는 기존 drive[] 링크로 원본을 연다).
const os = require('os');
const DRIVE_TMP = fs.mkdtempSync(require('path').join(os.tmpdir(), 'menu-drive-'));
const DRIVE_DL_CAP = 20;                      // 실행당 신규 다운로드 상한
// 판독 상한은 슬랙 첨부와 동일 기준(JUDGE_PER_MSG) — Drive 링크도 여러 장 나눠 올린다
// 판독 가능한 형식. PDF 는 document 블록으로 모델이 직접 읽는다.
// HEIF(아이폰 원본)·hwp·xlsx 는 API 가 못 받으므로 제외하고, 몇 건 걸렀는지만 로그에 남긴다.
const DRIVE_READABLE = /^(image\/(jpe?g|png|webp|bmp|gif)|application\/pdf)$/i;
let driveDownloaded = 0, driveBlocked = 0, driveSkipped = 0;
let _dtok = null;                             // null=미시도, 'FAIL'=사용불가, 문자열=access token
async function driveToken() {
  if (_dtok === 'FAIL') return null;
  if (_dtok) return _dtok;
  const { GDRIVE_CLIENT_ID: id, GDRIVE_CLIENT_SECRET: sec, GDRIVE_REFRESH_TOKEN: rt } = process.env;
  if (!id || !sec || !rt) { console.log('Drive 비활성: GDRIVE_* 환경변수 없음'); _dtok = 'FAIL'; return null; }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: sec, refresh_token: rt, grant_type: 'refresh_token' }),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(j.error_description || j.error || 'no access_token');
    _dtok = j.access_token;
    return _dtok;
  } catch (e) { console.log('Drive 비활성:', e.message); _dtok = 'FAIL'; return null; }
}
const driveIdsOf = (links) => [...new Set(links
  .map((u) => (String(u).match(/\/file\/d\/([\w-]+)/) || String(u).match(/[?&]id=([\w-]+)/) || [])[1])
  .filter(Boolean))];
// 반환: {name, mimeType, size} · null=조회 실패
async function driveMeta(id, tok) {
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size&supportsAllDrives=true`,
      { headers: { Authorization: 'Bearer ' + tok } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
// 반환: true=저장됨 · 'blocked'=권한 차단 · false=그 외 실패
async function driveDownload(id, dest, tok) {
  if (driveDownloaded >= DRIVE_DL_CAP) return false;
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: 'Bearer ' + tok } });
    if (r.status === 403) return 'blocked';
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > FILE_MAX) return false;
    fs.writeFileSync(dest, buf);
    driveDownloaded++;
    return true;
  } catch (e) { return false; }
}

// ─── 메일 접수 (📬 새 메일 도착 릴레이) ─────────────────────────────────────
// 메일 릴레이 봇 글에는 첨부가 없다(본문 앞부분·메일 링크뿐). 첨부는 rm@ 메일을 같이 받는
// 직원 계정의 Apps Script(mail-attach.gs)가 Drive 폴더로 복사하고 menu-mail-index.json 에
// '보낸 사람·제목·시각·파일' 목록을 적어 둔다. 여기서 그 목록을 읽어 릴레이 글과 짝짓는다.
// ⚠️ 목록에는 보낸 사람 주소·파일명이 있지만 공개 저장소에는 Drive 파일 id·확장자만 남긴다.
const MAIL_INDEX = 'menu-mail-index.json';
const MAIL_MATCH_SEC = 3 * 86400;             // 릴레이 글과 메일 도착 시각 허용 차이
let _mailIdx = null;                          // null=미시도, []=없음/실패
async function mailIndex() {
  if (_mailIdx) return _mailIdx;
  _mailIdx = [];
  const tok = await driveToken();
  if (!tok) return _mailIdx;
  try {
    const q = encodeURIComponent(`name='${MAIL_INDEX}' and trashed=false`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      { headers: { Authorization: 'Bearer ' + tok } });
    const id = r.ok ? (((await r.json()).files || [])[0] || {}).id : null;
    if (!id) { console.log(`메일 첨부 목록(${MAIL_INDEX}) 없음 — mail-attach.gs 설치 전이면 정상`); return _mailIdx; }
    const r2 = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + tok } });
    _mailIdx = r2.ok ? ((await r2.json()).items || []) : [];
    console.log(`📧 메일 첨부 목록 ${_mailIdx.length}통`);
  } catch (e) { console.log('메일 첨부 목록 읽기 실패:', e.message); }
  return _mailIdx;
}
const normSubj = (t) => String(t || '').toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/[\s*_]+/g, '');
function matchMail(idx, fromEmail, subject, ts) {
  const ns = normSubj(subject);
  if (!ns) return null;
  const gap = (e) => Math.abs(Date.parse(e.date) / 1000 - parseFloat(ts));
  const cands = idx.filter((e) => {
    if (fromEmail && e.fromEmail && e.fromEmail !== fromEmail) return false;
    const es = normSubj(e.subject);
    if (!(es === ns || (Math.min(es.length, ns.length) >= 4 && (es.includes(ns) || ns.includes(es))))) return false;
    return gap(e) <= MAIL_MATCH_SEC;
  });
  cands.sort((a, b) => gap(a) - gap(b));
  return cands[0] || null;
}
// 메일 제목에서 상호 추정 — "영거+메뉴등록 요청" → "영거"
function storeFromSubject(subj) {
  return String(subj || '')
    .replace(/\[[^\]]*\]/g, ' ').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/메뉴\s*(등록|수정|변경|추가)?|등록|요청(드립니다|합니다|드려요)?|의\s*건|사진|파일|이미지|전달/g, ' ')
    .replace(/[+_\-·|/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}
const extOf = (name) => ((String(name || '').match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || '').toLowerCase();

// 텍스트에서 POS 종류 추정
function detectPos(text) {
  const t = (text || '').toLowerCase();
  if (/토스|toss/.test(t)) return '토스포스';
  if (/퍼스트|first|kpn/.test(t)) return '퍼스트포스';
  if (/오케이|okpos/.test(t)) return '오케이포스';
  if (/스파로스|sparos|spharos/.test(t)) return '스파로스포스';
  if (/포스\s*[:：]\s*그\s*외|기타\s*포스/.test(t)) return '기타';
  return '';
}

(async () => {
  const nowSec = Date.now() / 1000;
  const oldest = nowSec - DAYS * 86400;
  const msgs = await fetchAllRange(CHANNEL, oldest, nowSec);
  console.log(`메뉴요청 채널 메시지 ${msgs.length}건 (최근 ${DAYS}일)`);
  fs.mkdirSync(FILE_DIR, { recursive: true });
  const removedFiles = cleanupOldFiles(nowSec);
  if (removedFiles) console.log(`오래된 첨부 ${removedFiles}개 정리 (보관 ${FILE_DAYS}일)`);

  // 이전 적재분 캐시 (댓글 재호출 방지: reply_count·latest_reply 동일하면 재사용)
  const prevMap = {};
  if (fs.existsSync(OUT)) { const w = {}; try { new Function('window', fs.readFileSync(OUT, 'utf8'))(w); for (const it of ((w.MENU_REQUESTS || {}).items || [])) prevMap[it.ts] = it; } catch (e) {} }

  const items = [];
  for (const m of msgs) {
    if (m.subtype && m.subtype !== 'bot_message') continue;   // 시스템 메시지 제외(봇 접수글은 포함)
    const text = [m.text || '', ...(m.attachments || []).map((a) => a.text || a.fallback || '')].join('\n')
      .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

    // 메일 릴레이 글 — 상호 라벨이 없어도 요청으로 받는다(첨부는 아래 matt 에서 메일함 목록과 짝지음)
    const isMail = /새\s*메일\s*도착/.test(text);
    const mailFromLine = isMail ? ((text.match(/보낸\s*사람\s*\*?[:：]\*?\s*(.+)/) || [])[1] || '') : '';
    const mailFrom = ((mailFromLine.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0]).toLowerCase();
    const mailSubj = isMail ? ((text.match(/제목\s*\*?[:：]\*?\s*(.+)/) || [])[1] || '').replace(/\*/g, '').trim() : '';
    const mailLink = isMail ? ((text.match(/https:\/\/mail\.google\.com\/[^\s>|)\]]+/) || [])[0] || '') : '';

    // "상호명 : 면과육 사업자번호 : 592-…" 처럼 한 줄에 라벨이 이어 붙은 글이 있다 —
    // 예전 정규식은 '상호' 뒤의 '명 : 면과육 사업자번호 : …' 을 통째로 상호로 잡아 사업자번호가 공개됐다.
    let store = (((text.match(/(?:상호명?|매장명)\s*[:：]?\s*(.+)/) || [])[1]) || '')
      .split(/\s*(?:사업자|대표자?|연락처|전화|휴대폰|포스\s*[:：]|\/)/)[0].trim();
    if (!store && isMail) store = storeFromSubject(mailSubj);
    store = scrubPII(store).slice(0, 40);
    const biz = ((text.match(/사업자\s*번?호?\s*[:：]?\s*([\d\-]+)/) || [])[1] || '').replace(/-/g, '').trim();
    if (!store && !biz && !isMail) continue;                  // 상호·사업자 없는 글(사진 릴레이 등)은 요청으로 안 봄

    // ⚠️ 연락처는 적재하지 않는다 — 이 저장소는 public 이라 menu-requests.js 가
    // raw.githubusercontent.com 으로 그대로 공개된다. 번호가 필요하면 '💬 슬랙 원문'에서 본다.
    // 요청 본문: '메뉴 수정' 또는 '내용' 필드부터 끝까지(다음 라벨 전까지 자르지 않고 원문 유지 — 브라우저에서 초안 파싱)
    // 본문에도 연락처가 섞여 들어오므로 scrubPII 를 통과시킨 뒤 적재한다(가격은 안 건드림)
    const content = scrubPII(((text.match(/(?:메뉴\s*수정|내용)\s*[:：]?\s*([\s\S]+?)(?:\n-\s*(?:특이사항|포스|대표자|이미지)\s*[:：]|$)/) || [])[1] || '').trim().slice(0, 1200));
    const mailHead = isMail ? scrubPII(`[📧 메일] 제목: ${mailSubj}\n`) : '';
    const special = scrubPII(((text.match(/특이사항\s*[:：]?\s*(.+)/) || [])[1] || '').trim().slice(0, 200));
    const posText = ((text.match(/포스\s*[:：]?\s*(.+)/) || [])[1] || '');
    const pos = detectPos(posText) || detectPos(text);
    const driveLinks = [...text.matchAll(/https?:\/\/drive\.google\.com\/[^\s>|,]+/g)].map((x) => x[0]);
    const fileCnt = (m.files || []).length;

    // 처리 상태 (이모지): 완료(원격OOO) > 중복 > 확인중(OOO확인) > 대기
    const names = (m.reactions || []).map((r) => r.name);
    let handler = null, confirmer = null;
    for (const n of names) { const pm = n.match(new RegExp('^원격(' + NAMES + ')$')); if (pm) { handler = personMap[pm[1]]; break; } }
    for (const n of names) { const cm = n.match(new RegExp('^(' + NAMES + ')_?확인.*$')); if (cm) { confirmer = personMap[cm[1]]; break; } }
    const isDup = names.some((n) => /^중복/.test(n));
    const status = handler ? 'done' : isDup ? 'dup' : confirmer ? 'confirm' : 'wait';

    // (첨부 처리는 아래 '스레드 댓글' 이후 — 댓글에 달린 이미지까지 같이 모아야 한다)

    // Drive 링크 이미지 — 접근 가능한 것을 임시로 받아 판독하고 즉시 지운다(저장소에 안 남김).
    // 슬랙 첨부(att)와 달리 FILE_DAYS 창을 두지 않는다: 파일을 보관하지 않으므로 용량 이유가 없고,
    // 창을 두면 7일 지나 들어온 요청(적재 30일 중 대부분)이 영영 판독되지 않는다.
    // 판독 완료분은 캐시로 재사용되므로 매 실행 다시 호출하지도 않는다.
    let datt = ((prevMap[m.ts] || {}).datt) || [];
    if (driveLinks.length) {
      const tok = await driveToken();
      if (tok) {
        const prevD = datt;
        datt = [];   // 토큰이 있을 때만 새로 계산 — 자격증명이 없다고 기존 결과를 날리면 안 된다
        let di = 0;
        const allIds = driveIdsOf(driveLinks);
        if (allIds.length > JUDGE_PER_MSG) truncated += allIds.length - JUDGE_PER_MSG;
        for (const id of allIds.slice(0, JUDGE_PER_MSG)) {
          const p = prevD.find((x) => x.id === id) || {};
          // 판독 완료분은 영구 재사용. 구 tesseract 캐시(ocr 문자열)도 그대로 살려 재판독 비용을 아낀다.
          if ('kind' in p) { datt.push({ id, kind: p.kind, menu: p.menu || [] }); continue; }
          if ('ocr' in p) { datt.push({ id, ocr: p.ocr }); continue; }
          if (p.nj) { datt.push({ id, nj: 1 }); continue; }               // 판독 불가로 확정된 파일
          di++;

          const meta = await driveMeta(id, tok);
          if (!meta) continue;
          if (!DRIVE_READABLE.test(String(meta.mimeType || ''))) { driveSkipped++; continue; }   // heif·hwp·xlsx 등
          if (Number(meta.size || 0) > FILE_MAX) continue;

          // 임시 파일로만 받는다 — 저장소에는 이미지도 파일명도 남기지 않는다
          const ext = (String(meta.mimeType).split('/')[1] || 'jpg').replace('jpeg', 'jpg');
          const tmp = `${DRIVE_TMP}/${id}.${ext}`;
          const got = await driveDownload(id, tmp, tok);
          if (got === 'blocked') { datt.push({ id, blocked: true }); driveBlocked++; continue; }
          if (!got) continue;
          try {
            const r = await readMenuImage(tmp);
            if (r && r.bad) datt.push({ id, nj: 1 });                      // 판독 불가 — 매 실행 다시 받아 호출하지 않는다
            else if (r) datt.push({ id, kind: r.kind, menu: r.menu });     // null(상한/키없음)은 다음 실행 재시도
          } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
        }
      }
    }

    // 스레드 댓글 — 요청사항이 댓글에 달리는 케이스. 원글 작성자 댓글 위주(봇 접수글은 사람 댓글 전부).
    const rc = m.reply_count || 0, lr = m.latest_reply || '';
    let replies = [], rawReplies = null, repliesCached = false;
    if (rc > 0) {
      const prev = prevMap[m.ts];
      // rfx = '이 스레드의 댓글 첨부를 어느 규칙으로 훑었는지' 버전. 낮으면 댓글이 그대로여도 다시 읽는다.
      // 수집 규칙이 바뀔 때 RFX_VER 을 올리면 기존 요청들이 한 번씩 다시 스캔된다.
      //   1 = 댓글 첨부 수집 도입   2 = 요청당 상한을 6 → JUDGE_PER_MSG 로 올림(7장째부터 누락되던 것 복구)
      //   3 = 판독 못 끝낸 댓글 이미지가 남아 있으면 스레드를 다시 읽는다(아래 pendingReply)
      // 댓글이 그대로여도 아직 판독 안 된 이미지가 남아 있으면 다시 읽어야 한다.
      // 첨부 바이트는 슬랙 API 의 url_private_download 로만 받을 수 있는데, 캐시 분기로 빠지면
      // rawReplies 가 null 이라 그 URL 이 없어 영영 판독되지 않는다(43장이 이 상태로 묶여 있었다).
      const pendingReply = ((prevMap[m.ts] || {}).att || [])
        .some((x) => x.from === '댓글' && !('kind' in x) && !x.nj);
      if (!pendingReply && prev && prev.rc === rc && prev.lr === lr && (prev.rfx || 0) >= RFX_VER) { replies = prev.replies || []; repliesCached = true; }   // 변경 없음 → 캐시
      else {
        rawReplies = await fetchReplies(CHANNEL, m.ts);
        if (rawReplies === null) { replies = (prev && prev.replies) || []; repliesCached = true; }            // 상한 도달 → 기존 유지
        else replies = rawReplies
          .filter((r) => !r.bot_id && r.subtype !== 'bot_message' && (r.text || '').trim())
          .filter((r) => (m.user ? r.user === m.user : true))                       // 원글 작성자 댓글만(봇 원글은 전부)
          .map((r) => cleanReply(r.text)).filter(Boolean).slice(0, 8);
      }
    }

    // 첨부 이미지 — 원글 + 스레드 댓글. 직원이 원글이 아니라 댓글로 사진을 올리는 경우가 많다
    // (또래오래·파파빈 등). 텍스트 없는 사진만 있는 댓글도 잡아야 하므로 위 텍스트 필터와 별개로 모은다.
    // 저장은 FILE_DAYS 창 안에서만(대시보드 썸네일용). 창 밖이라도 판독은 한다 — 임시로 받아 판독 후 삭제.
    const prevAtt = ((prevMap[m.ts] || {}).att) || [];
    const inWindow = nowSec - parseFloat(m.ts) <= FILE_DAYS * 86400;
    const att = [];
    if (repliesCached) prevAtt.filter((x) => x.from === '댓글').forEach((x) => att.push(x));   // 댓글을 다시 안 읽었으면 승계
    const allSlackFiles = [
      ...(m.files || []).map((f) => ({ f, from: '원글' })),
      ...(rawReplies || []).flatMap((r) => (r.files || []).map((f) => ({ f, from: '댓글' }))),
    ];
    if (allSlackFiles.length > JUDGE_PER_MSG) truncated += allSlackFiles.length - JUDGE_PER_MSG;
    const slackFiles = allSlackFiles.slice(0, JUDGE_PER_MSG);
    let fi = 0;
    for (const { f, from } of slackFiles) {
      const ext = (String(f.name || '').match(/\.[A-Za-z0-9]{1,6}$/) || ['.' + (f.filetype || 'bin')])[0].toLowerCase();
      const idx = fi++;
      const dest = `${FILE_DIR}/${String(m.ts).replace('.', '_')}-${idx}${ext}`;
      const prevA = prevAtt.find((x) => x.fid && x.fid === f.id) || {};
      const a = { name: String(f.name || '첨부').slice(0, 40), fid: f.id, from };
      if ('kind' in prevA) { a.kind = prevA.kind; a.menu = prevA.menu || []; }   // 판독 완료분 재사용(빈 결과도 재사용)
      const small = (f.size || 0) <= FILE_MAX && !!f.url_private_download;
      let stored = false;
      if (inWindow && small && idx < FILE_PER_MSG) {   // 저장은 앞 몇 장만 — 판독은 아래에서 전량
        stored = fs.existsSync(dest) || await downloadSlackFile(f.url_private_download, dest);
        if (stored) a.path = dest;
      }
      // 판독 대상이 아닌 첨부(hwp·xlsx 같은 비이미지, 다운로드 URL 없음)는 nj 로 표시한다.
      // 표시해 두지 않으면 위 pendingReply 가 매 실행 참이 되어 스레드를 계속 다시 읽는다.
      // 원본이 API 상한(5MB)을 넘으면 슬랙이 만들어 둔 축소본을 쓴다 — 폰으로 찍은 4000x3000
      // 사진이 흔하고(반달커피 10.0MB), 원본 그대로 보내면 매번 400 으로 떨어진다.
      const bigOriginal = (f.size || 0) > OCR_MAX_BYTES;
      const thumb = bigOriginal ? (f.thumb_1024 || f.thumb_960 || f.thumb_800 || f.thumb_720 || null) : null;
      const judgeable = OCR_EXT.test(ext) && !!f.url_private_download && (!bigOriginal || !!thumb);
      if (!('kind' in a) && !judgeable) a.nj = 1;
      if (!('kind' in a) && judgeable) {
        let judgePath = (stored && !bigOriginal) ? dest : null;
        if (!judgePath) {   // 창 밖이라 저장을 안 했거나, 원본이 커서 축소본을 받아야 하는 경우
          const src = thumb || f.url_private_download;
          const tExt = thumb ? ((String(thumb).match(/\.(jpe?g|png)(\?|$)/i) || [])[0] || '.png').replace(/\?.*$/, '') : ext;
          judgePath = `${DRIVE_TMP}/s-${f.id}${tExt}`;
          if (!await downloadSlackFile(src, judgePath)) judgePath = null;
          else if (thumb) thumbUsed++;
        }
        if (judgePath) {
          const isTemp = judgePath.startsWith(DRIVE_TMP);   // 축소본·창밖 임시본은 판독 후 지운다
          try {
            const r = await readMenuImage(judgePath);
            if (r && r.bad) a.nj = 1;                                   // 판독 불가 사진 — 다음 실행에서 재시도하지 않는다
            else if (r) { a.kind = r.kind; a.menu = r.menu; }
          }
          finally { if (isTemp) { try { fs.unlinkSync(judgePath); } catch (e) {} } }
        }
      }
      if (a.path || 'kind' in a) att.push(a);
    }

    // 메일 첨부(matt) — 메일함 Apps Script 가 Drive 로 복사해 둔 파일을 판독한다.
    // 메일함 쪽도 10분 주기라 첨부 목록이 늦게 올라올 수 있다 — 짝을 못 찾으면 다음 실행에서 다시 본다.
    let matt = ((prevMap[m.ts] || {}).matt) || [];
    let mailBig = ((prevMap[m.ts] || {}).mail || {}).big || 0;
    if (isMail) {
      const idx = await mailIndex();
      const e = idx.length ? matchMail(idx, mailFrom, mailSubj, m.ts) : null;
      if (e) {
        const tok = await driveToken();
        const prevM = matt;
        matt = [];
        mailBig = e.big || 0;
        const files = (e.files || []).slice(0, JUDGE_PER_MSG);
        if ((e.files || []).length > JUDGE_PER_MSG) truncated += e.files.length - JUDGE_PER_MSG;
        for (const fl of files) {
          const t = extOf(fl.name) || String(fl.type || '').split('/')[1] || '';
          const p = prevM.find((x) => x.id === fl.id) || {};
          if ('kind' in p) { matt.push({ id: fl.id, t, kind: p.kind, menu: p.menu || [] }); continue; }
          if (p.nj) { matt.push({ id: fl.id, t, nj: 1 }); continue; }
          const isImg = DRIVE_READABLE.test(String(fl.type || ''));
          const src = fl.csv || (isImg ? fl.id : null);
          if (!src) { matt.push({ id: fl.id, t, nj: 1 }); continue; }        // hwp·pptx·zip 등 — 원본 링크만
          if (!tok) { matt.push({ id: fl.id, t }); continue; }
          const ext = fl.csv ? 'csv' : (String(fl.type).split('/')[1] || 'jpg').replace('jpeg', 'jpg');
          const tmp = `${DRIVE_TMP}/m-${src}.${ext}`;
          const got = await driveDownload(src, tmp, tok);
          if (got !== true) { matt.push({ id: fl.id, t }); continue; }       // 다음 실행 재시도
          try {
            const r = fl.csv ? await readMenuText(tmp) : await readMenuImage(tmp);
            if (r && r.bad) matt.push({ id: fl.id, t, nj: 1 });
            else if (r) matt.push({ id: fl.id, t, kind: r.kind, menu: r.menu });
            else matt.push({ id: fl.id, t });
          } finally { try { fs.unlinkSync(tmp); } catch (x) {} }
        }
      }
    }

    items.push({
      ts: m.ts, date: kstDate(m.ts), time: kstHM(m.ts),
      store, biz, pos, content: (mailHead + content).slice(0, 1300), special,
      drive: driveLinks, files: fileCnt, att, datt, replies, rc, lr,
      ...(isMail ? { matt, mail: { link: mailLink, big: mailBig } } : {}),
      // 댓글 첨부까지 훑었는지 — 스레드를 실제로 읽었거나, 애초에 댓글이 없으면 훑을 게 없으므로 완료로 본다
      rfx: (rawReplies !== null || rc === 0) ? RFX_VER : ((prevMap[m.ts] || {}).rfx || 0),
      status, handler: handler || confirmer || null,
      link: `https://${WORKSPACE}/archives/${CHANNEL}/p${String(m.ts).replace('.', '')}`,
    });
  }
  items.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  const capped = items.slice(0, 800);

  // 기존 파일과 내용 동일하면 rewrite 생략(불필요한 커밋 방지) · version 승계
  let version = 0, prevItems = null;
  if (fs.existsSync(OUT)) { const w = {}; try { new Function('window', fs.readFileSync(OUT, 'utf8'))(w); if (w.MENU_REQUESTS) { version = w.MENU_REQUESTS.version || 0; prevItems = JSON.stringify(w.MENU_REQUESTS.items || []); } } catch (e) {} }
  if (prevItems !== null && prevItems === JSON.stringify(capped)) {
    console.log('변경 없음 — 파일 갱신 생략');
    try { fs.rmSync(DRIVE_TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  }
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const data = {
    version: version + 1,
    updatedAt: `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`,
    days: DAYS, items: capped,
    // 판독 설정 상태. 시각·건수 같은 매번 변하는 값은 넣지 않는다 — 넣으면 10분마다 무의미한
    // 커밋이 생긴다. 상태가 바뀔 때만 파일이 바뀌므로, 판독이 0건일 때 원인(키 유무)을 가릴 수 있다.
    // halt 는 판독이 통째로 막힌 사유(크레딧 소진 등). 이게 없으면 '왜 텍스트가 비었는지' 알 길이 없다.
    ocr: { model: OCR_MODEL, enabled: !!process.env.ANTHROPIC_API_KEY, drive: !!process.env.GDRIVE_REFRESH_TOKEN,
           ...(ocrHalt ? { halt: ocrHalt } : {}) },
  };
  const header = '/*\n * 슬랙 #oc팀_메뉴요청 최근 요청 적재 (대시보드 메뉴등록 카테고리용)\n * scripts/fetch-menu-requests.js 가 GitHub Actions에서 주기 갱신합니다.\n */\n';
  fs.writeFileSync(OUT, header + 'window.MENU_REQUESTS = ' + JSON.stringify(data, null, 1) + ';\n', 'utf8');
  const byStatus = capped.reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, {});
  if (ocrDone) console.log(`🔎 신규 이미지 판독 ${ocrDone}건 (${OCR_MODEL}) · 이번 실행 비용 약 $${ocrUsd.toFixed(3)} (₩${Math.round(ocrUsd * KRW_PER_USD).toLocaleString()})${ocrDone >= OCR_CAP ? ` · 상한 ${OCR_CAP}건 도달 — 나머지는 다음 실행에서` : ''}`);
  if (driveDownloaded || driveBlocked || driveSkipped) console.log(`🖼 Drive 파일 ${driveDownloaded}건 수집${driveBlocked ? ` · 권한차단 ${driveBlocked}건(권한 풀리면 자동 복구)` : ''}${driveSkipped ? ` · 미지원형식 ${driveSkipped}건(heif·hwp·xlsx 등)` : ''} — 파일은 저장소에 남기지 않음`);
  if (truncated) console.log(`⚠ 요청당 상한(JUDGE_PER_MSG=${JUDGE_PER_MSG})에 걸려 ${truncated}건을 판독하지 못했습니다 — 상한을 올리세요`);
  // 남은 판독 대기량. 이 값이 실행을 거듭해도 안 줄면 어딘가 막힌 것이다(예전엔 캐시 분기에 묶여 43장이 고정돼 있었다).
  {
    const c = { 원글: [0, 0], 댓글: [0, 0] };
    for (const it of capped) for (const x of (it.att || [])) {
      const s = c[x.from === '댓글' ? '댓글' : '원글'];
      s[1]++; if ('kind' in x) s[0]++;
    }
    const pend = (c.원글[1] - c.원글[0]) + (c.댓글[1] - c.댓글[0]);
    console.log(`🖼 첨부 판독 현황 — 원글 ${c.원글[0]}/${c.원글[1]} · 댓글 ${c.댓글[0]}/${c.댓글[1]}`
      + (pend ? ` · 대기 ${pend}장(판독 불가 제외, 다음 실행에서 계속)` : ' · 대기 없음')
      + (thumbUsed ? ` · 큰 사진 ${thumbUsed}장은 슬랙 축소본으로 판독` : '')
      + (pxShrunk ? ` · ${OCR_MAX_PX}px 초과 ${pxShrunk}장은 축소해 판독` : ''));
    if (ocrHalt) console.log(`⛔ 이번 실행 판독 중단 — HTTP ${ocrHalt.status}: ${ocrHalt.message}\n`
      + `   해결 전까지 대기 ${pend}장은 그대로 남습니다(데이터는 보존되고, 풀리면 자동으로 이어서 판독합니다).`);
  }
  try { fs.rmSync(DRIVE_TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(`✅ ${OUT} 갱신: 요청 ${capped.length}건 (완료 ${byStatus.done || 0} · 확인중 ${byStatus.confirm || 0} · 대기 ${byStatus.wait || 0} · 중복 ${byStatus.dup || 0}) v${data.version}`);
  process.exit(0);   // 좀비 워커가 남아 프로세스가 안 끝나는 것 방지(모든 쓰기는 동기 완료됨)
})();
