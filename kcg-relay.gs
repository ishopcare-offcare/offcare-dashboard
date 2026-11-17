/* =========================================================================
 * 강창구찹쌀진순대 협업채널 → #oc팀_메뉴요청 자동 접수
 *
 * #협업채널_강창구_as_메뉴_ishopcare (C0C8QMTB7RC) 에 가맹점이
 *   과천펜타원점
 *   계절메뉴 카테고리 만들어주시고
 *   매생이떡국 11,000원 ...
 * 처럼 올리면, 1분 안에 #oc팀_메뉴요청 (C08740SFT1S) 에 접수 양식으로 올린다.
 *   상호: 강창구찹쌀진순대 과천펜타원점 / KIS
 *   사업자번호 / 핸드폰 번호 / 주소 / 인입유형 / 공급유형 / 배달제휴 / 자대리점   (AS요청 채널과 같은 양식)
 *   내용: [메뉴등록] 원문 요청 내용
 * 매장 정보는 그 지점의 예전 접수 글(AS요청·메뉴요청·명의변경)에서 가장 최근 것부터 빈 칸을 채워 합친다.
 * 처음 요청하는 지점이라 못 찾으면 빈 칸을 '확인 필요'로 두고 댓글로 알린다.
 * 원문 링크·첨부 파일은 접수글 댓글로, 협업채널 원문에는 '접수되었습니다' 댓글을 단다.
 * 접수글에 완료 이모지(원격OOO — 대시보드 집계와 같은 기준)가 붙으면 1분 안에 협업채널 원문에 '처리 완료' 댓글을 단다.
 *   (접수 후 14일 안에 완료되지 않으면 더 지켜보지 않는다 · kcgInstall 이후 접수된 글만)
 *
 * 메뉴 요청이 아닌 글(AS 문의 등)·스레드 댓글·봇 글은 넘기지 않는다.
 *
 * 설치 (game-backend.gs 와 같은 Apps Script 프로젝트에 새 파일로 붙여넣기 — 웹앱 재배포 불필요)
 *   1) 원격집계봇을 협업채널에 초대 (완료)
 *   2) kcgBuildIndex 실행 → 강창구 매장 목록 만들기(처음 한 번 · 오래 걸리면 1분 뒤 자동으로 이어서 함)
 *   3) kcgCheck 실행 → 실행 로그에 ❌ 가 없는지 확인
 *   4) kcgPreview 실행 → 최근 글이 어떻게 올라갈지 미리보기(실제로 올리지 않음)
 *   5) kcgInstall 실행 → 지금 이후 글부터 1분마다 자동 접수 (예전 글은 넘기지 않음)
 *   끄기: kcgUninstall
 * 필요: 스크립트 속성 SLACK_BOT_TOKEN(이미 있음) · 스코프 chat:write, channels:history
 *       (협업채널이 비공개면 groups:history 도 필요 — kcgCheck 가 알려 준다)
 * ========================================================================= */

var KCG = {
  src: 'C0C8QMTB7RC',            // #협업채널_강창구_as_메뉴_ishopcare
  dst: 'C08740SFT1S',            // #oc팀_메뉴요청
  brand: '강창구찹쌀진순대',
  // 매장 정보를 찾을 채널(앞에서부터) · 거슬러 볼 일수
  lookup: [
    { id: 'C09HRUSG4TX', days: 180 },   // AS요청 — 새 양식(배달제휴·자대리점까지)
    { id: 'C08740SFT1S', days: 400 },   // 메뉴요청
    { id: 'C07CL4BV9QT', days: 400 }    // 명의변경
  ],
  ackReply: true,                // 협업채널 원문에 '접수되었습니다' 댓글
  doneReply: true,               // 접수글에 완료 이모지(원격OOO)가 붙으면 협업채널 원문에 '처리 완료' 댓글
  doneWatchDays: 14              // 이 기간 안에 완료되지 않은 접수글은 더 지켜보지 않는다
};
// 메뉴요청 채널의 완료 이모지 — scripts/fetch-menu-requests.js 의 personMap 과 같게
var KCG_PEOPLE = { '규빈': '김규빈', '선유': '배선유', '성현': '심성현', '동욱': '김동욱', '현기': '김현기', '태양': '송태양',
  '기범': '김기범', '상원': '서상원', '민석': '최민석', '경림': '고경림', '하림': '박하림' };
// 브랜드 표기 변형(긴 것부터 지운다) — franchise/brands.js 의 강창구 별칭과 같게
var KCG_BRAND_RE = /(주식회사|\(주\)|창구유통|강창구의?찹쌀진순대국?|강창구찹쌀순대국?|강창구진순대국?|강창구)/g;

/* ---------- 트리거 진입점 ---------- */

function kcgTick() {
  var cache = CacheService.getScriptCache();
  if (cache.get('kcg_running')) { return; }          // 앞 실행(매장 찾기)이 아직 도는 중
  cache.put('kcg_running', '1', 300);
  try {
    var props = PropertiesService.getScriptProperties();
    var last = props.getProperty('KCG_LAST_TS');
    if (!last) { console.log('kcgInstall 을 먼저 실행하세요.'); return; }
    var res = kcgSlack_('conversations.history', { channel: KCG.src, oldest: last, limit: 50 });
    if (!res.ok) { console.log('협업채널 읽기 실패: ' + res.error); return; }
    var msgs = (res.messages || []).slice().reverse();   // 오래된 것부터
    var idx = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!idx && kcgParseRequest_(kcgClean_(m.text || ''))) { idx = kcgIdxLoad_(); kcgIdxRefresh_(idx); kcgIdxSave_(idx); }
      var r = kcgHandle_(m, false, idx);
      if (r === 'retry') { break; }                       // 올리기 실패 → 다음 1분에 이 글부터 다시
      props.setProperty('KCG_LAST_TS', m.ts);
    }
    if (KCG.doneReply) { kcgCheckDone_(); }
  } finally {
    cache.remove('kcg_running');
  }
}

// 글 하나 처리. dry=true 면 올리지 않고 로그만. 반환: 'skip' | 'done' | 'retry'
function kcgHandle_(m, dry, idx) {
  if (!m || !m.ts) { return 'skip'; }
  if (m.bot_id || m.subtype === 'bot_message') { return 'skip'; }
  if (m.subtype && m.subtype !== 'file_share' && m.subtype !== 'thread_broadcast') { return 'skip'; }
  if (m.thread_ts && m.thread_ts !== m.ts) { return 'skip'; }
  var text = kcgClean_(m.text || '');
  var req = kcgParseRequest_(text);
  if (!req) { console.log('[건너뜀] 지점명/메뉴 요청 아님: ' + text.slice(0, 60).replace(/\n/g, ' / ')); return 'skip'; }

  var info = kcgFindStore_(req.branch, idx);
  var post = kcgCompose_(req, info);
  if (dry) {
    console.log('──── ' + kcgKst_(m.ts) + ' 원문 ────\n' + text + '\n──── 올라갈 접수글 ────\n' + post
      + (info ? '\n(매장 정보 출처: ' + info.src + ')' : '\n⚠️ 매장 정보를 못 찾음 — 확인 필요로 올라감'));
    return 'done';
  }

  var sent = kcgSlack_('chat.postMessage', { channel: KCG.dst, text: post, unfurl_links: false, unfurl_media: false });
  if (!sent.ok) { console.log('접수글 올리기 실패: ' + sent.error); return 'retry'; }

  // 접수글 댓글: 원문 링크 · 첨부 · 매장 정보 출처
  var link = kcgSlack_('chat.getPermalink', { channel: KCG.src, message_ts: m.ts });
  var note = ['🤖 강창구 협업채널 요청 자동 접수' + (link.ok ? ' · <' + link.permalink + '|원문 보기>' : '')];
  if (!info) { note.push('⚠️ 처음 요청하는 지점이라 예전 접수 글에서 매장 정보를 찾지 못했습니다. 비어 있는 칸(확인 필요)을 채워 주세요.'); }
  else { note.push('매장 정보: ' + info.src + ' 기준'); }
  var files = (m.files || []).filter(function (f) { return f.permalink; });
  if (files.length) { note.push('📎 첨부 ' + files.length + '개: ' + files.map(function (f, k) { return '<' + f.permalink + '|' + (f.name || ('파일' + (k + 1))) + '>'; }).join(' · ')); }
  kcgSlack_('chat.postMessage', { channel: KCG.dst, thread_ts: sent.ts, text: note.join('\n'), unfurl_links: false, unfurl_media: false });

  if (KCG.ackReply) {
    kcgSlack_('chat.postMessage', { channel: KCG.src, thread_ts: m.ts,
      text: '✅ 메뉴 요청이 접수되었습니다. 담당자가 순서대로 처리해 드릴게요!' });
  }
  kcgPendingAdd_({ d: sent.ts, s: m.ts, b: req.branch });   // 완료 이모지 지켜보기
  console.log('접수 완료: ' + req.branch + ' → ' + sent.ts);
  return 'done';
}

/* ---------- 처리 완료 알림 ---------- */
// 지켜볼 접수글 목록 [{d:접수글 ts, s:협업채널 원문 ts, b:지점}] — 스크립트 속성 한 칸(9KB)에 담는다

function kcgPendingGet_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('KCG_PENDING') || '[]'); } catch (e) { return []; }
}
function kcgPendingSet_(list) {
  var cut = Date.now() / 1000 - KCG.doneWatchDays * 86400;
  list = list.filter(function (p) { return parseFloat(p.d) >= cut; });
  while (list.length && JSON.stringify(list).length > 8500) { list.shift(); }   // 넘치면 오래된 것부터
  PropertiesService.getScriptProperties().setProperty('KCG_PENDING', JSON.stringify(list));
}
function kcgPendingAdd_(p) { var l = kcgPendingGet_(); l.push(p); kcgPendingSet_(l); }

// 접수글의 이모지를 보고, 원격OOO 가 붙은 글은 협업채널 원문에 완료 댓글을 단다
function kcgCheckDone_() {
  var list = kcgPendingGet_();
  if (!list.length) { return; }
  var oldest = list.reduce(function (a, p) { return Math.min(a, parseFloat(p.d)); }, Infinity);
  var reacts = {}, cursor = '', pages = 0;
  do {   // 가장 오래된 접수글부터 지금까지의 글을 한 번에 읽는다(보통 1페이지)
    var q = { channel: KCG.dst, oldest: String(oldest - 1), limit: 200 };
    if (cursor) { q.cursor = cursor; }
    var res = kcgSlack_('conversations.history', q);
    if (!res.ok) { console.log('완료 확인 읽기 실패: ' + res.error); return; }
    (res.messages || []).forEach(function (m) { reacts[m.ts] = (m.reactions || []).map(function (r) { return r.name; }); });
    cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
  } while (cursor && ++pages < 10);

  var re = new RegExp('^원격(' + Object.keys(KCG_PEOPLE).join('|') + ')$'), left = [];
  list.forEach(function (p) {
    var names = reacts[p.d];
    if (!names) { left.push(p); return; }                       // 못 읽음(지워졌거나 범위 밖) → 기한까지 유지
    var who = '';
    for (var i = 0; i < names.length && !who; i++) { var x = names[i].match(re); if (x) { who = KCG_PEOPLE[x[1]]; } }
    if (!who) { left.push(p); return; }
    var r = kcgSlack_('chat.postMessage', { channel: KCG.src, thread_ts: p.s,
      text: '🎉 요청하신 메뉴 작업이 처리 완료되었습니다! 포스에서 확인 부탁드립니다. (담당: ' + who + ')' });
    if (r.ok) { console.log('완료 알림: ' + p.b + ' (' + who + ')'); }
    else { console.log('완료 알림 실패(다음 1분에 재시도): ' + r.error); left.push(p); }
  });
  kcgPendingSet_(left);
}

/* ---------- 요청 글 해석 ---------- */

// 지점명 + 본문. 메뉴 요청으로 보이지 않으면 null
function kcgParseRequest_(text) {
  var lines = text.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  if (!lines.length) { return null; }
  var idx = -1, branch = '';
  var tidy = function (l) {
    return l.replace(/^(안녕하세요|수고하십니다|수고\s*많으십니다)[.!,~\s]*/, '').replace(/^[\[(【]|[\])】]$/g, '')
      .replace(/\s*(입니다|이에요|에요)[.!~]*$/, '').trim();
  };
  var price = /\d{1,3},\d{3}|\d+\s*원/;
  // 앞쪽 3줄 중 '…점' 으로 끝나는 짧은 줄 → 없으면 첫 줄이 짧은 이름이면 그걸 지점명으로('과천펜타원')
  for (var i = 0; i < Math.min(3, lines.length) && idx < 0; i++) {
    var l = tidy(lines[i]), b = kcgBranchKey_(l);
    if (l.length <= 25 && !price.test(l) && /..점$/.test(b)) { idx = i; branch = b; }
  }
  if (idx < 0 && lines.length > 1) {
    var l0 = tidy(lines[0]), b0 = kcgBranchKey_(l0);
    if (b0 && b0.length <= 12 && !price.test(l0) && !/메뉴|카테고리|요청|부탁|안녕/.test(l0)) { idx = 0; branch = b0; }
  }
  if (idx < 0) { return null; }
  var body = lines.slice(idx + 1).join('\n');
  if (!body) { return null; }
  if (!/메뉴|카테고리|가격|단가|금액|품절|옵션|\d[\d,]*\s*원|등록|생성|추가|삭제|수정|변경/.test(body)) { return null; }   // AS 문의 등
  var add = /생성|등록|추가|만들|신규|넣어/.test(body);
  var mod = /수정|변경|삭제|인상|인하|품절|바꿔|빼|내려|올려/.test(body);
  return { branch: branch, body: body, kind: add && mod ? '메뉴등록·수정' : (mod ? '메뉴수정' : '메뉴등록') };
}

// '강창구찹쌀진순대 과천펜타원점 / KIS' · '과천펜타원점' → '과천펜타원점'
function kcgBranchKey_(s) {
  return String(s || '').split('/')[0].replace(/\(.*?\)/g, '').replace(/\s+/g, '').replace(KCG_BRAND_RE, '').trim();
}
function kcgSameBranch_(a, b) {
  if (!a || !b) { return false; }
  var x = a.replace(/점$/, ''), y = b.replace(/점$/, '');
  return x === y;
}

/* ---------- 매장 정보 찾기 (매장 목록 인덱스) ----------
 * 요청마다 AS요청 채널 수만 건을 훑으면 슬랙 속도 제한 + 6분 실행 제한에 걸려 멈춘다.
 * → 강창구 접수 글만 모아 '지점 → 칸별 최신 값' 목록을 스크립트 속성에 저장해 두고(kcgBuildIndex, 한 번),
 *   요청이 올 때는 마지막으로 본 뒤의 새 글만 읽어 보충한다(보통 채널당 1번 호출).
 * 저장 형태: { ts:{채널:마지막으로 본 ts}, s:{지점키:{칸:[값, ts]}} } — 8000자 조각으로 나눠 KCG_IDX_0.. 에 */

var KCG_FIELDS = ['store', 'biz', 'phone', 'addr', 'inflow', 'supply', 'delivery', 'agency'];
var KCG_TIME_BUDGET = 270 * 1000;   // 한 번 실행에서 목록 만들기에 쓸 시간(6분 제한 여유)

function kcgIdxLoad_() {
  var p = PropertiesService.getScriptProperties(), n = parseInt(p.getProperty('KCG_IDX_N') || '0', 10), raw = '';
  for (var i = 0; i < n; i++) { raw += p.getProperty('KCG_IDX_' + i) || ''; }
  try { var o = raw ? JSON.parse(raw) : null; if (o && o.s) { o.ts = o.ts || {}; return o; } } catch (e) {}
  return { ts: {}, s: {} };
}
function kcgIdxSave_(idx) {
  var p = PropertiesService.getScriptProperties(), raw = JSON.stringify(idx), old = parseInt(p.getProperty('KCG_IDX_N') || '0', 10);
  var parts = {}, n = 0;
  for (var i = 0; i < raw.length; i += 8000) { parts['KCG_IDX_' + (n++)] = raw.slice(i, i + 8000); }
  parts.KCG_IDX_N = String(n);
  p.setProperties(parts);
  for (var j = n; j < old; j++) { p.deleteProperty('KCG_IDX_' + j); }
}
function kcgKey_(store) { return kcgBranchKey_(store).replace(/점$/, ''); }

// 글 하나를 목록에 반영 — 칸마다 더 최근 값만 덮는다
function kcgIdxAdd_(idx, m) {
  var t = kcgClean_(m.text || '');
  if (t.indexOf('창구') < 0) { return false; }
  var fl = kcgParseTemplate_(t);
  if (!fl.store) { return false; }
  var k = kcgKey_(fl.store);
  if (!k) { return false; }
  var e = idx.s[k] || (idx.s[k] = {}), ts = parseFloat(m.ts), ch = false;
  KCG_FIELDS.forEach(function (f) {
    if (!fl[f]) { return; }
    if (!e[f] || e[f][1] < ts) { e[f] = [fl[f], ts]; ch = true; }
  });
  return ch;
}

// 채널 하나를 oldest~latest 범위로 읽어 목록에 반영. 시간이 다 되면 다음에 이어 볼 cursor 를 돌려준다
function kcgIdxScan_(idx, chId, oldest, latest, cursor, t0) {
  var pages = 0;
  do {
    if (Date.now() - t0 > KCG_TIME_BUDGET) { return { more: true, cursor: cursor }; }
    var p = { channel: chId, oldest: String(oldest), limit: 200 };
    if (latest) { p.latest = String(latest); }
    if (cursor) { p.cursor = cursor; }
    var res = kcgSlack_('conversations.history', p);
    if (!res.ok) { console.log('읽기 실패(' + chId + '): ' + res.error); return { more: false, error: res.error }; }
    (res.messages || []).forEach(function (m) { kcgIdxAdd_(idx, m); });
    cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
    if (++pages % 10 === 0) { console.log('  … ' + chId + ' ' + pages + '페이지 · 지점 ' + Object.keys(idx.s).length + '곳'); }
  } while (cursor);
  return { more: false };
}

// 새 글만 보충 (요청이 올 때마다)
function kcgIdxRefresh_(idx) {
  var now = Date.now() / 1000, t0 = Date.now();
  KCG.lookup.forEach(function (c) {
    var from = idx.ts[c.id] || (now - 3 * 86400);   // 목록을 아직 안 만들었으면 최근 3일만
    var r = kcgIdxScan_(idx, c.id, from, null, '', t0);
    if (!r.more && !r.error) { idx.ts[c.id] = now; }
  });
}

function kcgFindStore_(branch, idx) {
  idx = idx || kcgIdxLoad_();
  var e = idx.s[branch.replace(/점$/, '')];
  if (!e || !e.store) { return null; }
  var out = {}, last = 0;
  KCG_FIELDS.forEach(function (f) { if (e[f]) { out[f] = e[f][0]; last = Math.max(last, e[f][1]); } });
  out.src = '예전 접수 글(최근 ' + kcgKst_(last).slice(0, 10) + ')';
  return out;
}

// 접수 글에서 칸 읽기 — AS요청 새 양식과 메뉴요청 예전 양식 둘 다
function kcgParseTemplate_(t) {
  var g = function (re) { var x = t.match(re); return x ? x[1].trim() : ''; };
  // 콜론 앞뒤 공백은 [ \t] 만 — \s 를 쓰면 빈 칸('배달제휴:')이 다음 줄 값을 삼킨다
  var L = '^[ \\t\\-•*]*';
  var r = function (lab) { return new RegExp(L + lab + '[ \\t]*[:：][ \\t]*(.*)$', 'm'); };
  var onoff = g(r('오프\\s*\\/\\s*온라인'));                     // 예전: '오프라인 / 임대'
  var oo = onoff.split('/').map(function (x) { return x.trim(); });
  var phone = g(r('(?:핸드폰|휴대폰|휴대전화)\\s*번호')) || g(r('대표자?\\s*(?:전화번호|연락처|휴대폰|핸드폰)'))
    || g(r('(?:가게|매장)\\s*(?:연락처|전화번호)'));
  return {
    store: g(r('상호명?')),
    biz: g(r('사업자\\s*(?:등록)?\\s*번호')),
    phone: phone,
    addr: g(r('주소')),
    inflow: g(r('인입\\s*유형')) || (/라인/.test(oo[0] || '') ? oo[0] : ''),
    supply: g(r('공급\\s*유형')) || (oo[1] || ''),
    delivery: g(r('배달\\s*제휴')),
    agency: g(r('자\\s*대리점'))
  };
}

// #oc팀_메뉴요청 접수글 — AS요청 채널과 같은 양식
function kcgCompose_(req, f) {
  f = f || {};
  var need = function (k) { return f[k] || '확인 필요'; };
  return [
    '상호: ' + (f.store || (KCG.brand + ' ' + req.branch + ' / 확인 필요')),
    '사업자번호: ' + need('biz'),
    '핸드폰 번호: ' + need('phone'),
    '주소: ' + need('addr'),
    '인입유형: ' + need('inflow'),
    '공급유형: ' + need('supply'),
    '배달제휴: ' + (f.delivery || ''),
    '자대리점: ' + (f.agency || ''),
    '내용: [' + req.kind + '] ' + req.body
  ].join('\n');
}

/* ---------- 공통 ---------- */

// 슬랙 표기 → 보이는 글자 (<tel:…|010-…> → 010-…, &amp; → &)
function kcgClean_(s) {
  return String(s)
    .replace(/<(?:tel|mailto):[^|>]*\|([^>]+)>/g, '$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function kcgKst_(ts) { return Utilities.formatDate(new Date(parseFloat(ts) * 1000), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'); }

function kcgSlack_(method, params) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) { return { ok: false, error: 'SLACK_BOT_TOKEN 없음' }; }
  var isWrite = method === 'chat.postMessage';
  var opt = { method: isWrite ? 'post' : 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  var url = 'https://slack.com/api/' + method;
  if (isWrite) { opt.contentType = 'application/json; charset=utf-8'; opt.payload = JSON.stringify(params); }
  else {
    url += '?' + Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== ''; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  }
  for (var a = 0; a < 3; a++) {
    var res = UrlFetchApp.fetch(url, opt);
    if (res.getResponseCode() === 429) { Utilities.sleep(1000 * (parseInt(res.getHeaders()['Retry-After'] || '2', 10) || 2)); continue; }
    try { return JSON.parse(res.getContentText()); } catch (e) { return { ok: false, error: 'HTTP ' + res.getResponseCode() }; }
  }
  return { ok: false, error: 'rate_limited' };
}

/* ---------- 편집기에서 직접 실행 ---------- */

// 매장 목록 만들기 — 처음 한 번. 4분 30초씩 나눠 돌고, 덜 끝나면 1분 뒤 자동으로 이어서 한다
function kcgBuildIndex() {
  var p = PropertiesService.getScriptProperties(), t0 = Date.now();
  var st = JSON.parse(p.getProperty('KCG_BUILD') || 'null');
  var idx = st ? kcgIdxLoad_() : { ts: {}, s: {} };
  if (!st) { st = { c: 0, cursor: '', upto: Date.now() / 1000 }; console.log('매장 목록 만들기 시작'); }
  else { console.log('매장 목록 이어서 만들기 (' + (st.c + 1) + '/' + KCG.lookup.length + '번째 채널)'); }
  kcgBuildCont_(false);
  while (st.c < KCG.lookup.length) {
    var c = KCG.lookup[st.c];
    var r = kcgIdxScan_(idx, c.id, st.upto - c.days * 86400, st.upto, st.cursor, t0);
    if (r.more) {
      st.cursor = r.cursor; p.setProperty('KCG_BUILD', JSON.stringify(st)); kcgIdxSave_(idx);
      kcgBuildCont_(true);
      console.log('⏳ 시간이 다 돼 1분 뒤 자동으로 이어서 합니다. (지금까지 지점 ' + Object.keys(idx.s).length + '곳) — 기다리시면 됩니다');
      return;
    }
    if (r.error) { console.log('❌ 중단: ' + r.error); p.setProperty('KCG_BUILD', JSON.stringify(st)); kcgIdxSave_(idx); return; }
    idx.ts[c.id] = st.upto; st.c++; st.cursor = '';
    console.log('✅ ' + c.id + ' 완료 · 지점 ' + Object.keys(idx.s).length + '곳');
  }
  kcgIdxSave_(idx); p.deleteProperty('KCG_BUILD');
  console.log('🎉 매장 목록 완성: 강창구 지점 ' + Object.keys(idx.s).length + '곳 — ' + Object.keys(idx.s).slice(0, 30).join(', '));
}
function kcgBuildCont_(on) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'kcgBuildIndex') { ScriptApp.deleteTrigger(t); } });
  if (on) { ScriptApp.newTrigger('kcgBuildIndex').timeBased().after(60 * 1000).create(); }
}

// 설정 점검 — 아무것도 올리지 않는다 (몇 초면 끝난다)
function kcgCheck() {
  var a = kcgSlack_('auth.test', {});
  console.log('봇 토큰: ' + (a.ok ? '정상 (' + a.user + ')' : '❌ ' + a.error));
  var info = kcgSlack_('conversations.info', { channel: KCG.src });
  console.log('협업채널 정보: ' + (info.ok ? '#' + info.channel.name + (info.channel.is_private ? ' (비공개)' : '') + (info.channel.is_ext_shared ? ' · 외부 공유' : '') + (info.channel.is_member ? ' · 봇 참여 ✅' : ' · ❌ 봇 미참여') : '❌ ' + info.error));
  var h = kcgSlack_('conversations.history', { channel: KCG.src, limit: 5 });
  console.log('협업채널 읽기: ' + (h.ok ? '✅ 최근 ' + (h.messages || []).length + '건' : '❌ ' + h.error + (h.error === 'missing_scope' ? ' — 비공개 채널이면 봇에 groups:history 스코프 추가 후 재설치' : '')));
  var d = kcgSlack_('conversations.info', { channel: KCG.dst });
  console.log('#oc팀_메뉴요청 봇 참여: ' + (d.ok && d.channel.is_member ? '✅' : '❌ ' + (d.error || '미참여')));
  var p = PropertiesService.getScriptProperties(), idx = kcgIdxLoad_(), n = Object.keys(idx.s).length;
  console.log('매장 목록: ' + (p.getProperty('KCG_BUILD') ? '⏳ 만드는 중' : n ? '✅' : '❌ 없음 — kcgBuildIndex 를 실행하세요') + ' 지점 ' + n + '곳');
  var t = kcgFindStore_('과천펜타원점', idx);
  console.log('매장 찾기 시험(과천펜타원점): ' + (t ? '✅ ' + t.src + '\n' + kcgCompose_({ branch: '과천펜타원점', kind: '메뉴등록', body: '(시험)' }, t) : '❌ 못 찾음'));
  console.log('자동 접수: ' + (p.getProperty('KCG_LAST_TS') ? '켜짐' : '꺼짐 (kcgInstall 로 켜기)') + ' · 완료 대기 중인 접수글 ' + kcgPendingGet_().length + '건');
}

// 협업채널 최근 글 5건이 어떻게 올라갈지 미리보기 — 실제로 올리지 않는다
function kcgPreview() {
  var h = kcgSlack_('conversations.history', { channel: KCG.src, limit: 5 });
  if (!h.ok) { console.log('❌ ' + h.error); return; }
  var idx = kcgIdxLoad_();
  (h.messages || []).slice().reverse().forEach(function (m) { kcgHandle_(m, true, idx); });
}

// 지금 이후 글부터 자동 접수 (예전 글은 넘기지 않음) + 1분 트리거
function kcgInstall() {
  kcgUninstall();
  PropertiesService.getScriptProperties().setProperty('KCG_LAST_TS', String(Date.now() / 1000));
  ScriptApp.newTrigger('kcgTick').timeBased().everyMinutes(1).create();
  console.log('설치 완료 — 지금 이후 협업채널 글을 1분마다 #oc팀_메뉴요청 으로 접수합니다.');
  if (!Object.keys(kcgIdxLoad_().s).length) { console.log('⚠️ 매장 목록이 비어 있습니다 — kcgBuildIndex 를 실행하세요.'); }
}

function kcgUninstall() {
  var ts = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < ts.length; i++) { if (ts[i].getHandlerFunction() === 'kcgTick') { ScriptApp.deleteTrigger(ts[i]); n++; } }
  PropertiesService.getScriptProperties().deleteProperty('KCG_LAST_TS');
  if (n) { console.log('자동 접수 트리거 ' + n + '개를 껐습니다.'); }
}
