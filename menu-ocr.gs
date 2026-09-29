/*
 * 메뉴 이미지 즉시 판독 (원격파트 대시보드 메뉴등록 탭 → 「🖼 사진·PDF → 텍스트 변환」)
 *
 * 브라우저가 올린 메뉴 사진/PDF 한 장을 Claude 비전으로 읽어 {kind, items:[{category,name,price}]} 로 돌려준다.
 * 대시보드는 공개 사이트라 API 키를 브라우저에 둘 수 없다 — 키는 이 스크립트의 속성에만 둔다.
 * 판독 스키마·프롬프트는 scripts/fetch-menu-requests.js 의 자동 판독과 같다(결과 형식을 맞추기 위해).
 *
 * 설치 (1회)
 *   1) script.google.com → 새 프로젝트 → 이 파일 붙여넣기 → 저장
 *   2) ⚙ 프로젝트 설정 → 스크립트 속성 추가
 *        ANTHROPIC_API_KEY = sk-ant-...        (GitHub 시크릿과 같은 키)
 *        TEAM_CODE         = 팀 공용 암호        (대시보드에서 처음 한 번 입력)
 *        DAILY_CAP         = 300               (선택 · 하루 판독 상한, 비용 보호)
 *   3) 배포 → 새 배포 → 유형 '웹 앱' → 실행: 나 · 액세스: 모든 사용자 → 배포
 *   4) 나온 웹 앱 URL(…/exec)을 index.html 의 MENU_OCR_API 에 넣는다
 *   코드를 고친 뒤에는 배포 관리 → 수정 → 버전 '새 버전' 으로 다시 배포해야 반영된다.
 */

var MODEL = 'claude-opus-5';
var MAX_B64 = 6.5 * 1024 * 1024;        // base64 기준 ≈ 원본 4.8MB (API 이미지 상한 5MB)
var MEDIA = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;
var SCHEMA = {
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
          price: { type: 'integer', description: '가격. 콤마 없는 정수. 가격이 안 보이면 0.' }
        },
        required: ['category', 'name', 'price'],
        additionalProperties: false
      }
    }
  },
  required: ['kind', 'items'],
  additionalProperties: false
};
var PROMPT = [
  '이 이미지에서 등록 대상 메뉴(상품명과 가격)를 추출하세요.',
  '',
  '먼저 이미지 종류를 판별하세요:',
  '- menu_board : 매장 메뉴판(인쇄물·손글씨·POS 출력물 등) 사진',
  '- pos_screen : POS 프로그램 관리자 화면 캡처',
  '- product_photo : 배달앱 등록용 음식/상품 사진 (메뉴명·가격 목록이 아님)',
  '- other : 그 외',
  '',
  '추출 규칙:',
  '- product_photo 와 other 는 items 를 빈 배열로 두세요.',
  '- 메뉴명은 보이는 표기 그대로 적습니다. 맞춤법을 고치지 마세요.',
  '- 가격은 콤마를 빼고 정수로 적습니다. 가격이 안 보이면 0 으로 둡니다.',
  '- 분류(주류/식사류 등) 표기가 있으면 category 에 넣고, 없으면 빈 문자열로 둡니다.',
  '- 글자가 흐릿해 확신이 없으면 그 항목은 넣지 마세요. 추측해서 채우지 마세요.',
  '- 매장 전화번호·주소·사업자번호 같은 연락처 정보는 절대 넣지 마세요.'
].join('\n');

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var code = props.getProperty('TEAM_CODE');
    if (!code || body.code !== code) return json_({ ok: false, error: 'bad_code' });
    var key = props.getProperty('ANTHROPIC_API_KEY');
    if (!key) return json_({ ok: false, error: 'ANTHROPIC_API_KEY 스크립트 속성이 없습니다' });
    var mime = String(body.mime || '');
    var data = String(body.data || '');
    if (!MEDIA.test(mime)) return json_({ ok: false, error: '지원하지 않는 형식: ' + mime + ' (jpg·png·webp·gif·pdf)' });
    if (!data || data.length > MAX_B64) return json_({ ok: false, error: '파일이 너무 큽니다 (5MB 이하)' });
    if (!takeQuota_(props)) return json_({ ok: false, error: '오늘 판독 상한에 도달했습니다 — 내일 다시 시도하거나 DAILY_CAP 을 올려주세요' });
    return json_(readMenu_(key, mime, data));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err).slice(0, 300) });
  }
}

// 비용 보호 — 하루 판독 수를 센다(KST 날짜 기준)
function takeQuota_(props) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var day = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    var cap = Number(props.getProperty('DAILY_CAP') || 300);
    var k = 'used_' + day;
    var used = Number(props.getProperty(k) || 0);
    if (used >= cap) return false;
    props.setProperty(k, String(used + 1));
    return true;
  } finally { lock.releaseLock(); }
}

function readMenu_(key, mime, data) {
  var block = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mime, data: data } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: data } };
  var req = {
    model: MODEL,
    max_tokens: 16000,
    output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' },
    messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
    // 안전 분류기가 드물게 거절하면 서버가 다른 모델로 이어서 처리한다
    fallbacks: 'default'
  };
  var res = call_(key, req, true);
  // 폴백 파라미터를 못 받는 상태면(400) 그것만 빼고 한 번 더 보낸다
  if (res.status === 400 && /fallback/i.test(res.text)) { delete req.fallbacks; res = call_(key, req, false); }
  if (res.status !== 200) {
    var msg = res.text;
    try { msg = JSON.parse(res.text).error.message; } catch (x) {}
    return { ok: false, error: 'Claude API ' + res.status + ': ' + String(msg).slice(0, 200) };
  }
  var j = JSON.parse(res.text);
  if (j.stop_reason === 'refusal') return { ok: true, kind: 'other', items: [] };
  var text = '';
  (j.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  var parsed = JSON.parse(text || '{}');
  var items = (parsed.items || []).filter(function (x) { return x && x.name; }).slice(0, 300).map(function (x) {
    return { category: String(x.category || '').slice(0, 30), name: String(x.name).slice(0, 60), price: Number(x.price) || 0 };
  });
  return { ok: true, kind: parsed.kind || 'other', items: items };
}

function call_(key, req, withFallback) {
  var headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (withFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify(req), muteHttpExceptions: true
  });
  return { status: r.getResponseCode(), text: r.getContentText() };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
