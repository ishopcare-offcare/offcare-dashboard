// Team shared store + per-employee PIN/OTP auth (concurrency safe).
// Data (A1): { _v, players, vocEdit, vocPraise, vocComment, dutyOver }
// Secrets (A2, NEVER returned by doGet): { pins:{emp:{hash,salt}}, otps:{emp:{code,exp}}, fails:{emp:{count,until}} }
//
// POST {patch}/{game} : save data (patch merge / full overwrite).
// GET  ?action=...     : auth (status/checkPin/sendOtp/setPin/setPinDirect).

var SHEET_ID = '';
var ADMIN_KEY = 'CHANGE_ME_1234';   // CHANGE THIS to your own secret. Used for admin PIN reset.

// Employee emails for OTP. Keys are \u escapes of the app names (pure ASCII, paste-proof).
// Fill the empty '' parts with each person's @ishopcare email.
var EMP_EMAIL = {
  '송태양': 'taeyang.song@ishopcare.co.kr',  // song tae-yang
  '김기범': '',  // gim gi-beom
  '서상원': '',  // seo sang-won
  '김규빈': '',  // gim gyu-bin
  '김동욱': '',  // gim dong-uk
  '김현기': '',  // gim hyeon-gi
  '배선유': '',  // bae seon-yu
  '최민석': '',  // choe min-seok
  '심성현': '',  // sim seong-hyeon
  '고경림': ''   // go gyeong-rim
};
function norm_(s) { try { return ('' + s).normalize('NFC'); } catch (x) { return '' + s; } }
function emailOf_(emp) {
  if (EMP_EMAIL[emp]) { return EMP_EMAIL[emp]; }
  var e = norm_(emp);
  for (var k in EMP_EMAIL) {
    if (norm_(k) === e && EMP_EMAIL[k]) { return EMP_EMAIL[k]; }
  }
  return '';
}

function store_() {
  var ss = null;
  if (SHEET_ID) {
    ss = SpreadsheetApp.openById(SHEET_ID);
  } else {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('STORE_SHEET_ID');
    if (id) {
      try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
    }
    if (!ss) {
      try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
    }
    if (!ss) {
      ss = SpreadsheetApp.create('offcare-dashboard-store');
      props.setProperty('STORE_SHEET_ID', ss.getId());
    } else if (!id) {
      try { props.setProperty('STORE_SHEET_ID', ss.getId()); } catch (e) {}
    }
  }
  var sh = ss.getSheetByName('store');
  if (!sh) { sh = ss.insertSheet('store'); }
  return sh;
}

// 공유 데이터는 시트 한 칸에 다 넣을 수 없다.
// 구글 시트는 셀 하나에 50,000자 제한이 있는데 2026-08-24 에 데이터가 50,070자가 되어
// '용량이 늘어나는 저장'이 전부 실패했다. 클라이언트는 pushPatch 오류를 삼키고 있었고
// Apps Script 는 HTTP 200 에 HTML 오류 페이지를 돌려줘서, 아무도 모르는 채로
// 각자 편집이 자기 브라우저에만 남아 직원마다 화면이 달라졌다.
// → 전용 시트에 여러 행으로 나눠 저장한다(행 수는 사실상 무제한).
var BLOB_SHEET = 'blob';
var CHUNK = 45000;            // 50,000 한도에 여유를 둔다

function blobSheet_() {
  var ss = store_().getParent();
  var sh = ss.getSheetByName(BLOB_SHEET);
  if (!sh) { sh = ss.insertSheet(BLOB_SHEET); }
  return sh;
}

function readBlob_() {
  var sh = blobSheet_();
  var last = sh.getLastRow();
  if (last >= 1) {
    var vals = sh.getRange(1, 1, last, 1).getValues();
    var s = '';
    for (var i = 0; i < vals.length; i++) { s += (vals[i][0] || ''); }
    if (s) {
      try { return JSON.parse(s); }
      catch (e) { /* 손상 시에는 아래 레거시 칸으로 폴백 */ }
    }
  }
  // 레거시: 예전에는 store!A1 한 칸에 전부 넣었다. 첫 쓰기 때 blob 시트로 옮겨진다.
  var v = store_().getRange('A1').getValue();
  if (!v) { return {}; }
  try { return JSON.parse(v); } catch (e) { return {}; }
}

function writeBlob_(obj) {
  var s = JSON.stringify(obj);
  var sh = blobSheet_();
  var chunks = [];
  for (var i = 0; i < s.length; i += CHUNK) { chunks.push([s.substring(i, i + CHUNK)]); }
  if (!chunks.length) { chunks = [['']]; }
  var last = sh.getLastRow();
  if (last > chunks.length) {   // 데이터가 줄어든 경우 남은 옛 행을 지운다(안 지우면 뒤에 쓰레기가 붙는다)
    sh.getRange(chunks.length + 1, 1, last - chunks.length, 1).clearContent();
  }
  sh.getRange(1, 1, chunks.length, 1).setValues(chunks);
  // 이관 완료 후 레거시 칸을 비운다. 남겨두면 blob 파싱이 한 번 실패했을 때
  // 옛 데이터로 조용히 되돌아가 최신 편집이 통째로 사라진다.
  var legacy = store_().getRange('A1');
  if (legacy.getValue()) { legacy.clearContent(); }
}
function readSecret_() {
  var v = store_().getRange('A2').getValue();
  if (!v) { return {}; }
  try { return JSON.parse(v); } catch (e) { return {}; }
}
function saveSecret_(s) { store_().getRange('A2').setValue(JSON.stringify(s)); }

function json_(obj) {
  var s = JSON.stringify(obj);
  var out = ContentService.createTextOutput(s);
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

function sha_(str) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < raw.length; i++) {
    var b = (raw[i] + 256) % 256;
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return hex;
}
function genCode_() { return ('000000' + Math.floor(Math.random() * 1000000)).slice(-6); }

// 필드 단위로 합칠 섹션.
// VOC 한 건에는 상태·처리내용·업종·저점사유가 같이 붙어 있어서, 두 사람이 같은 건의
// 다른 필드를 비슷한 시각에 고치는 일이 잦다. 키를 통째로 대입하면 나중 사람이 보낸
// 객체에 앞사람 필드가 없어서 앞사람 편집이 사라진다 → 여기서만 한 겹 더 들어가 합친다.
// (players 는 레코드 타임스탬프(_t) 최신 우선이라 통째 대입이 맞다 — 넣지 않는다)
var DEEP_MERGE = { vocEdit: true, vocPraise: true };

function mergePatch_(base, patch) {
  if (!base) { base = {}; }
  for (var section in patch) {
    var pv = patch[section];
    if (pv && typeof pv === 'object' && !(pv instanceof Array)) {
      if (!base[section] || typeof base[section] !== 'object') { base[section] = {}; }
      for (var key in pv) {
        var val = pv[key];
        // null = 키 삭제(구 클라이언트 호환). 신 클라이언트는 ''(묘비)를 보낸다 —
        // 키를 지우면 그 항목을 아직 들고 있는 다른 브라우저가 '나만 가진 값'으로 보고
        // 되돌려 올려서 삭제가 부활한다.
        if (val === null) { delete base[section][key]; continue; }
        var cur = base[section][key];
        if (DEEP_MERGE[section] &&
            val && typeof val === 'object' && !(val instanceof Array) &&
            cur && typeof cur === 'object' && !(cur instanceof Array)) {
          for (var f in val) {
            if (val[f] === null) { delete cur[f]; }   // 그 필드만 지우라는 표시
            else { cur[f] = val[f]; }
          }
        } else {
          base[section][key] = val;
        }
      }
    } else {
      base[section] = pv;
    }
  }
  return base;
}

// 변경 감지용 리비전. 쓰기(doPost)가 일어날 때마다 1씩 증가한다.
// 시트가 아니라 ScriptProperties 에 두는 이유: 50KB 블롭을 읽고 파싱할 필요 없이
// 숫자 하나만 돌려줘서, 클라이언트가 짧은 주기로 찔러봐도 부담이 없게 하려고.
var REV_KEY = 'STORE_REV';
function readRev_() {
  var v = PropertiesService.getScriptProperties().getProperty(REV_KEY);
  var n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}
function bumpRev_() {
  var props = PropertiesService.getScriptProperties();
  var n = readRev_() + 1;
  props.setProperty(REV_KEY, String(n));
  return n;
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    // 경량 변경 확인 — 시트를 건드리지 않고 리비전 숫자만 반환(응답 수십 바이트).
    if (p.action === 'rev') { return json_({ ok: true, rev: readRev_() }); }
    if (p.action === 'bookings') { return json_(listBookings_(p)); }
    if (p.action) { return handleAuth_(p); }
    // rev 를 블롭보다 '먼저' 읽는다. 반대 순서면 두 읽기 사이에 들어온 쓰기를
    // 클라이언트가 이미 받은 것으로 착각해 그 변경을 영영 놓친다.
    var rev = readRev_();
    return json_({ game: readBlob_(), rev: rev });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var raw = '{}';
    if (e && e.postData && e.postData.contents) { raw = e.postData.contents; }
    var body = JSON.parse(raw);
    // 원격 예약은 공유 블롭과 무관하다 — 블롭을 읽고 쓰지 않고 rev 도 올리지 않는다.
    // (같은 스크립트 락 안이라 동시에 들어온 예약 두 건이 마지막 한 자리를 같이 차지하지 못한다)
    if (body.action === 'book') { return json_(createBooking_(body)); }
    if (body.action === 'cancelBooking') { return json_(cancelBooking_(body)); }
    var cur = readBlob_();
    if (body.patch) { cur = mergePatch_(cur, body.patch); }
    else if (body.game) { cur = body.game; }
    writeBlob_(cur);
    var rev = bumpRev_();                 // 락 안에서 증가 → 다른 클라이언트가 다음 rev 조회 때 감지
    return json_({ ok: true, rev: rev });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function handleAuth_(p) {
  var emp = norm_(p.emp || '');
  var action = p.action;

  if (action === 'status') {
    var s0 = readSecret_();
    var pins0 = s0.pins || {};
    return json_({ ok: true, hasPin: !!pins0[emp], hasEmail: !!emailOf_(emp), got: emp });
  }

  if (action === 'checkPin') {
    var lock1 = LockService.getScriptLock();
    try {
      lock1.waitLock(10000);
      var sec = readSecret_();
      sec.pins = sec.pins || {}; sec.fails = sec.fails || {};
      var f = sec.fails[emp];
      if (f && f.until && f.until <= Date.now()) { delete sec.fails[emp]; f = null; }
      if (f && f.until && f.until > Date.now()) { saveSecret_(sec); return json_({ ok: false, locked: true }); }
      var pin = sec.pins[emp];
      if (!pin) { return json_({ ok: false, error: 'no_pin' }); }
      var ok = (sha_(String(p.pin) + pin.salt) === pin.hash);
      if (ok) { delete sec.fails[emp]; }
      else { var cnt = (f ? f.count : 0) + 1; sec.fails[emp] = { count: cnt, until: cnt >= 5 ? Date.now() + 600000 : 0 }; }
      saveSecret_(sec);
      return json_({ ok: ok, locked: false });
    } finally { try { lock1.releaseLock(); } catch (e) {} }
  }

  if (action === 'sendOtp') {
    var email = emailOf_(emp);
    if (!email) { return json_({ ok: false, error: 'no_email' }); }
    var lock2 = LockService.getScriptLock();
    try {
      lock2.waitLock(10000);
      var sec2 = readSecret_(); sec2.otps = sec2.otps || {};
      var code = genCode_();
      sec2.otps[emp] = { code: code, exp: Date.now() + 600000 };
      saveSecret_(sec2);
      MailApp.sendEmail(email, '[Offcare 원격상점] 인증코드', emp + ' auth code: ' + code + '\n10 min valid. Ignore if not requested.');
      return json_({ ok: true, sent: true });
    } finally { try { lock2.releaseLock(); } catch (e) {} }
  }

  if (action === 'setPin' || action === 'setPinDirect') {
    var lock3 = LockService.getScriptLock();
    try {
      lock3.waitLock(10000);
      var sec3 = readSecret_(); sec3.pins = sec3.pins || {}; sec3.otps = sec3.otps || {}; sec3.fails = sec3.fails || {};
      if (action === 'setPinDirect') {
        if (sec3.pins[emp]) { return json_({ ok: false, error: 'pin_exists' }); }
      } else {
        var o = sec3.otps[emp];
        if (!o || o.code !== String(p.otp) || Date.now() > o.exp) { return json_({ ok: false, error: 'bad_otp' }); }
        delete sec3.otps[emp];
      }
      var pinStr = String(p.pin || '');
      if (pinStr.length < 4) { return json_({ ok: false, error: 'short_pin' }); }
      var salt = sha_(emp + Date.now() + Math.random());
      sec3.pins[emp] = { hash: sha_(pinStr + salt), salt: salt };
      delete sec3.fails[emp];
      saveSecret_(sec3);
      return json_({ ok: true });
    } finally { try { lock3.releaseLock(); } catch (e) {} }
  }

  if (action === 'clearPin') {
    if (String(p.key) !== ADMIN_KEY) { return json_({ ok: false, error: 'bad_key' }); }
    var lock4 = LockService.getScriptLock();
    try {
      lock4.waitLock(10000);
      var sec4 = readSecret_(); sec4.pins = sec4.pins || {}; sec4.fails = sec4.fails || {};
      delete sec4.pins[emp]; delete sec4.fails[emp];
      saveSecret_(sec4);
      return json_({ ok: true });
    } finally { try { lock4.releaseLock(); } catch (e) {} }
  }

  return json_({ ok: false, error: 'unknown_action' });
}

/* =========================================================================
 * 슬랙 새 글 감지 → GitHub 워크플로 즉시 실행 (1분 시간 트리거)
 *
 * 왜 필요한가: 워크플로 cron 은 '*​/10' 인데 GitHub 무료 러너가 예약 실행을
 * 건너뛰어 실제로는 15분마다만 돈다(커밋 시각이 정확히 :00/:15/:30/:45 격자).
 * 집계 작업 자체는 ~30초라, 느린 건 처리가 아니라 '시작을 기다리는 시간'이다.
 * → 1분마다 슬랙만 훑어보고 새 글이 있으면 repository_dispatch 로 즉시 깨운다.
 *
 * 설치(편집기에서 1회): installSlackWatchTrigger() 실행
 * 필요한 스크립트 속성: SLACK_BOT_TOKEN, GITHUB_TOKEN
 * 동작 확인: testSlackWatch() 실행 후 실행 로그 확인
 * ========================================================================= */

// 감시 대상 채널. 워크플로는 실행될 때마다 '모든' 채널을 다시 집계하므로,
// 여기 두 채널만 봐도 나머지(명의변경·배달·VOC)까지 같이 최신화된다.
// 더 넣고 싶으면 추가하면 되지만, 채널 하나당 1분마다 UrlFetch 가 한 번 더 나간다.
var WATCH_CHANNELS = [
  { id: 'C08740SFT1S', name: '메뉴요청' },
  { id: 'C09HRUSG4TX', name: 'AS요청' }
];
var GH_REPO = 'taeyangsong-art/offcare-dashboard';
var GH_EVENT = 'slack-new-message';      // 워크플로의 repository_dispatch types 와 일치해야 함
// KST 업무시간 밖에는 트리거 실행시간을 쓰지 않는다.
// 업무일이 05:30~다음날 01:00 이라 자정을 넘는 창이다(from > to 이면 넘김으로 해석).
var WATCH_HOURS = { from: 5, to: 1 };

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

// 최근 글 + 최근 스레드 댓글까지 반영한 채널 지문.
// conversations.history 는 스레드 댓글이 달려도 새 항목을 만들지 않으므로,
// 부모 글의 latest_reply 까지 지문에 넣어야 '댓글로 들어온 요청'도 감지된다.
// 카테고리가 이모지로 갈리므로 reactions(이름·개수)도 넣는다 — 빠지면 기존 글에 이모지만
// 찍힌 변경은 감지 못 해 외부 15분 크론까지 밀린다. 이모지는 한참 전 글에도 찍히니 50개를 본다.
// 스크립트 속성 값은 9KB 제한이라 지문은 MD5 로 줄여 저장한다.
function channelSignature_(chId, token) {
  var url = 'https://slack.com/api/conversations.history?channel=' + chId + '&limit=50';
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  var j = JSON.parse(res.getContentText());
  if (!j.ok) { throw new Error('slack: ' + j.error); }
  var msgs = j.messages || [];
  var parts = [];
  for (var i = 0; i < msgs.length; i++) {
    var rx = msgs[i].reactions || [];
    var r = [];
    for (var k = 0; k < rx.length; k++) { r.push(rx[k].name + '*' + rx[k].count); }
    parts.push(msgs[i].ts + ':' + (msgs[i].latest_reply || '') + ':' + r.join('+'));
  }
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, parts.join(','), Utilities.Charset.UTF_8));
}

function watchSlackAndDispatch() {
  var props = PropertiesService.getScriptProperties();
  var hour = parseInt(Utilities.formatDate(new Date(), 'Asia/Seoul', 'H'), 10);
  var active = (WATCH_HOURS.from < WATCH_HOURS.to)
    ? (hour >= WATCH_HOURS.from && hour < WATCH_HOURS.to)
    : (hour >= WATCH_HOURS.from || hour < WATCH_HOURS.to);   // 자정을 넘는 창
  if (!active) { return; }   // 업무시간 밖

  var token = prop_('SLACK_BOT_TOKEN');
  if (!token) { console.log('SLACK_BOT_TOKEN 스크립트 속성이 없습니다.'); return; }

  var changed = [];
  for (var i = 0; i < WATCH_CHANNELS.length; i++) {
    var ch = WATCH_CHANNELS[i];
    var key = 'WATCH_SIG_' + ch.id;
    try {
      var sig = channelSignature_(ch.id, token);
      var prev = props.getProperty(key);
      props.setProperty(key, sig);
      if (prev === null) { continue; }            // 최초 실행 — 기준값만 잡고 넘어감
      if (prev !== sig) { changed.push(ch.name); }
    } catch (e) {
      console.log('채널 확인 실패(' + ch.name + '): ' + e);   // 한 채널이 죽어도 나머지는 계속
    }
  }
  if (!changed.length) { return; }

  // 실행이 겹쳐 몰리는 것 방지. 워크플로 쪽 concurrency 로도 직렬화되지만 여기서 한 번 더 거른다.
  var last = parseInt(props.getProperty('WATCH_LAST_DISPATCH') || '0', 10);
  if (Date.now() - last < 55000) { console.log('직전 실행과 너무 가까움 — 건너뜀'); return; }

  if (dispatchGithub_(changed)) {
    props.setProperty('WATCH_LAST_DISPATCH', String(Date.now()));
  }
}

function dispatchGithub_(reasons) {
  var tok = prop_('GITHUB_TOKEN');
  if (!tok) { console.log('GITHUB_TOKEN 스크립트 속성이 없습니다.'); return false; }
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + GH_REPO + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + tok,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ event_type: GH_EVENT, client_payload: { reason: reasons.join(',') } }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 204) { console.log('워크플로 실행 요청 성공 — ' + reasons.join(',')); return true; }
  console.log('워크플로 실행 요청 실패 ' + code + ': ' + res.getContentText().slice(0, 200));
  return false;
}

// --- 편집기에서 직접 실행하는 도우미들 ---

// 1분 트리거 설치(중복 방지를 위해 기존 것 제거 후 재설치)
function installSlackWatchTrigger() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'watchSlackAndDispatch') { ScriptApp.deleteTrigger(ts[i]); }
  }
  ScriptApp.newTrigger('watchSlackAndDispatch').timeBased().everyMinutes(1).create();
  console.log('1분 트리거를 설치했습니다.');
}

function removeSlackWatchTrigger() {
  var ts = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'watchSlackAndDispatch') { ScriptApp.deleteTrigger(ts[i]); n++; }
  }
  console.log('트리거 ' + n + '개를 제거했습니다.');
}

// 설정이 맞는지 점검 — 실제 dispatch 는 하지 않고 상태만 찍는다
function testSlackWatch() {
  var token = prop_('SLACK_BOT_TOKEN');
  console.log('SLACK_BOT_TOKEN: ' + (token ? '있음' : '없음 ❌'));
  console.log('GITHUB_TOKEN: ' + (prop_('GITHUB_TOKEN') ? '있음' : '없음 ❌'));
  if (!token) { return; }
  for (var i = 0; i < WATCH_CHANNELS.length; i++) {
    var ch = WATCH_CHANNELS[i];
    try {
      var sig = channelSignature_(ch.id, token);
      var prev = PropertiesService.getScriptProperties().getProperty('WATCH_SIG_' + ch.id);
      console.log(ch.name + ': 읽기 성공 · 최근글 ' + sig.split(',').length + '건 · 저장된 기준값 ' + (prev === null ? '없음(다음 실행에서 생성)' : '있음'));
    } catch (e) {
      console.log(ch.name + ': 읽기 실패 ❌ ' + e + '  (봇이 채널에 초대돼 있는지 확인)');
    }
  }
}

/* =========================================================================
 * 원격 예약 (booking.html)
 *
 * 왜 필요한가: 원격 요청을 각자 슬랙에 바로 올리다 보니 같은 시각에 우르르 몰려
 * 처리 인원이 병목된다. 예약 페이지에서 15분 칸마다 정원을 두고, 예약된 요청은
 * chat.scheduleMessage 로 '그 시각에' 슬랙 양식 그대로 올라가게 한다.
 *
 * 데이터: 스토어 스프레드시트의 'booking' 시트(한 행 = 예약 한 건). 공유 블롭과 분리한다 —
 *   블롭은 50KB 에 가까워 여러 행으로 쪼개 저장 중이고, 예약은 계속 쌓이는 데이터라서.
 * 공개 범위: 페이지·저장소가 public 이라 목록 조회(GET)는 유형·시각·상호·요청자만 돌려준다.
 *   전화번호·주소는 슬랙 메시지와 시트에만 남는다.
 * 취소: 예약 시 발급한 취소코드가 있어야 한다(예약한 브라우저의 localStorage 에 저장됨).
 *
 * 필요한 스크립트 속성: SLACK_BOT_TOKEN (chat:write 권한 + 대상 채널에 봇 초대)
 * 동작 확인: 편집기에서 testBooking() 실행 → 실행 로그 확인
 * ========================================================================= */

var BOOKING = {
  days: 14,                    // 오늘부터 며칠 앞까지 예약을 받을지
  open: '09:00',               // 첫 칸 시작
  close: '18:00',              // 마지막 칸은 close - step (17:45)
  step: 15,                    // 칸 단위(분)
  closedDays: [],              // 예약 안 받는 요일 (0=일 … 6=토). 예: [0, 6]
  lunch: { from: '12:00', to: '14:00' },   // 이 시간대는 lunchCap 적용 (to 는 미포함)
  minLeadMin: 2,               // 시작 몇 분 전까지 예약 가능
  types: {
    as:       { label: '원격AS',   channel: 'C09HRUSG4TX', cap: 4, lunchCap: 2 },   // #0_원격_as_요청
    transfer: { label: '명의변경', channel: 'C09HRUSG4TX', cap: 2, lunchCap: 1 }
  }
};
var BOOKING_SHEET = 'booking';
var BOOKING_COLS = ['id', 'code', 'date', 'time', 'type', 'postAt', 'channel', 'scheduledId', 'status',
  'createdAt', 'requester', 'store', 'van', 'onoff', 'contract', 'biz', 'owner', 'ownerPhone',
  'storePhone', 'addr', 'content', 'cancelledAt'];

function hm_(s) { var a = String(s).split(':'); return parseInt(a[0], 10) * 60 + parseInt(a[1], 10); }
function pad2_(n) { return ('0' + n).slice(-2); }
// KST 기준 날짜+시각 → epoch ms. 서버 시간대와 무관하게 계산한다.
function kstMs_(date, time) {
  var d = String(date).split('-');
  return Date.UTC(+d[0], +d[1] - 1, +d[2], 0, hm_(time)) - 9 * 3600000;
}
function kstToday_() {
  var t = new Date(Date.now() + 9 * 3600000);
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}
function addDays_(date, n) {
  var d = String(date).split('-');
  var t = new Date(Date.UTC(+d[0], +d[1] - 1, +d[2] + n));
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}
function dow_(date) { var d = String(date).split('-'); return new Date(Date.UTC(+d[0], +d[1] - 1, +d[2])).getUTCDay(); }

function capOf_(type, time) {
  var t = BOOKING.types[type];
  var m = hm_(time);
  return (m >= hm_(BOOKING.lunch.from) && m < hm_(BOOKING.lunch.to)) ? t.lunchCap : t.cap;
}

function bookingSheet_() {
  var ss = store_().getParent();
  var sh = ss.getSheetByName(BOOKING_SHEET);
  if (!sh) {
    sh = ss.insertSheet(BOOKING_SHEET);
    // 사업자번호·시각이 숫자/날짜로 바뀌어 앞자리 0 이 사라지지 않게 전부 텍스트로
    sh.getRange(1, 1, sh.getMaxRows(), BOOKING_COLS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, BOOKING_COLS.length).setValues([BOOKING_COLS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readBookings_() {
  var sh = bookingSheet_();
  var last = sh.getLastRow();
  if (last < 2) { return []; }
  var vals = sh.getRange(2, 1, last - 1, BOOKING_COLS.length).getDisplayValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = { _row: i + 2 };
    for (var c = 0; c < BOOKING_COLS.length; c++) { r[BOOKING_COLS[c]] = vals[i][c]; }
    out.push(r);
  }
  return out;
}

function publicCfg_() {
  var types = {};
  for (var k in BOOKING.types) {
    var t = BOOKING.types[k];
    types[k] = { label: t.label, cap: t.cap, lunchCap: t.lunchCap };
  }
  return { days: BOOKING.days, open: BOOKING.open, close: BOOKING.close, step: BOOKING.step,
    closedDays: BOOKING.closedDays, lunch: BOOKING.lunch, minLeadMin: BOOKING.minLeadMin, types: types };
}

function listBookings_(p) {
  var from = p.from || kstToday_();
  var to = p.to || addDays_(kstToday_(), BOOKING.days - 1);
  var rows = readBookings_();
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.status === 'cancelled' || r.date < from || r.date > to) { continue; }
    list.push({ id: r.id, date: r.date, time: r.time, type: r.type, store: r.store, requester: r.requester });
  }
  return { ok: true, now: Date.now(), today: kstToday_(), cfg: publicCfg_(), bookings: list };
}

// 한 줄 입력칸: 줄바꿈 제거 + 길이 제한. 시트·목록에는 원문 그대로 두고,
// 슬랙 제어문자(& < >)는 메시지를 만들 때만 이스케이프한다(멘션·링크로 오해되지 않게).
function slackEsc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function line_(v, max) { return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 200); }

// 슬랙 원격요청 양식 그대로. 첫 줄의 [예약] 태그는 booking-report.js·fetch-and-tally.js 가 예약건으로 인식하는 표시이고,
// 봇이 올린 글이라 작성자 대신 '요청자:' 줄로 사람을 가린다(미설치건 집계가 이 줄을 본다).
function bookingText_(b) {
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  var d = b.date.split('-');
  var head = '[예약] ' + (+d[1]) + '/' + (+d[2]) + '(' + DOW[dow_(b.date)] + ') ' + b.time + ' · ' + BOOKING.types[b.type].label;
  return head + '\n' + slackEsc_([
    '상호: ' + b.store + (b.van ? ' / ' + b.van : ''),
    '오프/온라인: ' + b.onoff + (b.contract ? ' / ' + b.contract : ''),
    '사업자번호 : ' + b.biz,
    '대표자명 : ' + b.owner,
    '대표자 전화번호 : ' + b.ownerPhone,
    '가게 연락처 : ' + b.storePhone,
    '주소 : ' + b.addr,
    '내용: ' + b.content,
    '요청자: ' + b.requester
  ].join('\n'));
}

function slackApi_(method, payload) {
  var token = prop_('SLACK_BOT_TOKEN');
  if (!token) { return { ok: false, error: 'no_slack_token' }; }
  var res = UrlFetchApp.fetch('https://slack.com/api/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  try { return JSON.parse(res.getContentText()); }
  catch (e) { return { ok: false, error: 'slack_http_' + res.getResponseCode() }; }
}

function createBooking_(body) {
  var b = body.booking || {};
  var type = String(b.type || '');
  if (!BOOKING.types[type]) { return { ok: false, error: 'bad_type' }; }
  var date = String(b.date || ''), time = String(b.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) { return { ok: false, error: 'bad_slot' }; }

  // 칸 검증: 운영 시간 안, 15분 격자, 예약 가능 기간, 휴무 요일, 시작 임박 아님
  var m = hm_(time);
  if (m < hm_(BOOKING.open) || m + BOOKING.step > hm_(BOOKING.close) || (m - hm_(BOOKING.open)) % BOOKING.step) {
    return { ok: false, error: 'bad_slot' };
  }
  var today = kstToday_();
  if (date < today || date > addDays_(today, BOOKING.days - 1)) { return { ok: false, error: 'out_of_range' }; }
  if (BOOKING.closedDays.indexOf(dow_(date)) >= 0) { return { ok: false, error: 'closed_day' }; }
  var postAt = kstMs_(date, time);
  if (postAt < Date.now() + BOOKING.minLeadMin * 60000) { return { ok: false, error: 'too_late' }; }

  var rec = {
    type: type, date: date, time: time,
    requester: line_(b.requester, 20), store: line_(b.store, 60), van: line_(b.van, 30),
    onoff: line_(b.onoff, 10), contract: line_(b.contract, 20),
    biz: String(b.biz || '').replace(/\D/g, ''), owner: line_(b.owner, 20),
    ownerPhone: line_(b.ownerPhone, 20), storePhone: line_(b.storePhone, 20), addr: line_(b.addr, 150),
    content: String(b.content || '').trim().slice(0, 1000)
  };
  if (!rec.requester || !rec.store || !rec.owner || !rec.ownerPhone) { return { ok: false, error: 'missing_field' }; }
  if (rec.biz.length !== 10) { return { ok: false, error: 'bad_biz' }; }

  // 정원 확인 — doPost 가 스크립트 락을 잡은 상태라 이 확인과 아래 저장 사이에 다른 예약이 끼어들지 못한다
  var rows = readBookings_();
  var used = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.status !== 'cancelled' && r.date === date && r.time === time && r.type === type) { used++; }
  }
  var cap = capOf_(type, time);
  if (used >= cap) { return { ok: false, error: 'full', used: used, cap: cap }; }

  var channel = BOOKING.types[type].channel;
  var sres = slackApi_('chat.scheduleMessage', { channel: channel, post_at: Math.floor(postAt / 1000), text: bookingText_(rec) });
  if (!sres.ok) { return { ok: false, error: 'slack_' + sres.error }; }

  var id = Utilities.getUuid().slice(0, 8);
  var code = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  rec.id = id; rec.code = code; rec.postAt = String(postAt); rec.channel = channel;
  rec.scheduledId = sres.scheduled_message_id; rec.status = 'scheduled';
  rec.createdAt = new Date().toISOString(); rec.cancelledAt = '';
  var row = [];
  for (var c = 0; c < BOOKING_COLS.length; c++) { row.push(rec[BOOKING_COLS[c]] == null ? '' : String(rec[BOOKING_COLS[c]])); }
  bookingSheet_().appendRow(row);
  return { ok: true, id: id, code: code, date: date, time: time, type: type, store: rec.store };
}

function cancelBooking_(body) {
  var rows = readBookings_();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.id !== String(body.id || '')) { continue; }
    if (r.code !== String(body.code || '')) { return { ok: false, error: 'bad_code' }; }
    if (r.status === 'cancelled') { return { ok: true, already: true }; }
    // 슬랙은 게시 직전(약 1분 안) 예약 메시지 삭제를 거부한다
    if (+r.postAt <= Date.now() + 60000) { return { ok: false, error: 'already_posted' }; }
    var sres = slackApi_('chat.deleteScheduledMessage', { channel: r.channel, scheduled_message_id: r.scheduledId });
    // 슬랙에서 이미 사라진 예약(invalid_scheduled_message_id)은 시트만 정리하면 된다
    if (!sres.ok && sres.error !== 'invalid_scheduled_message_id') { return { ok: false, error: 'slack_' + sres.error }; }
    var sh = bookingSheet_();
    sh.getRange(r._row, BOOKING_COLS.indexOf('status') + 1).setValue('cancelled');
    sh.getRange(r._row, BOOKING_COLS.indexOf('cancelledAt') + 1).setValue(new Date().toISOString());
    return { ok: true };
  }
  return { ok: false, error: 'not_found' };
}

// 편집기에서 실행: 토큰·권한·채널 초대 상태를 확인한다. 1시간 뒤로 테스트 예약을 걸었다가 바로 지우므로 채널엔 아무것도 안 올라간다.
function testBooking() {
  var token = prop_('SLACK_BOT_TOKEN');
  console.log('SLACK_BOT_TOKEN: ' + (token ? '있음' : '없음 ❌'));
  if (!token) { return; }
  var seen = {};
  for (var k in BOOKING.types) {
    var ch = BOOKING.types[k].channel;
    if (seen[ch]) { continue; }
    seen[ch] = true;
    var r = slackApi_('chat.scheduleMessage', { channel: ch, post_at: Math.floor(Date.now() / 1000) + 3600, text: '[예약 테스트] 곧 자동 삭제됩니다' });
    if (!r.ok) { console.log(ch + ' ❌ ' + r.error + '  (missing_scope → 슬랙 앱에 chat:write 추가 / not_in_channel → 채널에 봇 초대)'); continue; }
    var d = slackApi_('chat.deleteScheduledMessage', { channel: ch, scheduled_message_id: r.scheduled_message_id });
    console.log(ch + ' ✅ 예약 가능 (테스트 예약 삭제: ' + (d.ok ? '완료' : d.error) + ')');
  }
  console.log('booking 시트: ' + bookingSheet_().getParent().getUrl());
}
