/*
 * 공개 데이터 개인정보 가리기 — 전화번호 뒤 4자리 · 주소는 구/동까지 (2026-10-20 결정)
 *  사업자번호는 2026-10-26 결정으로 다시 전부 싣는다(가리지 않음). maskBiz 는 숫자만 남기는 정리만 한다.
 *
 *  이 저장소는 GitHub Pages 로 누구나 볼 수 있다. 대시보드에 싣는 파일은
 *  전부 여기를 거쳐서 쓴다.
 *
 *   maskBiz('233-88-00379')      → '2338800379'   (가리지 않음 — 숫자만)
 *   maskAddr('서울 강남구 테헤란로 1 (역삼동)') → '서울 강남구 역삼동'
 *   maskText(자유 텍스트)          → 전화번호(010-1234-****) · 상세 주소를 가림 (사업자번호는 그대로)
 *   maskDeep(객체)                → biz·addr 칸은 위 규칙, 나머지 문자열은 maskText
 *
 *  ⚠️ 2026-10-20~26 사이 쌓인 데이터·클라우드 키에는 가린 번호(앞 5자리 + *****)가 남아 있을 수 있다.
 *     복원: scripts/unmask-biz.js (git 기록의 원본으로 되살림).
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
  return d;                                     // 2026-10-26 부터 가리지 않는다(이미 가려진 값은 그대로 둠)
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

const RE_PHONE = /(?<![\dA-Za-z_.*])(0(?:1[016789]|2|[3-6][1-5]|70|50\d)[-.\s]?\d{3,4}[-.\s]?)\d{4}(?![\d*])/g;

function maskText(v){
  if(typeof v !== 'string' || !v) return v;
  let s = v;
  // 전화번호 — 휴대폰(010…)·지역번호·070·050x. 마지막 4자리를 가린다 (010-1234-****).
  // 사업자번호는 0으로 시작하지 않으므로(앞 3자리 = 세무서 코드) 0 으로 시작하는 숫자는 전화로 본다.
  s = s.replace(RE_PHONE, (m, head) => head + '****');
  // 사업자번호(라벨·000-00-00000·검증번호 맞는 10자리)는 2026-10-26 부터 가리지 않는다.
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

/* 'YYYY-MM-DD|HH:MM|사업자번호' 꼴 키의 마지막 칸 — maskBiz 가 가리지 않으므로 이제 숫자 정리만 */
const maskKeyTail = k => { const i = k.lastIndexOf('|'); return i < 0 ? k : k.slice(0, i + 1) + maskBiz(k.slice(i + 1)); };

/* 가린 모양(앞 5자리 + *****)으로 바꾼다 — 2026-10-20~26 에 가린 키로 저장된 값을 찾을 때만 쓴다 */
const starBiz = v => { const d = String(v == null ? '' : v).replace(/[^\d*]/g, ''); return d.length === 10 && d.indexOf('*') < 0 ? d.slice(0, 5) + '*****' : d; };

module.exports = { maskBiz, maskAddr, maskText, maskDeep, maskDigits, maskKeyTail, bizChecksumOk, starBiz };
