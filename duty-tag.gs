/* =========================================================================
 * 금요일 '당직 :star:' 워크플로 글에 당직자 · 10시 출근자 태그 댓글 달기
 *
 * #ishopcare_octeam 에 매주 금 16:30 워크플로가 '당직 :star:' 글을 올린다.
 * 5분 트리거(dutyTagTick)가 금 16:30~20:00 사이에 그 글을 찾아 스레드에 한 번만 댓글을 단다.
 *   - 당직: 이번 토요일 ~ 다음 금요일 중 당직이 잡힌 날(주말 + 공휴일)
 *   - 10시 출근: 다음주 월요일 주의 담당자
 * 데이터는 원격파트 대시보드와 똑같이 계산한다.
 *   당직  = duty-data.js(구글 당직시트) 위에 대시보드 수정분(클라우드 blob.duty)을 칸 단위로 덮어씀
 *   10시  = index.html 의 TEN_ORDER 순번 + 수동 교체(blob.tenOver)
 *
 * 이 파일은 game-backend.gs 와 같은 Apps Script 프로젝트에 '새 파일'로 추가한다.
 * game-backend.gs 에서 쓰는 것: readBlob_() 하나뿐(나머지는 자체 함수).
 *
 * 스크립트 속성
 *   SLACK_BOT_TOKEN   (이미 있음) 스코프: channels:history, chat:write (+ 비공개 채널이면 groups:history)
 *   DUTY_CHANNEL_ID   #ishopcare_octeam 채널 ID (C로 시작). 봇을 채널에 /invite 해야 읽고 쓸 수 있다.
 *   DUTY_SLACK_IDS    (선택) 이름 → 슬랙 멤버 ID JSON. 아래 DUTY_SLACK_IDS 상수보다 우선한다.
 *                     예: {"김주진":"U0123ABCD","공명현":"U0456EFGH"}
 *
 * 편집기에서 실행
 *   installDutyTagTrigger()  5분 트리거 설치 (한 번만)
 *   previewDutyTag()         이번 주 댓글 내용만 로그로 확인 (슬랙에 안 올림)
 *   learnDutySlackIds()      원격 AS 채널의 '원격OOO' 이모지를 누른 사람으로 팀원 ID 추정 → 로그
 *   runDutyTagNow()          지금 바로 찾아서 댓글 달기 (금요일이 아니어도, 오늘 올라온 글 대상)
 * ========================================================================= */

// 이름 → 슬랙 멤버 ID. 비어 있으면 태그 대신 이름만 굵게 쓴다.
// (슬랙 프로필 → ⋮ → '멤버 ID 복사'. 저장소가 public 이므로 민감하면 스크립트 속성 DUTY_SLACK_IDS 에 넣는다)
var DUTY_SLACK_IDS = {
  '송태양': '', '김기범': '', '서상원': '', '김규빈': '', '김동욱': '', '김현기': '',
  '배선유': '', '최민석': '', '심성현': '', '고경림': '', '박하림': '',
  '박성민': '', '이성철': '', '김주진': '', '공명현': '', '김명석': ''
};

var DUTY_TAG = {
  dataUrl: 'https://ishopcare-offcare.github.io/offcare-dashboard/duty-data.js',
  postMatch: /당직/,          // 워크플로 글 판별
  fromMin: 16 * 60 + 30,      // 금 16:30 부터
  toMin: 20 * 60,             // 금 20:00 까지 재시도 (워크플로가 늦게 올라와도 잡힘)
  slots: [['day', '주간'], ['aft', '오후'], ['nit', '야간']]
};

// index.html 의 TEN_ORDER / TEN_ANCHOR_DATE / TEN_ORDER_CHANGES 와 반드시 같게 유지할 것
var DT_TEN_ORDER = ['김현기', '심성현', '배선유', '송태양', '김규빈'];
var DT_TEN_ANCHOR = '2026-07-27';
var DT_TEN_CHANGES = [
  { from: '2026-12-07', order: ['김현기', '심성현', '배선유', '송태양', '김규빈', '고경림'] }
];

/* ---------- 트리거 진입점 ---------- */

function dutyTagTick() {
  var now = dtNowKst_();
  if (now.dow !== 5 || now.min < DUTY_TAG.fromMin || now.min >= DUTY_TAG.toMin) { return; }
  dtRun_(now.date, false);
}

function runDutyTagNow() { dtRun_(dtNowKst_().date, true); }

function previewDutyTag() {
  var fri = dtThisFriday_(dtNowKst_().date);
  console.log('기준 금요일 ' + fri + '\n\n' + dtBuildText_(fri));
}

function installDutyTagTrigger() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'dutyTagTick') { ScriptApp.deleteTrigger(ts[i]); }
  }
  ScriptApp.newTrigger('dutyTagTick').timeBased().everyMinutes(5).create();
  console.log('당직 태그 5분 트리거를 설치했습니다 (금 16:30~20:00 에만 동작).');
}

function removeDutyTagTrigger() {
  var ts = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'dutyTagTick') { ScriptApp.deleteTrigger(ts[i]); n++; }
  }
  console.log('당직 태그 트리거 ' + n + '개 제거');
}

/* ---------- 본체 ---------- */

function dtRun_(date, force) {
  var props = PropertiesService.getScriptProperties();
  var doneKey = 'DUTY_TAG_DONE_' + date;
  if (props.getProperty(doneKey) && !force) { return; }   // 이번 주는 이미 댓글 담

  var channel = props.getProperty('DUTY_CHANNEL_ID');
  if (!channel) { console.log('DUTY_CHANNEL_ID 스크립트 속성이 없습니다.'); return; }

  var post = dtFindPost_(channel, date);
  if (!post) { console.log(date + ' 당직 워크플로 글을 아직 못 찾음'); return; }
  if (props.getProperty(doneKey) === post.ts) { console.log('이미 이 글에 댓글을 달았습니다: ' + post.ts); return; }

  var text = dtBuildText_(dtThisFriday_(date));
  var res = dtSlack_('chat.postMessage', { channel: channel, thread_ts: post.ts, text: text, unfurl_links: false });
  if (!res.ok) { console.log('댓글 실패: ' + res.error); return; }   // 표시 안 함 → 다음 5분에 재시도
  props.setProperty(doneKey, post.ts);
  console.log('댓글 완료 ' + post.ts + '\n' + text);
}

// 그날 KST 16:00 이후 글 중 '당직'이 들어간 가장 이른 글 (워크플로 글은 본문이 blocks/attachments 에 있을 수 있다)
function dtFindPost_(channel, date) {
  var oldest = (dtKstMs_(date, 16 * 60) / 1000).toFixed(0);
  var res = dtSlack_('conversations.history', { channel: channel, oldest: oldest, limit: 100 });
  if (!res.ok) { console.log('채널 읽기 실패: ' + res.error + ' (봇 초대·스코프 확인)'); return null; }
  var hit = null;
  (res.messages || []).forEach(function (m) {
    if (m.thread_ts && m.thread_ts !== m.ts) { return; }          // 댓글 제외
    if (!DUTY_TAG.postMatch.test(dtMsgText_(m))) { return; }
    if (!hit || +m.ts < +hit.ts) { hit = m; }
  });
  return hit;
}

function dtMsgText_(m) {
  var parts = [m.text || ''];
  (function walk(o) {
    if (!o || typeof o !== 'object') { return; }
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o.text === 'string') { parts.push(o.text); }
    for (var k in o) { if (k !== 'text' && typeof o[k] === 'object') { walk(o[k]); } }
  })([m.blocks, m.attachments]);
  return parts.join('\n');
}

function dtBuildText_(fri) {
  var days = dtDutyDays_();
  var cloud = {};
  try { cloud = readBlob_() || {}; } catch (e) { console.log('클라우드 수정분 읽기 실패(시트 값만 사용): ' + e); }
  var over = cloud.duty || {}, tenOver = cloud.tenOver || {};
  var ids = dtSlackIds_();
  var tag = function (name) { return ids[name] ? '<@' + ids[name] + '>' : '*' + name + '*'; };
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];

  var lines = [];
  for (var i = 1; i <= 7; i++) {                                 // 토 ~ 다음 금
    var ds = dtAddDays_(fri, i), base = days[ds] || {}, o = over[ds] || {}, row = [];
    DUTY_TAG.slots.forEach(function (s) {
      var v = (o[s[0]] !== undefined && o[s[0]] !== '') ? o[s[0]] : base[s[0]];   // dutyOf 와 같은 규칙
      if (v) { row.push(s[1] + ' ' + tag(v)); }
    });
    if (row.length) {
      var p = ds.split('-');
      lines.push('• ' + (+p[1]) + '/' + (+p[2]) + '(' + DOW[dtDow_(ds)] + ')  ' + row.join(' · '));
    }
  }

  var mon = dtAddDays_(fri, 3);
  var ten = tenOver[mon] || dtTenPerson_(mon);
  var mp = mon.split('-');

  var out = [':star: *이번 주 당직*'];
  out = out.concat(lines.length ? lines : ['• 지정된 당직이 없습니다']);
  out.push('', ':clock10: *다음주 10시 출근* (' + (+mp[1]) + '/' + (+mp[2]) + '~)  ' + (ten ? tag(ten) : '미지정'));
  out.push('', '_원격파트 대시보드 기준 자동 안내 · 변경 사항은 대시보드에서 수정해 주세요_');
  return out.join('\n');
}

/* ---------- 데이터 ---------- */

function dtDutyDays_() {
  var res = UrlFetchApp.fetch(DUTY_TAG.dataUrl + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { throw new Error('duty-data.js 읽기 실패 ' + res.getResponseCode()); }
  var src = res.getContentText();
  var json = src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1);
  return (JSON.parse(json).days) || {};
}

// index.html rotPerson + tenPersonByDate 와 같은 계산 (mon = 월요일)
function dtTenPerson_(mon) {
  var wk = function (v) { return Math.round((dtUtc_(v) - dtUtc_(DT_TEN_ANCHOR)) / (7 * 86400000)); };
  if (wk(mon) < 0) { return ''; }
  var at = function (o, i, n) { return o[(((i + n) % o.length) + o.length) % o.length]; };
  var order = DT_TEN_ORDER, idx = 0, w0 = 0;
  for (var i = 0; i < DT_TEN_CHANGES.length; i++) {
    var c = DT_TEN_CHANGES[i];
    if (mon < c.from) { break; }
    var wc = wk(c.from), who = at(order, idx, wc - w0);
    order = c.order; idx = Math.max(0, order.indexOf(who)); w0 = wc;
  }
  return at(order, idx, wk(mon) - w0);
}

function dtSlackIds_() {
  var ids = {};
  for (var k in DUTY_SLACK_IDS) { if (DUTY_SLACK_IDS[k]) { ids[k] = DUTY_SLACK_IDS[k]; } }
  var p = PropertiesService.getScriptProperties().getProperty('DUTY_SLACK_IDS');
  if (p) {
    try { var o = JSON.parse(p); for (var n in o) { if (o[n]) { ids[n] = o[n]; } } }
    catch (e) { console.log('DUTY_SLACK_IDS JSON 오류: ' + e); }
  }
  return ids;
}

// 원격 AS 요청 채널에서 '원격OOO' 이모지를 가장 많이 누른 사람 = 그 사람으로 추정.
// 결과는 로그로만 보여준다 — 확인 후 DUTY_SLACK_IDS 속성에 붙여넣을 것.
function learnDutySlackIds() {
  var NICK = { '규빈': '김규빈', '선유': '배선유', '성현': '심성현', '동욱': '김동욱', '현기': '김현기', '태양': '송태양',
               '기범': '김기범', '상원': '서상원', '민석': '최민석', '경림': '고경림', '하림': '박하림' };
  var votes = {}, cursor = '', pages = 0;
  do {
    var res = dtSlack_('conversations.history', { channel: 'C09HRUSG4TX', limit: 200, cursor: cursor || undefined });
    if (!res.ok) { console.log('읽기 실패: ' + res.error); return; }
    (res.messages || []).forEach(function (m) {
      (m.reactions || []).forEach(function (r) {
        var mt = /^원격(.+)$/.exec(r.name || ''), name = mt && NICK[mt[1]];
        if (!name) { return; }
        (r.users || []).forEach(function (u) {
          votes[name] = votes[name] || {};
          votes[name][u] = (votes[name][u] || 0) + 1;
        });
      });
    });
    cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
  } while (cursor && ++pages < 5);
  var out = {};
  for (var n in votes) {
    var best = Object.keys(votes[n]).sort(function (a, b) { return votes[n][b] - votes[n][a]; })[0];
    out[n] = best;
    console.log(n + ' → ' + best + '  (' + JSON.stringify(votes[n]) + ')');
  }
  console.log('DUTY_SLACK_IDS 후보:\n' + JSON.stringify(out));
}

/* ---------- 자체 도우미 (game-backend.gs 배포본과 이름이 겹치지 않게 dt 접두사) ---------- */

function dtSlack_(method, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) { return { ok: false, error: 'no_slack_token' }; }
  var isRead = method === 'conversations.history';
  var url = 'https://slack.com/api/' + method, opt = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  if (isRead) {
    var q = [];
    for (var k in payload) { if (payload[k] !== undefined) { q.push(k + '=' + encodeURIComponent(payload[k])); } }
    url += '?' + q.join('&');
  } else {
    opt.method = 'post'; opt.contentType = 'application/json; charset=utf-8'; opt.payload = JSON.stringify(payload);
  }
  var res = UrlFetchApp.fetch(url, opt);
  try { return JSON.parse(res.getContentText()); }
  catch (e) { return { ok: false, error: 'slack_http_' + res.getResponseCode() }; }
}

function dtPad_(n) { return ('0' + n).slice(-2); }
function dtUtc_(ds) { var d = ds.split('-'); return Date.UTC(+d[0], +d[1] - 1, +d[2]); }
function dtDow_(ds) { return new Date(dtUtc_(ds)).getUTCDay(); }
function dtAddDays_(ds, n) {
  var t = new Date(dtUtc_(ds) + n * 86400000);
  return t.getUTCFullYear() + '-' + dtPad_(t.getUTCMonth() + 1) + '-' + dtPad_(t.getUTCDate());
}
function dtKstMs_(ds, min) { return dtUtc_(ds) + min * 60000 - 9 * 3600000; }
function dtNowKst_() {
  var t = new Date(Date.now() + 9 * 3600000);
  var date = t.getUTCFullYear() + '-' + dtPad_(t.getUTCMonth() + 1) + '-' + dtPad_(t.getUTCDate());
  return { date: date, dow: t.getUTCDay(), min: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
// 그 주(월~일)의 금요일. 토·일에 미리보기하면 지난 금요일 기준.
function dtThisFriday_(ds) { var d = dtDow_(ds); return dtAddDays_(ds, d === 0 ? -2 : 5 - d); }
