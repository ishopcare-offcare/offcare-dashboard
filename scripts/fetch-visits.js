#!/usr/bin/env node
/*
 * ============================================================
 *  방문설치 채널 → visit-data.js
 * ============================================================
 *  슬랙 #ishopcare_new_방문설치 의 워크플로우 글을 읽어 방문 건으로 적재한다.
 *  프랜차이즈 대시보드가 이 파일을 읽어 상호명으로 브랜드를 가르고
 *  각 브랜드의 '현장방문' 에 넣는다(브랜드 판별은 대시보드와 같은 모듈 사용).
 *
 *    node scripts/fetch-visits.js
 *    VISIT_FROM=2026-07-01 node scripts/fetch-visits.js    # 과거 재수집
 *
 *  ── slack-data.js 를 안 건드리는 이유 ────────────────────────
 *  원격파트 대시보드(index.html)가 같은 파일을 읽는다. 거기에 새 분류를
 *  끼워 넣으면 사내 집계 숫자가 흔들린다. 그래서 별도 파일로 뺀다.
 *
 *  ── 워크플로우 글 형식 ──────────────────────────────────────
 *    방문 설치 요청
 *    ID: 14041
 *    설치구분: 기타          ← 설치 / AS / 기타
 *    요청일시: 2026-09-02 18:54
 *    상호명: 컴포즈커피 수원인계점
 *    사업자번호: 1234567890
 *    방문일자: 2026-09-04
 *    ...
 *  스레드 댓글에 '설치 담당 배정 : -> 공명현', 'YYYY-MM-DD [N회차]' 가 붙는다.
 * ============================================================
 */
const fs   = require('fs');
const path = require('path');
const { maskBiz, maskText, maskDeep } = require('./pii-mask');   // 공개 데이터 — 사업자번호 뒤 5자리·상세주소 가림

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'visit-data.js');
const CHANNEL = process.env.VISIT_CHANNEL || 'C0B2XSJ08UA';   // ishopcare_new_방문설치

/* ── 파싱 (슬랙 없이도 단위 검증할 수 있게 순수 함수로 둔다) ── */

/* 멘션이 <@U072VD9H342> 처럼 이름 없이 오는 경우가 있다.
   users.list 로 만든 표를 여기에 꽂아 사람 이름으로 바꾼다(없으면 지운다 — 원시 ID는 노이즈). */
let USER_MAP = {};
function setUserMap(m){ USER_MAP = m || {}; }

/* 슬랙 마크업을 사람이 읽는 형태로 */
function unmark(s){
  return String(s == null ? '' : s)
    .replace(/<@[^>|]+\|([^>]+)>/g, '@$1')            // <@U1|홍길동> → @홍길동
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => USER_MAP[id] ? '@' + USER_MAP[id] : '')
    .replace(/<#[^>|]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, '$2')     // 링크는 라벨만
    .replace(/<(https?:[^>|]+)>/g, '$1')
    .replace(/[*`]/g, '')
    /* 슬랙은 본문의 & < > 를 실체참조로 보낸다. 슬랙 자신의 마크업(<@U..>)을
       먼저 처리한 뒤에 풀어야 한다. 안 풀면 '-> 김명석' 이 '-&gt; 김명석' 으로
       도착해 화살표 분리가 실패한다(담당자가 '&gt; 김명석' 으로 들어갔었다). */
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/* 메시지 본문 뽑기.
   슬랙 워크플로우 글은 본문이 text 가 아니라 blocks(rich_text/section) 나
   attachments 에 들어온다. 셋 다 훑어서 나오는 텍스트를 전부 잇는다. */
function extractText(m){
  const out = [];
  const walk = (n) => {
    if(n == null) return;
    if(typeof n === 'string'){ out.push(n); return; }
    if(Array.isArray(n)){ n.forEach(walk); return; }
    if(typeof n !== 'object') return;
    /* 텍스트를 담는 필드만 골라 내려간다 (user/ts 같은 값이 섞이지 않게) */
    if(typeof n.text === 'string') out.push(n.text);
    else if(n.text) walk(n.text);
    ['elements', 'fields', 'blocks', 'attachments'].forEach(k => walk(n[k]));
    if(typeof n.fallback === 'string') out.push(n.fallback);
    if(typeof n.pretext === 'string')  out.push(n.pretext);
    if(typeof n.title === 'string')    out.push(n.title);
    if(typeof n.value === 'string')    out.push(n.value);
  };
  walk({ text: m.text, blocks: m.blocks, attachments: m.attachments });
  /* 같은 문구가 text 와 blocks 에 중복으로 오는 경우가 흔하다 */
  return [...new Set(out.map(s => String(s).trim()).filter(Boolean))].join('\n');
}

/* '키: 값' 줄을 모아 객체로. 값 안의 콜론(18:54)이 깨지지 않도록 첫 콜론만 자른다 */
function parseFields(text){
  const out = {};
  for(const line of unmark(text).split('\n')){
    const m = line.match(/^\s*([^:\n]{1,24}?)\s*:\s*(.*)$/);
    if(!m) continue;
    const k = m[1].trim();
    if(!k) continue;
    if(out[k] === undefined) out[k] = m[2].trim();     // 같은 키가 또 나오면 첫 값 유지
  }
  return out;
}

const isBlank = v => !v || ['-', '없음', 'N/A', 'na'].includes(String(v).trim());
const ymd = v => { const m = String(v || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ''; };
const hm  = v => { const m = String(v || '').match(/(\d{1,2}):(\d{2})/);
                   return m ? String(+m[1]).padStart(2, '0') + ':' + m[2] : ''; };

/* 설치구분 정규화 — 워크플로우 선택지가 조금씩 달라도 셋 중 하나로 모은다 */
function normKind(v){
  /* 'A/S', 'a-s' 처럼 구분자가 끼어도 같게 보이도록 공백·기호를 먼저 턴다 */
  const s = String(v || '').replace(/[\s/._-]/g, '');
  if(!s) return '기타';
  if(/as/i.test(s) || s.includes('에이에스')) return 'AS';
  if(s.includes('설치') || s.includes('신규')) return '설치';
  return '기타';
}

/* 스레드 댓글에서 담당자·방문 회차를 건진다 */
function parseThread(replies){
  let assignee = '', rounds = 0, roundDates = [];
  for(const r of (replies || [])){
    /* 댓글도 blocks 로 오는 경우가 있어 본문 추출을 똑같이 거친다 */
    const t = unmark(extractText(r));
    /* '설치 담당 배정 : -> 공명현' · '담당배정: 공명현' 등 표기 흔들림을 함께 받는다 */
    const a = t.match(/(?:설치\s*)?담당\s*(?:자|배정)\s*(?:배정)?\s*[:：]?\s*([^\n]*)/);
    if(a){
      /* '이전 -> 새사람' 형태면 화살표 뒤가 최종 담당자 */
      const v = a[1].split(/->|→/).pop()
        .replace(/\s*by\s+.*$/i, '').replace(/^[\s:：-]+/, '').trim();
      if(v && v.length <= 20) assignee = v;
    }
    for(const m of t.matchAll(/(\d{4}-\d{2}-\d{2})\s*\[(\d+)\s*회차\]/g)){
      roundDates.push(m[1]);
      rounds = Math.max(rounds, +m[2]);
    }
  }
  return { assignee, rounds, roundDates };
}

/* 완료 신호 이모지.
   방문일자만으로 판단하면 예정일이 안 지난 건이 계속 '처리중' 으로 남는다.
   채널에서 완료 표시로 찍는 이모지가 있으면 날짜와 무관하게 완료로 본다.
   (원격<사람이름> 은 그 사람이 처리했다는 표시라 완료로 친다) */
const DONE_EMOJI = [
  '원격as', '원격온보딩', '원격명의변경', '원격메뉴등록', '원격배달',
  '완료', '처리완료', '설치완료', '방문완료',
  'white_check_mark', 'heavy_check_mark', 'ballot_box_with_check',
];
const DONE_EMP_RE = /^원격[가-힣]{2,4}$/;
function doneByEmoji(reactions){
  return (reactions || []).some(r => {
    const n = String(r && r.name || '').toLowerCase().replace(/::skin-tone-\d/, '');
    return DONE_EMOJI.includes(n) || DONE_EMP_RE.test(n);
  });
}

/* 워크플로우 글 1건 → 방문 레코드. 형식이 아니면 null */
function toRecord(text, replies, todayYmd, reactions){
  const f = parseFields(text);
  const store = f['상호명'];
  if(!store || isBlank(store)) return null;          // 상호명이 없으면 브랜드를 가를 수 없다

  const reqDate = ymd(f['요청일시']);
  const visitDate = ymd(f['방문일자']);
  const th = parseThread(replies);

  /* 대시보드는 '인입' 기준으로 집계한다 — 날짜는 요청일시를 쓰고,
     방문일자는 상세에 보여준다. 요청일시가 없으면 방문일자로 대체. */
  const date = reqDate || visitDate;
  if(!date) return null;

  /* 완료 이모지가 찍혔으면 예정일이 남았어도 완료다 */
  let status = 'hold';                                // 방문일자 미정
  if(doneByEmoji(reactions))  status = 'done';
  else if(visitDate)          status = visitDate <= todayYmd ? 'done' : 'pending';

  return {
    id      : (f['ID'] || '').trim(),
    date    : date,
    time    : hm(f['요청일시']),
    store   : String(store).trim(),
    biz     : String(f['사업자번호'] || '').replace(/\D/g, ''),
    kind    : normKind(f['설치구분']),
    status  : status,
    visitDate: visitDate,
    region  : isBlank(f['수도권/지방 구분']) ? '' : f['수도권/지방 구분'],
    route   : isBlank(f['판매경로'])   ? '' : f['판매경로'],
    addr    : isBlank(f['주소지'])     ? '' : f['주소지'],
    van     : isBlank(f['VAN'])        ? '' : f['VAN'],
    equip   : isBlank(f['설치장비'])   ? '' : f['설치장비'],
    ship    : isBlank(f['택배발송일']) ? '' : ymd(f['택배발송일']),
    delivery: isBlank(f['배달4사 계약여부']) ? '' : f['배달4사 계약여부'],
    requester: String(f['요청자'] || '').replace(/^@/, '').replace(/\(.*\)$/, '').trim(),
    assignee : th.assignee,
    rounds   : th.rounds,
    roundDates: th.roundDates,
  };
}

module.exports = { parseFields, toRecord, normKind, parseThread, unmark, extractText, setUserMap, doneByEmoji };

/* ── 여기부터는 실행용 (슬랙 토큰 필요) ────────────────────── */
if(require.main !== module) return;

const TOKEN = process.env.SLACK_BOT_TOKEN;
if(!TOKEN){ console.error('SLACK_BOT_TOKEN 환경변수가 필요합니다.'); process.exit(1); }

const FROM = process.env.VISIT_FROM || '2026-07-01';
const oldest = Math.floor(new Date(FROM + 'T00:00:00+09:00').getTime() / 1000);
const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);   // KST

async function slack(method, params){
  const url = new URL('https://slack.com/api/' + method);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const j = await res.json().catch(() => ({}));
  if(!j.ok) throw new Error(method + ': ' + (j.error || 'unknown'));
  return j;
}

/* 멘션 ID → 이름. 한 번만 받아 캐시한다. 실패해도 적재는 계속(ID 는 지워짐) */
async function loadUsers(){
  const map = {};
  let cursor = '', guard = 0;
  try {
    do {
      const p = { limit: '200' };
      if(cursor) p.cursor = cursor;
      const j = await slack('users.list', p);
      for(const u of (j.members || [])){
        const pr = u.profile || {};
        map[u.id] = pr.display_name || pr.real_name || u.real_name || u.name || '';
      }
      cursor = (j.response_metadata && j.response_metadata.next_cursor) || '';
    } while(cursor && ++guard < 20);
  } catch(e){ console.log('  (users.list 실패 — 멘션은 이름 대신 생략됩니다: ' + e.message + ')'); }
  return map;
}

async function history(){
  let cursor = '', out = [], guard = 0;
  do {
    const p = { channel: CHANNEL, oldest: String(oldest), limit: '200' };
    if(cursor) p.cursor = cursor;
    const j = await slack('conversations.history', p);
    out = out.concat(j.messages || []);
    cursor = (j.response_metadata && j.response_metadata.next_cursor) || '';
  } while(cursor && ++guard < 30);
  return out;
}

/* 스레드는 담당자·회차 때문에 읽는다. 실패해도 본체는 살린다 */
let replyCalls = 0;
const MAX_REPLIES = +(process.env.VISIT_MAX_REPLIES || 600);   /* 프랜차이즈 건만 조회하므로 넉넉하다 */
async function replies(ts){
  if(replyCalls >= MAX_REPLIES) return [];
  replyCalls++;
  try {
    const j = await slack('conversations.replies', { channel: CHANNEL, ts: ts, limit: '50' });
    return (j.messages || []).slice(1);
  } catch(e){ return []; }
}

(async () => {
  setUserMap(await loadUsers());
  const msgs = await history();
  const recs = [];
  const seen = new Set();
  let skipped = 0;

  /* 진단용 — 0건이 나왔을 때 원인을 좁히기 위한 '구조' 정보만 모은다.
     저장소가 public 이라 Actions 로그도 공개된다. 상호명·사업자번호 같은
     내용은 절대 찍지 않는다. */
  const diag = { subtypes: {}, containers: {}, blockTypes: {}, textLens: [], emoji: {} };
  const NOISE = ['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name'];

  for(const m of msgs){
    if(NOISE.includes(m.subtype)) continue;
    diag.subtypes[m.subtype || '(none)'] = (diag.subtypes[m.subtype || '(none)'] || 0) + 1;
    if(m.text)        diag.containers.text = (diag.containers.text || 0) + 1;
    if(m.blocks)      diag.containers.blocks = (diag.containers.blocks || 0) + 1;
    if(m.attachments) diag.containers.attachments = (diag.containers.attachments || 0) + 1;
    (m.blocks || []).forEach(bl => diag.blockTypes[bl.type] = (diag.blockTypes[bl.type] || 0) + 1);

    const text = extractText(m);
    diag.textLens.push(text.length);
    if(!/상호명\s*:/.test(unmark(text))){ skipped++; continue; }
    (m.reactions || []).forEach(x => diag.emoji[x.name] = (diag.emoji[x.name] || 0) + 1);
    const r = toRecord(text, [], TODAY, m.reactions);   /* 스레드는 아래에서 따로 붙인다 */
    if(!r){ skipped++; continue; }
    /* 같은 요청이 여러 번 올라오면 ID 로 한 건으로 본다 */
    const key = r.id || (r.store + '|' + r.date + '|' + r.time);
    if(seen.has(key)) continue;
    seen.add(key);
    r._ts = m.thread_ts || m.ts;
    r._hasThread = !!(m.reply_count || m.thread_ts);
    recs.push(r);
  }

  /* ── 프랜차이즈 매장만 남긴다 ────────────────────────────
     이 파일을 읽는 건 프랜차이즈 대시보드뿐이다. 전 건을 담으면 1MB 가
     넘어 고객사가 페이지를 열 때마다 받아야 하고, 스레드도 2,600번 넘게
     조회해 상한에 걸린다. 브랜드 판별은 대시보드와 같은 모듈을 쓴다. */
  const vm2 = require('vm');
  const sb = { window: {}, console: console };
  sb.window.window = sb.window;
  vm2.createContext(sb);
  for(const f of ['brands.js', 'brand-match.js']){
    vm2.runInContext(fs.readFileSync(path.join(ROOT, 'franchise', f), 'utf8'), sb, { filename: f });
  }
  const BM = sb.window.BrandMatch;
  const bidx = BM.buildIndex(sb.window.FRANCHISE_BRANDS);
  const bex  = BM.buildExclude(sb.window.FRANCHISE_EXCLUDE);

  const all = recs.length;
  const kept = recs.filter(r => {
    if(bex.test(r.store, r.biz)) return false;
    const m = BM.matchBrand(bidx, r.store || '');
    if(!m) return false;
    r.brand = m.brand.name;                    /* 어느 브랜드로 갔는지 파일에 남긴다 */
    return true;
  });
  recs.length = 0; recs.push(...kept);

  /* 남은 건만 스레드를 읽는다 — 담당자·방문 회차가 여기 있다 */
  for(const r of recs){
    if(!r._hasThread) { delete r._ts; delete r._hasThread; continue; }
    const th = await replies(r._ts);
    const t = parseThread(th);
    if(t.assignee) r.assignee = t.assignee;
    if(t.rounds)   { r.rounds = t.rounds; r.roundDates = t.roundDates; }
    delete r._ts; delete r._hasThread;
  }

  recs.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  /* 제외 판정(사업자번호 10자리)까지 끝난 뒤에 가린다 */
  recs.forEach(r => maskDeep(r));

  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const body = recs.map(r => '  ' + JSON.stringify(r) + ',').join('\n');
  const out =
`/*
 * 방문설치 채널(#ishopcare_new_방문설치) 적재 — 자동 생성 파일
 * 직접 수정하지 마세요. scripts/fetch-visits.js 가 덮어씁니다.
 * 갱신: ${stamp} KST · ${recs.length}건 (${FROM} 이후)
 */
window.VISIT_DATA = {
  updatedAt: '${stamp}',
  records: [
${body}
  ],
};
`;

  /* 시각만 바뀌었으면 파일을 건드리지 않는다 — CI 가 자주 도는데 커밋이 쌓인다 */
  const NOSTAMP = s => s.split('\r').join('')
    .replace(/갱신: [^\n]*\n/, '갱신: -\n')
    .replace(/updatedAt: '[^']*'/, "updatedAt: '-'");
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const byKind = {};
  recs.forEach(r => byKind[r.kind] = (byKind[r.kind] || 0) + 1);

  /* 한 건도 못 건졌으면 왜인지 구조만 남긴다 (내용은 찍지 않는다) */
  if(!recs.length){
    const lens = diag.textLens.sort((a, b) => a - b);
    console.log('진단  메시지 ' + msgs.length + '건 · subtype ' + JSON.stringify(diag.subtypes));
    console.log('진단  본문 위치 ' + JSON.stringify(diag.containers) + ' · block종류 ' + JSON.stringify(diag.blockTypes));
    console.log('진단  추출 길이 min/중앙/max = '
      + (lens[0] || 0) + '/' + (lens[Math.floor(lens.length / 2)] || 0) + '/' + (lens[lens.length - 1] || 0));
    console.log('진단  → 길이가 0 이면 본문을 못 읽은 것, 길면 "상호명:" 형식이 다른 것');
  }

  /* 상태·이모지 요약은 파일이 안 바뀌어도 항상 남긴다.
     '변경 없음' 뒤에 두면 정작 왜 상태가 안 바뀌었는지 확인할 길이 없다. */
  const st = {}; recs.forEach(r => st[r.status] = (st[r.status] || 0) + 1);
  const em = Object.entries(diag.emoji).sort((a,b)=>b[1]-a[1]).slice(0,20).map(x=>x[0]+' '+x[1]).join(' · ');
  console.log('상태  ' + JSON.stringify(st));
  console.log('이모지 ' + (em || '(리액션이 하나도 없음)') + '   ← 완료로 칠 것이 빠졌으면 DONE_EMOJI 에 추가');

  if(prev && NOSTAMP(prev) === NOSTAMP(out)){
    console.log('변경  없음 — 파일 유지 (' + recs.length + '건)');
    return;
  }
  fs.writeFileSync(OUT, out, 'utf8');
  const brands = {};
  recs.forEach(r => brands[r.brand] = (brands[r.brand] || 0) + 1);
  const top = Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(x => x[0] + ' ' + x[1]).join(' · ');
  console.log('적재  ' + recs.length + '건 (방문요청 ' + all + '건 중 프랜차이즈 매장)  ' + JSON.stringify(byKind));
  console.log('브랜드 ' + Object.keys(brands).length + '개 — ' + top);
  console.log('제외  형식 불일치 ' + skipped + '건 · 스레드 조회 ' + replyCalls + '회'
    + ' · 담당자 확인 ' + recs.filter(r => r.assignee).length + '건');
  console.log('생성  ' + path.relative(ROOT, OUT) + ' (' + Math.round(out.length / 1024) + ' KB)');
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
