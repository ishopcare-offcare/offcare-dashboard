/*
 * ============================================================
 *  고객사 원장의 '조치 내용' 작성기  (tally-compose.js 가 부른다)
 * ============================================================
 *  slack-data.js 의 note 는 처리 담당자의 슬랙 스레드 댓글을 그대로 이어 붙인 것이라
 *    · 댓글이 없는 건은 비어 있고(컴포즈 70건 중 30건, 2026-11-18)
 *    · "님 토플확인은 혹시 뭐때매 찍어주셧을까요.." 같은 내부 대화가 고객사 화면에 그대로 나간다.
 *  → 요청 내용 + 스레드 댓글을 Claude 에 넘겨 고객사 보고용 한두 문장('조치 내용')으로 바꾼다.
 *
 *  ── 비용·속도 ──────────────────────────────────────────────
 *  한 번 만든 문장은 franchise/data/<slug>-act.json 에 저장해 두고,
 *  요청·댓글·상태가 바뀐 건(지문 h 가 달라진 건)만 다시 만든다 → 평소 실행은 API 호출 0~수 건.
 *  실행당 상한 ACT_CAP(기본 80) — 넘치는 건은 다음 실행에서 이어서 만든다.
 *
 *  ── API 를 못 쓸 때 ─────────────────────────────────────────
 *  ANTHROPIC_API_KEY 가 없거나 호출이 실패하면 예전에 만든 문장을 그대로 쓰고,
 *  그것도 없으면 '원격 지원 처리 완료' / '처리 진행 중' 으로 둔다.
 *  내부 대화 원문(note)은 어떤 경우에도 고객사 화면으로 내보내지 않는다.
 * ============================================================
 */
const fs = require('fs');
const crypto = require('crypto');

const MODEL = 'claude-opus-5-5';
const ACT_CAP = parseInt(process.env.ACT_CAP || '80', 10);
const CONCURRENCY = 4;

const CAT_KO = { as: '원격 A/S', onboarding: '온보딩', transfer: '명의변경', menu: '메뉴등록' };

const SYSTEM = `당신은 포스·키오스크 원격 지원팀이 프랜차이즈 본사에 내는 월간 보고서의 '조치 내용' 칸을 씁니다.
한 건의 요청 내용과 담당자들의 내부 슬랙 댓글을 받아, 본사 담당자가 읽을 조치 내용을 한국어로 한두 문장(최대 80자) 씁니다.

규칙:
- 입력에 있는 사실만 씁니다. 댓글에 없는 원인·조치·결과를 지어내지 마세요.
- 댓글에 구체적인 조치가 있으면 그것을 요약합니다. 예: "키오스크 강제 종료 후 재부팅, 정상 동작 확인"
- 댓글이 없거나 조치가 드러나지 않으면 요청 내용을 바탕으로 일반적으로 씁니다. 예: "키오스크 할인 설정 관련 원격 지원 완료"
- 상태가 '진행 중'이면 끝났다고 쓰지 말고 "○○ 확인 중" 처럼 씁니다.
- 직원 이름·호칭(○○님), 내부 대화투, 다른 팀·업체 간 책임 논의, 전화번호·사업자번호·주소는 넣지 않습니다.
- 다른 채널·부서로 넘긴 경우는 "담당 부서로 이관" 정도로만 씁니다.
- 문장 끝은 "~ 완료", "~ 안내", "~ 확인" 같은 보고서 명사형으로 끝냅니다. 따옴표·머리말 없이 조치 내용만 출력하세요.`;

function fingerprint(r, rawNote){
  return crypto.createHash('md5').update([r.cat, r.status, r.req, rawNote].join('\u0001')).digest('hex').slice(0, 12);
}
function keyOf(r){ return [r.date, r.time, r.store, r.cat].join('|'); }
function fallback(r){ return r.status === 'done' ? '원격 지원 처리 완료' : '처리 진행 중'; }

let _client;
function client(){
  if(_client !== undefined) return _client;
  if(!process.env.ANTHROPIC_API_KEY){ console.log('조치 내용: ANTHROPIC_API_KEY 없음 — 저장된 문장만 사용'); return (_client = null); }
  try { const Anthropic = require('@anthropic-ai/sdk'); _client = new Anthropic(); }
  catch(e){ console.log('조치 내용: SDK 없음 — 저장된 문장만 사용 (' + e.message + ')'); _client = null; }
  return _client;
}

async function writeOne(c, r, rawNote){
  const input = [
    '구분: ' + (CAT_KO[r.cat] || r.cat),
    '상태: ' + (r.status === 'done' ? '처리 완료' : '진행 중'),
    '요청 내용: ' + (r.req || '(없음)'),
    '담당자 댓글: ' + (rawNote || '(없음)'),
  ].join('\n');
  const res = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',                 // 안전 분류기가 거절하면 서버가 다른 모델로 다시 돌린다
    output_config: { effort: 'low' },     // 짧은 요약 — 깊은 추론 불필요
    system: SYSTEM,
    messages: [{ role: 'user', content: input }],
  });
  if(res.stop_reason === 'refusal') return null;
  const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ')
    .replace(/\s+/g, ' ').replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').trim();
  return text ? text.slice(0, 120) : null;
}

/* records 의 note(원문 댓글)를 조치 내용으로 바꿔 넣는다. maskText 는 호출한 쪽에서 다시 씌운다 */
async function fillActs(records, cacheFile){
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch(e) {}
  const todo = [];
  for(const r of records){
    const raw = r.note || '';
    const k = keyOf(r), h = fingerprint(r, raw), hit = cache[k];
    if(hit && hit.h === h){ r.note = hit.act; continue; }
    todo.push({ r, raw, k, h, prev: hit && hit.act });
  }
  const c = todo.length ? client() : null;
  let made = 0, failed = 0;
  const queue = c ? todo.slice(0, ACT_CAP) : [];
  const worker = async () => {
    for(let t; (t = queue.shift()); ){
      try {
        const act = await writeOne(c, t.r, t.raw);
        if(act){ cache[t.k] = { h: t.h, act }; t.done = act; made++; } else failed++;
      } catch(e){ failed++; if(failed <= 3) console.log('조치 내용 작성 실패:', String(e && e.message || e).slice(0, 120)); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for(const t of todo) t.r.note = t.done || t.prev || fallback(t.r);

  // 원장에서 사라진 건은 캐시에서도 지운다
  const live = new Set(records.map(keyOf));
  for(const k of Object.keys(cache)) if(!live.has(k)) delete cache[k];
  const sorted = {}; Object.keys(cache).sort().forEach(k => sorted[k] = cache[k]);
  const next = JSON.stringify(sorted, null, 1) + '\n';
  const prevTxt = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8').split('\r').join('') : '';
  if(prevTxt !== next) fs.writeFileSync(cacheFile, next, 'utf8');
  if(todo.length) console.log(`조치 내용  새로 ${made}건 · 실패 ${failed}건 · 대기 ${Math.max(0, todo.length - ACT_CAP)}건 (전체 ${records.length}건)`);
}

module.exports = { fillActs };
