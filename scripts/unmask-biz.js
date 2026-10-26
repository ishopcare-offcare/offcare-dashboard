#!/usr/bin/env node
/*
 * 사업자번호 가림 되돌리기 (2026-10-26 결정, 일회성).
 *
 * 2026-10-20 15:11 에 공개 데이터 파일의 사업자번호를 앞 5자리 + ***** 로 가렸다(scripts/mask-existing-pii.js).
 * 가리기 직전 원본이 git 기록(MASK_REV^)에 남아 있으므로 거기서 되살린다.
 *
 *   node scripts/unmask-biz.js          # 고치고 결과 요약
 *   node scripts/unmask-biz.js --dry    # 쓰지 않고 요약만
 *
 *  - 그 뒤로 안 바뀐 정적 파일(예약 리포트·이모지 시각·완료 시각 복원본)은 원본에 지금 규칙(전화번호·주소만 가림)을 다시 적용.
 *  - 매일 쌓이는 slack-data.js 는 같은 날짜·시각·상호의 원본 번호로 채운다.
 *  - 안전장치: 결과를 다시 가렸을 때 지금 파일과 똑같아야만 쓴다(가린 자리 말고는 아무것도 안 바뀜).
 *  - 2026-10-20 이후 새로 들어온 건은 원본이 없어 가린 채 남는다 → backfill 워크플로(from_date 2026-10-20)로 슬랙에서 다시 읽는다.
 *  - visit-data.js · menu-requests.js · franchise/data · share/compose 는 매 집계 때 슬랙/slack-data 에서 다시 만들어져 저절로 풀린다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { maskText, maskBiz, maskKeyTail } = require('./pii-mask');

const ROOT = path.join(__dirname, '..');
const MASK_REV = '360749d26';            // '기존 파일의 사업자번호·상세주소 가림' 커밋
const DRY = process.argv.includes('--dry');

const P = f => path.join(ROOT, f);
const gitOld = f => execFileSync('git', ['show', MASK_REV + '^:' + f], { cwd: ROOT, maxBuffer: 1 << 30 }).toString('utf8');
const RE_STAR = /(?<![\d*])(\d{3}[-\s]?\d{2}[-\s]?)\*{5}(?![\d*])/g;           // 12345***** · 123-45-*****
const RE_FULL = /(?<![\d*])(\d{3}[-\s]?\d{2}[-\s]?)(\d{5})(?![\d*])/g;           // 같은 모양의 원본

const digits = s => String(s || '').replace(/\D/g, '');
const normStore = s => String(s || '').replace(/\s+/g, '').toLowerCase();

// 가린 번호와 원본 번호는 길이가 같다 → 두 글이 같은 길이이고, 다른 글자는 모두 '지금 *****' ↔ '원본 숫자 5개' 자리여야 한다
function onlyStarsDiffer(before, after){
  if (before.length !== after.length) return 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (before[i] !== '*' || !/\d/.test(after[i])) return i || -1;
    // 이 자리가 'NNNNN*****' 의 별표 칸인지 — 숫자 뒤 별표 5개 이상 묶음 안(11자리로 잘못 적힌 번호는 6개)
    let a = i; while (a > 0 && before[a - 1] === '*') a--;
    let b = i; while (b < before.length && before[b] === '*') b++;
    if (b - a < 5 || !/[\d\s-]/.test(before[a - 1] || '')) return i;   // '837 20 *****' 처럼 띄어 쓴 번호도
  }
  return null;
}
function save(file, before, after, label){
  const bad = onlyStarsDiffer(before, after);
  if (bad !== null) {
    const i = Math.max(0, bad);
    console.log(`✖ ${file}: 가린 자리 밖에서 차이 → 건너뜀 (위치 ${i}: ${JSON.stringify(before.slice(Math.max(0, i - 50), i + 50))} vs ${JSON.stringify(after.slice(Math.max(0, i - 50), i + 50))})`);
    return false;
  }
  const left = (after.match(RE_STAR) || []).length, was = (before.match(RE_STAR) || []).length;
  console.log(`${DRY ? '·' : '✔'} ${file}: 가린 번호 ${was} → ${left} (${label})`);
  if (!DRY && after !== before) fs.writeFileSync(P(file), after, 'utf8');
  return true;
}

/* ── 정적 파일: 원본 + 지금 규칙 ── */
function staticFile(file, how){
  if (!fs.existsSync(P(file))) return console.log('없음 ' + file);
  const cur = fs.readFileSync(P(file), 'utf8');
  const old = gitOld(file);
  let out = old;
  if (how === 'text') out = maskText(old);
  // 원본의 줄바꿈이 지금 파일과 다르면 지금 쪽에 맞춘다
  if (cur.includes('\r\n') && !out.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  if (!cur.includes('\r\n') && out.includes('\r\n')) out = out.replace(/\r\n/g, '\n');
  save(file, cur, out, '원본 복원');
}

/* ── slack-data.js: 날짜·시각·상호로 짝 맞추기 ── */
function slackData(){
  const file = 'slack-data.js';
  const cur = fs.readFileSync(P(file), 'utf8');
  const load = src => { const w = {}; new Function('window', src)(w); return w.SLACK_DATA; };
  const old = load(gitOld(file));

  // 원본 색인: 날짜|시각|상호 → 번호, 날짜|상호, 상호, 앞5자리(+상호) → 번호 후보
  const idx = { dts: {}, ds: {}, s: {}, pre: {} };
  const add = (m, k, v) => { (m[k] = m[k] || new Set()).add(v); };
  (function walk(o, day){
    if (Array.isArray(o)) return o.forEach(x => walk(x, day));
    if (!o || typeof o !== 'object') return;
    const b = digits(o.biz);
    if (b.length === 10 && o.store) {
      const st = normStore(o.store), t = o.time || o.hm || '';
      if (day) { add(idx.dts, day + '|' + t + '|' + st, b); add(idx.ds, day + '|' + st, b); }
      add(idx.s, st, b); add(idx.pre, b.slice(0, 5), b);
    }
    for (const [k, v] of Object.entries(o)) walk(v, /^\d{4}-\d\d-\d\d$/.test(k) ? k : day);
  })(old, '');
  // 문자열 속 번호도 앞자리 후보에 (상호 없이 적힌 것)
  JSON.stringify(old).replace(RE_FULL, (m, h, t) => { const d = digits(h) + t; add(idx.pre, d.slice(0, 5), d); return m; });

  const one = (set, pre) => { if (!set) return ''; const c = [...set].filter(b => b.slice(0, 5) === pre); return c.length === 1 ? c[0] : ''; };
  let fixed = 0, left = 0;
  const data = load(cur);
  (function walk(o, day){
    if (Array.isArray(o)) return o.forEach(x => walk(x, day));
    if (!o || typeof o !== 'object') return;
    let full = '';
    const bs = String(o.biz || '');
    if (/^\d{5}\*{5}$/.test(bs)) {
      const pre = bs.slice(0, 5), st = normStore(o.store), t = o.time || o.hm || '';
      full = one(idx.dts[day + '|' + t + '|' + st], pre) || one(idx.ds[day + '|' + st], pre) || (st && one(idx.s[st], pre))
        // 가리기 전 날짜의 건이면 원본 어딘가에 있었다 — 앞 5자리가 원본 전체에서 하나뿐이면 그 번호
        || (day && day < '2026-10-20' && one(idx.pre[pre], pre)) || '';
      if (full) { o.biz = full; fixed++; } else left++;
    } else if (/^\d{10}$/.test(bs)) full = bs;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && k !== 'biz' && RE_STAR.test(v)) {
        RE_STAR.lastIndex = 0;
        o[k] = v.replace(RE_STAR, (m, head) => {
          const pre = digits(head);
          const b = (full && full.slice(0, 5) === pre) ? full : one(idx.pre[pre], pre);
          return b ? head + b.slice(5) : m;
        });
      } else walk(v, /^\d{4}-\d\d-\d\d$/.test(k) ? k : day);
    }
  })(data, '');

  const mark = 'window.SLACK_DATA = ';
  let out = cur.slice(0, cur.indexOf(mark)) + mark + JSON.stringify(data, null, 2) + ';\n';
  out = eolLike(cur, out);
  save(file, cur, out, `biz 칸 ${fixed}건 복원 · 원본 없음 ${left}건(10/20 이후 → backfill)`);
}

/* 줄바꿈을 지금 파일에 맞춘다(CRLF 로 저장된 파일이 섞여 있다) */
function eolLike(cur, out){
  const crlf = cur.includes('\r\n');
  out = out.replace(/\r\n/g, '\n');
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/* 이모지 시각 원본 — 키 '날짜|시각|사업자번호' 의 번호 칸은 숫자만(지금 maskKeyTail 과 같은 정리) */
let emojiOut = null;
function emojiTimes(){
  const file = 'share/emoji-times.json';
  const cur = fs.readFileSync(P(file), 'utf8');
  const j = JSON.parse(gitOld(file));
  j.items = Object.fromEntries(Object.entries(j.items || {}).map(([k, v]) => [maskKeyTail(k), v]));
  // 가릴 때 앞자리·시각이 같은 키가 하나로 합쳐져 사라진 건이 있어(되살아난다) 글자 비교 대신 키로 검증한다:
  // 지금 키 집합 = 복원 키를 다시 가린 집합, 머리 정보 동일
  const st = k => k.replace(/\|(\d{5})(\d+)$/, (m, p, r) => '|' + p + '*'.repeat(r.length));
  const c = JSON.parse(cur), ck = new Set(Object.keys(c.items)), rk = new Set(Object.keys(j.items).map(st));
  if (!(ck.size === rk.size && [...ck].every(k => rk.has(k)) && c.from === j.from && c.builtAt === j.builtAt))
    return console.log('✖ ' + file + ': 키 집합이 다름 → 건너뜀');
  emojiOut = JSON.stringify(j);
  const n = Object.keys(j.items).length;
  console.log(`${DRY ? '·' : '✔'} ${file}: 키 ${Object.keys(c.items).length} → ${n} (가릴 때 합쳐졌던 ${n - Object.keys(c.items).length}건 되살림) · 남은 가린 키 ${Object.keys(j.items).filter(k => k.includes('*')).length}`);
  if (!DRY) fs.writeFileSync(P(file), eolLike(cur, emojiOut), 'utf8');
}
/* done-backfill.js — scripts/build-done-backfill.js 와 같은 방식으로 복원한 이모지 시각에서 다시 만든다
   (이모지 시각에서 1:1 로 만든 파일이라, 이모지 시각이 검증을 통과했으면 그대로 쓴다) */
function doneBackfill(){
  const file = 'done-backfill.js';
  if (emojiOut === null) return console.log('✖ ' + file + ': 이모지 시각 복원이 안 돼 건너뜀');
  const cur = fs.readFileSync(P(file), 'utf8');
  const j = JSON.parse(emojiOut);
  const days = {};
  for (const [key, v] of Object.entries(j.items || {})) {
    const [day, hm, biz] = key.split('|');
    (days[day] = days[day] || []).push([hm, maskBiz(biz), v.done, v.cat || '']);
  }
  for (const d of Object.keys(days)) days[d].sort((a, b) => a[0].localeCompare(b[0]));
  const body = { from: j.from, to: j.to, builtAt: j.builtAt, note: j.note, days };
  const out = '// 자동 생성 — scripts/build-done-backfill.js (원본: scripts/mine-emoji-times.js)\nwindow.DONE_BACKFILL = ' + JSON.stringify(body) + ';\n';
  const res = eolLike(cur, out);
  console.log(`${DRY ? '·' : '✔'} ${file}: 이모지 시각에서 재생성 · 남은 가린 번호 ${(res.match(RE_STAR) || []).length} · ${cur.length}→${res.length}자`);
  if (!DRY) fs.writeFileSync(P(file), res, 'utf8');
}

emojiTimes();
doneBackfill();
staticFile('share/booking-report.html', 'text');
staticFile('share/booking-report.csv', 'text');
staticFile('share/nosetup-report.csv', 'text');
slackData();
