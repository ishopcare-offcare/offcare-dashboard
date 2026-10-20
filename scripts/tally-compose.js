#!/usr/bin/env node
/*
 * ============================================================
 *  프랜차이즈 고객사 원장 생성기  (slack-data.js → franchise/data/<slug>.js)
 * ============================================================
 *  fetch-and-tally.js 가 갱신한 slack-data.js 에서 해당 브랜드 매장 건만
 *  골라내 고객사 전용 원장으로 떨군다. Actions 가 집계 직후 이어서 돌린다.
 *
 *    node scripts/tally-compose.js            # 기본 compose
 *    node scripts/tally-compose.js droptop    # 다른 고객사
 *
 *  ── 왜 slack-data.js 를 다시 거르나 ──────────────────────────
 *  브랜드 판별을 대시보드와 '같은 코드'로 해야 숫자가 어긋나지 않는다.
 *  그래서 규칙을 베끼지 않고 franchise/brand-match.js 를 그대로 읽어서 쓴다.
 *  (예전에 허브와 client.html 이 각자 복사본을 갖고 있다가 어긋난 적이 있다)
 *
 *  ── 카테고리 ────────────────────────────────────────────────
 *  슬랙 이모지 체계에 있는 4종(원격AS·온보딩·명의변경·메뉴등록)만 적재한다.
 *  계약서상 나머지 4종(방문AS·단순문의·세금계산서발급·해지·철거)은 슬랙에
 *  분류 자체가 없어 이 경로로는 채울 수 없다 — 이모지가 신설되면 MAP 에 추가.
 * ============================================================
 */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { maskBiz, maskText, maskDeep } = require('./pii-mask');   // 공개 데이터 — 사업자번호 뒤 5자리·상세주소 가림

const ROOT = path.join(__dirname, '..');
const FR   = path.join(ROOT, 'franchise');
const SLUG = process.argv[2] || 'compose';

/* 슬랙 카테고리 → 계약 고객사 카테고리. 값이 없으면 적재하지 않는다 */
const CAT_MAP = {
  as        : 'as',
  onboarding: 'onboarding',
  transfer  : 'transfer',
  menu      : 'menu',
  /* delivery·extern·voc 는 계약 체계에 대응 분류가 없어 제외(아래에서 건수만 보고) */
};

/* 브라우저용 파일들을 가짜 window 위에서 실행해 그대로 재사용한다 */
function loadBrowserModules(){
  const sandbox = { window: {}, console: console };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  for(const f of ['brands.js', 'clients.js', 'brand-match.js']){
    vm.runInContext(fs.readFileSync(path.join(FR, f), 'utf8'), sandbox, { filename: f });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'slack-data.js'), 'utf8'), sandbox, { filename: 'slack-data.js' });
  return sandbox.window;
}

const W = loadBrowserModules();
const client = (W.FRANCHISE_CLIENTS || []).find(c => c.slug === SLUG);
if(!client) throw new Error('clients.js 에 slug=' + SLUG + ' 고객사가 없습니다.');
if(!W.SLACK_DATA || !W.SLACK_DATA.days) throw new Error('slack-data.js 를 읽지 못했습니다.');

const BM  = W.BrandMatch;
const idx = BM.buildIndex(W.FRANCHISE_BRANDS);
const ex  = BM.buildExclude(W.FRANCHISE_EXCLUDE);
const START = client.startDate || '';

const records = [];
const skipped = {};          // 계약 체계에 없는 카테고리 — 버린 건수를 로그로 남긴다
let beforeStart = 0;

function take(date, r, status, emp, req){
  if(ex.test(r.store, r.biz)) return;
  const m = BM.matchBrand(idx, r.store || '');
  if(!m || m.brand.name !== client.brand) return;
  /* 관리 개시일 이전 건은 계약 대상이 아니다 */
  if(START && date < START){ beforeStart++; return; }
  const cat = CAT_MAP[r.cat];
  if(!cat){ skipped[r.cat || '(없음)'] = (skipped[r.cat || '(없음)'] || 0) + 1; return; }
  records.push({
    date  : date,
    time  : r.time || '',
    store : r.store || '',
    branch: BM.branchOf(r.store || '', m.hit),
    biz   : maskBiz(r.biz || ''),
    cat   : cat,
    emp   : emp || '미지정',
    intake: r.intake || 'unknown',
    status: status,
    req   : maskText(req || ''),
    note  : maskText(r.note || ''),
  });
}

for(const date of Object.keys(W.SLACK_DATA.days).sort()){
  const day = W.SLACK_DATA.days[date] || {};
  (day.done    || []).forEach(r => take(date, r, 'done',    r.emp,     r.req));
  (day.pending || []).forEach(r => take(date, r, 'pending', r.handler, (r.reasons || []).join(', ')));
}

records.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString();   // KST
const stampDate = now.slice(0, 10);
const stampTime = now.slice(11, 16);

const body = records.map(r => '    ' + JSON.stringify(r) + ',').join('\n');
const out =
`/*
 * ============================================================
 *  ${client.brand} 인입 원장 — 자동 생성 파일
 * ============================================================
 *  직접 수정하지 마세요. 고치면 다음 집계 때 덮어써집니다.
 *  생성: scripts/tally-compose.js  (slack-data.js 에서 브랜드 매칭)
 *  갱신: ${stampDate} ${stampTime} KST
 *
 *  집계된 카테고리 : ${[...new Set(records.map(r => r.cat))].join(', ') || '(없음)'}
 *  미수집 카테고리 : visit(방문AS) · inquiry(단순문의) · tax(세금계산서발급) · terminate(해지·철거)
 *                    — 슬랙 이모지 체계에 해당 분류가 없어 이 경로로는 적재되지 않습니다.
 * ============================================================
 */
window.CLIENT_DATA = window.CLIENT_DATA || {};
window.CLIENT_DATA['${SLUG}'] = {

  sample    : false,
  updatedAt : '${stampDate} ${stampTime}',
  source    : 'slack-data.js (브랜드 매칭)',

  records: [
${body}
  ],
};
`;

const dest = path.join(FR, 'data', SLUG + '.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });

/* 내용이 그대로면 파일을 건드리지 않는다.
   CI 가 10분마다 도는데 갱신 시각만 바뀌어도 파일이 달라져 커밋이 쌓인다
   (실제로 배포 첫날 57개가 생겼다). 시각을 지운 상태로 비교해서 판단한다. */
/* \r 도 지운다 — 윈도우 작업트리는 CRLF, CI(리눅스)는 LF 라 그대로 비교하면 항상 다르다 */
const NOSTAMP = s => s.split('\r').join('')
                       .replace(/갱신: [\d-]+ [\d:]+ KST/, '갱신: -')
                       .replace(/updatedAt : '[^']*'/, "updatedAt : '-'");
const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
if(prev && NOSTAMP(prev) === NOSTAMP(out)){
  console.log('변경  없음 — 파일 유지 (' + records.length + '건)');
  process.exit(0);
}
fs.writeFileSync(dest, out, 'utf8');

const byCat = {};
records.forEach(r => byCat[r.cat] = (byCat[r.cat] || 0) + 1);
console.log('브랜드  ' + client.brand + ' (개시 ' + (START || '-') + ')');
console.log('적재    ' + records.length + '건  ' + JSON.stringify(byCat));
console.log('지점    ' + new Set(records.map(r => r.branch)).size + '곳');
if(beforeStart)               console.log('제외    개시일 이전 ' + beforeStart + '건');
if(Object.keys(skipped).length) console.log('제외    계약 체계에 없는 분류 ' + JSON.stringify(skipped));
console.log('생성    ' + path.relative(ROOT, dest));
