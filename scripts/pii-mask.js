/*
 * 공개 데이터 개인정보 가리기 — 사업자번호 뒤 5자리 · 주소는 구/동까지 (2026-10-20 결정)
 *
 *  이 저장소는 GitHub Pages 로 누구나 볼 수 있다. 대시보드에 싣는 파일은
 *  전부 여기를 거쳐서 쓴다.
 *
 *   maskBiz('2338800379')        → '23388*****'
 *   maskAddr('서울 강남구 테헤란로 1 (역삼동)') → '서울 강남구 역삼동'
 *   maskText(자유 텍스트)          → 라벨 붙은 사업자번호 · 000-00-00000 · 상세 주소를 가림
 *   maskDeep(객체)                → biz·addr 칸은 위 규칙, 나머지 문자열은 maskText
 *
 *  ⚠️ 가린 사업자번호(앞 5자리)는 여러 매장이 겹칠 수 있다 — 세무서·업태 코드라서.
 *     사업자번호만으로 매장을 특정하는 로직은 시각·상호와 함께 써야 한다.
 *  같은 입력을 몇 번 넣어도 결과가 같다(이미 가린 값은 그대로).
 */
'use strict';

const STARS = n => '*'.repeat(Math.max(0, n));

/* 숫자 열 앞 5자리만 남긴다. 하이픈 등 구분자는 자리 그대로 둔다 (123-45-***** 처럼) */
function maskDigits(s){
  let seen = 0;
  return String(s).replace(/\d/g, d => (++seen <= 5 ? d : '*'));
}

/* 사업자등록번호 검증번호 — 실제 사업자번호 칸 3만여 건 중 99.96% 가 통과한다.
   임의의 10자리 숫자(TID·전화번호)는 10% 정도만 우연히 통과한다. */
function bizChecksumOk(d){
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let s = 0;
  for(let i = 0; i < 9; i++) s += +d[i] * w[i];
  s += Math.floor(+d[8] * 5 / 10);
  return (10 - s % 10) % 10 === +d[9];
}

function maskBiz(v){
  if(v == null) return v;
  const d = String(v).replace(/[^\d*]/g, '');
  if(!d) return '';
  if(d.indexOf('*') >= 0) return d;             // 이미 가림
  return d.length > 5 ? d.slice(0, 5) + STARS(d.length - 5) : d;
}

const SIDO = '(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|충청북|충청남|전라북|전라남|경상북|경상남|전남광주)[가-힣]*';
const RE_SIDO_TOKEN   = new RegExp('^' + SIDO + '$');
const RE_REGION_TOKEN = /^[가-힣]+(?:시|군|구)$/;
const RE_DONG_TOKEN   = /^[가-힣]+\d*(?:동|읍|면|가)$/;

/* 구조화된 주소 칸 — 시도·시군구 + (있으면) 동/읍/면까지만 */
function maskAddr(v){
  if(v == null) return v;
  const s = String(v).trim();
  if(!s) return s;
  const paren = (s.match(/\(([^)]*)\)/) || [])[1] || '';
  const parenDong = paren.split(/[,\s]+/).find(t => RE_DONG_TOKEN.test(t)) || '';
  const keep = [];
  let dong = '';
  for(const t of s.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean)){
    if(!keep.length && RE_SIDO_TOKEN.test(t)) { keep.push(t); continue; }
    if(RE_REGION_TOKEN.test(t)) { keep.push(t); continue; }
    if(RE_DONG_TOKEN.test(t))   { dong = t; break; }
    break;                                      // 도로명·번지·건물 — 여기부터 버린다
  }
  if(!dong) dong = parenDong;
  if(dong) keep.push(dong);
  return keep.join(' ');
}

/* ── 자유 텍스트 안의 상세 주소 ─────────────────────────────
   '시도? 시군구{1,3} 동? + 도로명 번호(또는 동 번지)' 를 찾아 시군구·동만 남기고,
   그 뒤에 붙은 건물명·층·호·(괄호) 도 함께 지운다. */
const RE_ADDR_HEAD = new RegExp(
  '((?:' + SIDO + '\\s+)?(?:[가-힣]+(?:시|군|구)\\s+){1,3})' +              // 1 시도·시군구
  '((?:[가-힣]+\\d*(?:동|읍|면|가)\\s+)?)' +                                // 2 동
  '([가-힣A-Za-z0-9]+(?:로|길)(?:\\s*\\d+(?:번)?길)?\\s*\\d+(?:-\\d+)?' +   // 3 도로명 + 번호
  '|\\d+(?:-\\d+)?(?:\\s*번지)?)(?![\\d가-힣])', 'g');                       //   또는 번지
const RE_ADDRISH = /^(?:지하|B\d+|#?\d+(?:-\d+)?(?:호|층|동|번지|F|f)?|[가-힣A-Za-z0-9#\-]*(?:빌딩|빌라|타워|아파트|상가|프라자|플라자|오피스텔|센터|맨션|하이츠|캐슬|스퀘어|타운|몰)(?:\d+(?:층|호|동))?)$/;

function maskAddrInText(s){
  let out = '', last = 0, m;
  RE_ADDR_HEAD.lastIndex = 0;
  while((m = RE_ADDR_HEAD.exec(s))){
    const [whole, region, dong, road] = m;
    if(!dong && /^\d/.test(road)) continue;     // 동 없이 번지만 — 주소라 보기 어렵다
    let pos = m.index + whole.length, parenDong = '';
    for(;;){                                    // 뒤에 붙은 (괄호)·건물명·층·호 까지
      const sp = s.slice(pos).match(/^[\s,]*/)[0];
      const at = pos + sp.length;
      if(s[at] === '('){
        const close = s.indexOf(')', at);
        if(close < 0 || close - at > 40) break;
        if(!parenDong) parenDong = s.slice(at + 1, close).split(/[,\s]+/).find(t => RE_DONG_TOKEN.test(t)) || '';
        pos = close + 1; continue;
      }
      const tok = (s.slice(at).match(/^[^\s,/|()]+/) || [''])[0];
      if(!tok || !RE_ADDRISH.test(tok.replace(/[.,]$/, ''))) break;
      pos = at + tok.length;
    }
    out += s.slice(last, m.index) + (region + (dong || (parenDong ? parenDong + ' ' : ''))).trimEnd();
    last = pos;
    RE_ADDR_HEAD.lastIndex = pos;
  }
  return last ? out + s.slice(last) : s;
}

function maskText(v){
  if(typeof v !== 'string' || !v) return v;
  let s = v;
  // 슬랙 전화 링크로 바뀐 숫자 <tel:1234567890|1234567890>
  s = s.replace(/<tel:([\d\-]{10,13})\|([\d\-]{10,13})>/g, (m, a, b) =>
    /^\d{3}-?\d{2}-?\d{5}$/.test(b) ? '<tel:' + maskDigits(a) + '|' + maskDigits(b) + '>' : m);
  // 라벨 붙은 사업자번호 (공백·하이픈 섞여도)
  s = s.replace(/(사업자\s*(?:등록)?\s*번?\s*호?\s*[:：]?\s*)(\d[\d\- ]{8,14}\d)/g, (m, lab, num) =>
    num.replace(/\D/g, '').length >= 10 ? lab + maskDigits(num) : m);
  // 000-00-00000 모양은 라벨이 없어도 사업자번호
  s = s.replace(/(?<!\d)(\d{3}-\d{2}-)(\d{5})(?!\d)/g, (m, a) => a + '*****');
  // 라벨 없이 숫자만 적은 것 — 검증번호(끝자리)가 맞는 10자리만. 슬랙 ts(소수점)·파일명(_)은 제외
  s = s.replace(/(?<![\d_.])\d{10}(?![\d_.])/g, d => (bizChecksumOk(d) ? maskDigits(d) : d));
  if(/[시군구]\s/.test(s)) s = maskAddrInText(s);
  return s;
}

/* 이 칸들은 식별자·링크라 건드리지 않는다 */
const SKIP = new Set(['ts', 'fid', 'id', 'link', 'path', 'drive', 'url', 'permalink', 'store', 'branch', 'brand', 'date', 'time']);

function maskDeep(o, key){
  if(typeof o === 'string'){
    if(key === 'biz')  return maskBiz(o);
    if(key === 'addr') return maskAddr(o);
    return SKIP.has(key) ? o : maskText(o);
  }
  if(typeof o === 'number' && key === 'biz') return maskBiz(String(o));
  if(Array.isArray(o)){ for(let i = 0; i < o.length; i++) o[i] = maskDeep(o[i], key); return o; }
  if(o && typeof o === 'object'){ for(const k of Object.keys(o)) o[k] = maskDeep(o[k], k); return o; }
  return o;
}

/* 'YYYY-MM-DD|HH:MM|사업자번호' 꼴 키의 마지막 칸 */
const maskKeyTail = k => { const i = k.lastIndexOf('|'); return i < 0 ? k : k.slice(0, i + 1) + maskBiz(k.slice(i + 1)); };

module.exports = { maskBiz, maskAddr, maskText, maskDeep, maskDigits, maskKeyTail };
