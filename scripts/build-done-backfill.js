/* 소요시간 git 복원분 → 대시보드용 done-backfill.js
 *
 * scripts/mine-emoji-times.js 의 결과(JSON)를 날짜별 [시각, 사업자, 소요분, 카테고리] 배열로 줄여
 * window.DONE_BACKFILL 에 싣는다. 대시보드(index.html respItemsOf)가 폴링 추적이 없는 곳만 골라 쓴다.
 *
 *   FROM=2026-08-01 TO=2026-09-23 OUT=tmp.json node scripts/mine-emoji-times.js
 *   node scripts/build-done-backfill.js tmp.json
 */
const fs = require('fs');
const path = require('path');
const { maskBiz } = require('./pii-mask');

const src = process.argv[2] || path.join(__dirname, '..', 'share', 'emoji-times.json');
const out = path.join(__dirname, '..', 'done-backfill.js');
const j = JSON.parse(fs.readFileSync(src, 'utf8'));

const days = {};
let n = 0;
for (const [key, v] of Object.entries(j.items || {})) {
  const [day, hm, biz] = key.split('|');
  (days[day] = days[day] || []).push([hm, maskBiz(biz), v.done, v.cat || '']);
  n++;
}
for (const d of Object.keys(days)) days[d].sort((a, b) => a[0].localeCompare(b[0]));

const body = { from: j.from, to: j.to, builtAt: j.builtAt, note: j.note, days };
fs.writeFileSync(out, '// 자동 생성 — scripts/build-done-backfill.js (원본: scripts/mine-emoji-times.js)\nwindow.DONE_BACKFILL = '
  + JSON.stringify(body) + ';\n', 'utf8');
console.log(`✅ done-backfill.js · ${Object.keys(days).length}일 · ${n}건 · ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
