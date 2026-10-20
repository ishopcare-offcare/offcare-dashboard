/*
 * 지난 기간의 '완료 이모지가 찍힌 시각'을 git 히스토리에서 복원한다.
 *
 * 왜 필요한가:
 *   슬랙 API 는 리액션이 찍힌 시각을 주지 않는다. fetch-and-tally.js 의 폴링 추적(resp.dmin)이
 *   그걸 근사하지만 2026-08-31 적재분부터만 남아 있어, 그 전 기간(예: 8월 리포트)은 소요시간이 빈다.
 *
 * 어떻게 복원하나:
 *   slack-data.js 는 집계 워크플로가 하루 200번쯤 커밋해 왔다 — git 히스토리 자체가 스냅샷 기록이다.
 *   어떤 요청이 스냅샷 A 의 days[업무일].done 에는 없고 다음 스냅샷 B 에는 있으면 완료 이모지는 A~B 사이에 찍혔다.
 *   중간값을 완료 시각으로 본다(오차폭 = 스냅샷 간격, 보통 5~10분). 살아 있는 폴링 추적과 방법·해상도가 같다.
 *   처음 관찰한 스냅샷에 이미 done 에 있던 건은 언제 찍혔는지 알 수 없어 표본에서 뺀다(추적도 같은 규칙).
 *
 * 걸려 넘어졌던 것들 (고치면서 알게 된 것 — 다시 건드릴 때 주의):
 *   · 커밋 날짜는 스냅샷 시각이 아니다. 워크플로가 푸시 경합 때 pull --rebase 로 재시도하면서
 *     커밋 날짜가 나중 시각으로 덮인다. → 스냅샷이 스스로 적어 둔 days[업무일].updatedAt 을 시계로 쓴다.
 *   · git log --since 는 커밋 날짜가 뒤섞인 히스토리에서 순회를 일찍 끊어 오전 커밋을 통째로 빠뜨린다.
 *     → 전체 목록을 한 번 받아 JS 에서 걸러 낸다.
 *   · 진행 집계는 대상일이 아닌 날짜에 done 없이 counts/pending 만 써 넣는다. 날짜 블록 경계를 안 잡으면
 *     다음 날짜의 done 을 집어 와 엉뚱한 날짜에 섞인다. → 블록을 괄호 짝으로 잘라 그 안에서만 찾는다.
 *
 * 실행:
 *   node scripts/mine-emoji-times.js                    # 기본 2026-08-01 ~ 2026-08-31 (약 15분)
 *   DAYS=2026-09-02 node scripts/mine-emoji-times.js    # 특정 날짜만 (검증용)
 *
 * 출력:
 *   share/emoji-times.json  { "업무일|HH:MM|사업자번호": { done: 분, lo, hi, cat, emp } }
 *   booking-report.js 가 resp.dmin 이 없는 기간에 이 파일을 대신 쓴다.
 */
const fs = require('fs');
const path = require('path');
const { maskKeyTail } = require('./pii-mask');   // 키 끝 칸이 사업자번호 — 가려서 싣는다
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FROM = (process.env.FROM || '2026-08-01').trim();
const TO = (process.env.TO || '2026-08-31').trim();
const ONLY = (process.env.DAYS || '').split(',').map(s => s.trim()).filter(Boolean);
const OUT_ARG = process.env.OUT || 'share/emoji-times.json';
const OUT = path.isAbsolute(OUT_ARG) ? OUT_ARG : path.join(ROOT, OUT_ARG);

const pad = n => String(n).padStart(2, '0');
// 인자를 배열로 넘긴다 — 셸을 거치면 포맷 문자열의 '|' 가 파이프로 해석된다(Windows cmd)
const git = (args, big) => {
  const r = spawnSync('git', args, { cwd: ROOT, maxBuffer: big ? (1 << 28) : (1 << 24), encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'git 실패: ' + args.join(' '));
  return r.stdout;
};
const ymd = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const dayMs = day => Date.parse(day + 'T00:00:00Z');
const shift = (day, n) => ymd(dayMs(day) + n * 86400000);
const dayList = (from, to) => {
  const out = [];
  for (let t = dayMs(from); t <= dayMs(to); t += 86400000) out.push(ymd(t));
  return out;
};
const DAYS = ONLY.length ? ONLY : dayList(FROM, TO);
const DAYSET = new Set(DAYS);
const postMs = (day, hm) => {                      // 업무일 + KST HH:MM → epoch ms
  const [H, M] = hm.split(':').map(Number);
  return dayMs(day) + (H * 60 + M) * 60000 - 9 * 3600e3;
};

function matchBracket(src, start) {                // start = '[' 또는 '{' 위치 → 짝이 닫히는 위치
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// 한 날짜 블록에서 updatedAt(스냅샷 시각)과 done 배열을 뽑는다. 블록 밖은 절대 보지 않는다.
function readDay(src, day) {
  const dk = src.indexOf('"' + day + '": {');
  if (dk < 0) return null;
  const open = src.indexOf('{', dk);
  const end = matchBracket(src, open);
  if (end < 0) return null;
  const dn = src.indexOf('"done": [', open);
  if (dn < 0 || dn > end) return null;             // 이 스냅샷에는 그날 done 이 없다
  const close = matchBracket(src, dn + '"done": '.length);
  if (close < 0) return null;
  const upd = (src.slice(open, Math.min(end, open + 400000)).match(/"updatedAt":\s*"(\d\d:\d\d)"/) || [])[1];
  if (!upd) return null;
  return { upd, done: src.slice(dn + '"done": '.length, close + 1) };
}

/* done 항목의 키 순서는 time → store → biz → cat → emp 로 고정이다.
   pending 항목은 biz 다음이 handler 라서 이 정규식에 걸리지 않는다(둘이 섞이지 않게 일부러 이렇게 묶었다). */
const RE_ITEM = /"time":\s*"(\d\d:\d\d)",\s*"store":\s*"(?:[^"\\]|\\.)*",\s*"biz":\s*"([^"]*)",\s*"cat":\s*"([^"]*)",\s*"emp":\s*"((?:[^"\\]|\\.)*)"/g;

// ── 커밋 목록 (한 번만 받아서 JS 에서 걸러 낸다) ──
const WIN_FROM = dayMs(DAYS[0]) - 9 * 3600e3 - 6 * 3600e3;                  // 업무일 시작 05:30 KST 전 여유
const WIN_TO = dayMs(DAYS[DAYS.length - 1]) + 3 * 86400000 - 9 * 3600e3;    // 이튿날 새벽 마감 + 재집계 여유
const commits = git(['log', '--format=%H %ct', '--', 'slack-data.js']).trim().split('\n')
  .map(l => { const [sha, ct] = l.split(' '); return { sha, at: Number(ct) * 1000 }; })
  .filter(c => c.at >= WIN_FROM && c.at <= WIN_TO)
  .sort((a, b) => a.at - b.at);
console.log(`대상 ${DAYS.length}일 · 읽을 스냅샷 ${commits.length}개`);

// ── 한 번 훑으면서 날짜별 타임라인을 모은다 ──
const timeline = {};   // 업무일 → { clocks:Set, firstAt:Map(key→clock), meta:Map(key→{cat,emp}) }
for (const day of DAYS) timeline[day] = { clocks: new Set(), firstAt: new Map(), meta: new Map() };

const t0 = Date.now();
let read = 0, used = 0;
for (const c of commits) {
  let src;
  try { src = git(['show', `${c.sha}:slack-data.js`], true); } catch (e) { continue; }
  read++;
  // 이 커밋이 담을 수 있는 업무일만 본다 (그날 ~ 3일 전)
  for (let k = 0; k <= 3; k++) {
    const day = ymd(c.at + 9 * 3600e3 - k * 86400000);
    if (!DAYSET.has(day)) continue;
    const got = readDay(src, day);
    if (!got) continue;
    const T = timeline[day];
    // 업무일은 05:30~다음날 01:00 → updatedAt 이 05:00 보다 이르면 자정을 넘긴 집계다
    const clock = postMs(got.upd < '05:00' ? shift(day, 1) : day, got.upd);
    T.clocks.add(clock);
    let m; RE_ITEM.lastIndex = 0;
    while ((m = RE_ITEM.exec(got.done))) {
      const key = day + '|' + m[1] + '|' + m[2];
      const prev = T.firstAt.get(key);
      if (prev == null || clock < prev) T.firstAt.set(key, clock);
      if (!T.meta.has(key)) T.meta.set(key, { cat: m[3], emp: m[4] });
    }
    used++;
  }
  if (read % 500 === 0) console.log(`  ... ${read}/${commits.length} (${((Date.now() - t0) / 1000).toFixed(0)}초)`);
}

// ── 날짜별로 첫 등장 구간을 소요시간으로 환산 ──
const items = {};
let baselineSkipped = 0, dropped = 0;
for (const day of DAYS) {
  const T = timeline[day];
  const clocks = [...T.clocks].sort((a, b) => a - b);
  if (clocks.length < 2) { console.log(`${day}  스냅샷 ${clocks.length}개 — 복원 불가`); continue; }
  const baseClock = clocks[0];
  let n = 0, band = 0;
  for (const [key, clock] of T.firstAt) {
    if (clock <= baseClock) { baselineSkipped++; continue; }   // 관찰 시작 때 이미 완료 → 측정 불가
    const prev = clocks[clocks.indexOf(clock) - 1];
    const post = postMs(day, key.split('|')[1]);
    const mid = (prev + clock) / 2;
    const min = (mid - post) / 60000;
    if (!(min >= 0) || min > 18 * 60) { dropped++; continue; }  // 음수·하루 가까운 값은 짝이 어긋난 것으로 보고 버린다
    const meta = T.meta.get(key) || {};
    items[key] = {
      done: Math.round(min * 10) / 10,
      lo: Math.round((prev - post) / 60000 * 10) / 10,
      hi: Math.round((clock - post) / 60000 * 10) / 10,
      cat: meta.cat, emp: meta.emp,
    };
    n++; band += (clock - prev) / 60000;
  }
  console.log(`${day}  스냅샷 ${String(clocks.length).padStart(3)} · 복원 ${String(n).padStart(4)}건 · 평균 오차폭 ${n ? (band / n).toFixed(1) : '-'}분`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  from: DAYS[0], to: DAYS[DAYS.length - 1],
  builtAt: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' KST',
  note: 'git 히스토리의 slack-data.js 스냅샷을 비교해 복원한 완료 이모지 시각 (scripts/mine-emoji-times.js)',
  items: Object.fromEntries(Object.entries(items).map(([k, v]) => [maskKeyTail(k), v])),
}), 'utf8');

console.log(`\n복원 ${Object.keys(items).length}건 · 측정 불가 ${baselineSkipped}건(관찰 시작 때 이미 완료) · 버림 ${dropped}건`);
console.log(`→ ${OUT} · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
