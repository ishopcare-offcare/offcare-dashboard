/*
 * 메뉴 메일 첨부 → Drive 복사 (원격파트 대시보드 메뉴등록 탭용)
 *
 * rm@ishopcare.co.kr 로 들어온 메일의 첨부파일을 내 Drive 의 전용 폴더로 복사하고,
 * 어떤 메일에 어떤 파일이 있었는지 menu-mail-index.json 에 적는다.
 * scripts/fetch-menu-requests.js 가 슬랙 '📬 새 메일 도착' 글을 보낸 사람·제목으로 이 목록과
 * 맞춰, 첨부를 판독해 대시보드에 올린다.
 *
 * 왜 여기서 도나: 메일 첨부는 슬랙 알림에 실려 오지 않는다(본문 앞부분·링크뿐).
 * Gmail 읽기 권한을 GitHub 로 꺼내면 개인 메일함 전체가 열리므로, 메일은 구글 안에서만 읽고
 * 밖으로는 '복사해 둔 첨부'만 기존 Drive 읽기 권한으로 보게 한다.
 *
 * 설치 (1회)
 *   1) script.google.com → 새 프로젝트 → 이 파일 내용 붙여넣기 → 저장
 *   2) 왼쪽 [서비스 +] → "Drive API" 추가 (엑셀 → 시트 변환에 필요)
 *   3) 함수 선택에서 setup → 실행 → 권한 허용
 *      (Gmail 읽기 · Drive 파일 만들기 권한을 묻는다. 내 계정 안에서만 쓰인다)
 *   이후 10분마다 run() 이 자동 실행된다. 끄려면 [트리거] 메뉴에서 삭제.
 */

var CFG = {
  // rm@ 은 그룹 메일이라 내 메일함에는 To/Cc/Delivered-To/List 중 하나로 남는다
  QUERY: '(to:rm@ishopcare.co.kr OR cc:rm@ishopcare.co.kr OR deliveredto:rm@ishopcare.co.kr OR list:rm@ishopcare.co.kr) newer_than:3d',
  FOLDER: '원격-메뉴메일첨부',
  INDEX: 'menu-mail-index.json',
  KEEP_DAYS: 30,                     // 목록·파일 보관 기간 (메뉴요청 적재 창과 같다)
  MIN_INLINE: 15 * 1024,             // 이보다 작은 본문 삽입 이미지는 서명·로고로 보고 버린다
  MAX_BYTES: 25 * 1024 * 1024,
  MAX_THREADS: 50
};
var SHEET_EXT = /\.(xlsx|xlsm|xls)$/i;
// 첨부가 메일 밖(대용량 링크)에 있는 경우 — 자동으로 못 받으니 개수만 알린다
var BIG_LINK = /https?:\/\/[^\s<>"]*(bigmail|bigfile|largefile|mass|대용량|download\.)[^\s<>"]*/ig;

function setup() {
  folder_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(10).create();
  run();
}

function run() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;               // 이전 실행이 아직 도는 중
  try {
    var folder = folder_();
    var idx = readIndex_(folder);
    var seen = {};
    idx.items.forEach(function (e) { seen[e.mid] = true; });
    var added = 0;
    GmailApp.search(CFG.QUERY, 0, CFG.MAX_THREADS).forEach(function (th) {
      th.getMessages().forEach(function (msg) {
        var mid = msg.getId();
        if (seen[mid]) return;
        if (/@ishopcare\.co\.kr/i.test(msg.getFrom())) { seen[mid] = true; return; }   // 우리 쪽 답장은 제외
        idx.items.push(saveMessage_(msg, folder));
        seen[mid] = true;
        added++;
      });
    });
    var cut = Date.now() - CFG.KEEP_DAYS * 86400000;
    var keep = [];
    idx.items.forEach(function (e) {
      if (new Date(e.date).getTime() >= cut) { keep.push(e); return; }
      (e.files || []).forEach(function (f) {
        [f.id, f.csv].forEach(function (id) { if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (x) {} } });
      });
    });
    var pruned = keep.length !== idx.items.length;
    idx.items = keep;
    if (added || pruned || !idx.file) writeIndex_(folder, idx);
  } finally {
    lock.releaseLock();
  }
}

function saveMessage_(msg, folder) {
  var mid = msg.getId();
  var from = msg.getFrom();
  var entry = {
    mid: mid,
    date: msg.getDate().toISOString(),
    from: from,
    fromEmail: ((from.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0]).toLowerCase(),
    subject: msg.getSubject() || '',
    files: [],
    big: 0
  };
  var atts = msg.getAttachments({ includeInlineImages: true, includeAttachments: true });
  atts.forEach(function (a, i) {
    var size = a.getSize();
    var type = String(a.getContentType() || '').toLowerCase();
    var name = a.getName() || ('첨부' + (i + 1));
    if (size > CFG.MAX_BYTES) return;
    if (/^image\//.test(type) && size < CFG.MIN_INLINE) return;
    var f = folder.createFile(a.copyBlob()).setName(mid + '-' + i + '-' + name);
    var rec = { id: f.getId(), name: name, type: type, size: size };
    if (SHEET_EXT.test(name)) rec.csv = sheetToCsv_(f, folder, mid + '-' + i);
    else if (/\.csv$/i.test(name) || type === 'text/csv') rec.csv = f.getId();
    entry.files.push(rec);
  });
  var body = '';
  try { body = msg.getPlainBody() || ''; } catch (x) {}
  entry.big = (body.match(BIG_LINK) || []).length;
  return entry;
}

// 엑셀 → 구글 시트로 변환해 시트마다 CSV 로 풀어 한 파일에 담는다. 실패하면 null(원본만 남는다).
function sheetToCsv_(file, folder, prefix) {
  var tmpId = null;
  try {
    var tmp = Drive.Files.create(
      { name: prefix + '-tmp', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder.getId()] },
      file.getBlob());
    tmpId = tmp.id;
    var out = [];
    SpreadsheetApp.openById(tmpId).getSheets().forEach(function (sh) {
      var vals = sh.getDataRange().getDisplayValues();
      if (!vals.length || (vals.length === 1 && !vals[0].join(''))) return;
      out.push('## 시트: ' + sh.getName());
      vals.forEach(function (row) {
        if (!row.join('').trim()) return;
        out.push(row.map(function (c) {
          c = String(c);
          return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
        }).join(','));
      });
    });
    return folder.createFile(prefix + '.csv', out.join('\n'), MimeType.CSV).getId();
  } catch (e) {
    console.log('엑셀 변환 실패: ' + file.getName() + ' — ' + e.message);
    return null;
  } finally {
    if (tmpId) { try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (x) {} }
  }
}

function folder_() {
  var it = DriveApp.getFoldersByName(CFG.FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CFG.FOLDER);
}

function readIndex_(folder) {
  var it = folder.getFilesByName(CFG.INDEX);
  if (!it.hasNext()) return { file: null, items: [] };
  var file = it.next();
  try { return { file: file, items: JSON.parse(file.getBlob().getDataAsString()).items || [] }; }
  catch (e) { return { file: file, items: [] }; }
}

function writeIndex_(folder, idx) {
  var text = JSON.stringify({ updatedAt: new Date().toISOString(), items: idx.items });
  if (idx.file) idx.file.setContent(text);
  else idx.file = folder.createFile(CFG.INDEX, text, 'application/json');
}
