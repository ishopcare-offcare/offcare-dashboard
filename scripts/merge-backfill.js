/*
 * 백필 결과를 최신 slack-data.js 위에 날짜 단위로 덮어쓴다 (backfill.yml 푸시 단계 전용)
 *
 *   node scripts/merge-backfill.js <백필본 slack-data.js> <최신 slack-data.js> <from_date>
 *
 * 왜 필요한가: 백필은 slack-data.js 를 통째로 다시 쓰는데, 4분쯤 도는 사이 평소 집계 봇이
 * 같은 파일을 1~몇 분마다 푸시한다. 텍스트 rebase 는 한 번만 끼어들어도 충돌해
 * 2026-09-29 백필 #13 이 푸시 8회를 전부 실패했다.
 * → 푸시할 때마다 최신 main 을 받아 '백필한 과거 날짜'만 JSON 으로 바꿔 끼운다. 충돌이 날 수 없다.
 *
 * 최근 RECENT_DAYS 일은 봇이 매번 다시 집계하므로 봇(최신) 값을 둔다 — 백필본이 몇 분 더 오래됐다.
 * 백필본에서 그 날을 못 읽었던 경우(기존 값 보존으로 건너뜀)는 최신본과 같거나 더 오래된 값이라 그대로 덮어도 된다.
 */
const fs = require('fs');
const [, , bfPath, outPath, from] = process.argv;
if (!bfPath || !outPath || !/^\d{4}-\d{2}-\d{2}$/.test(from || '')) {
  console.error('사용법: node scripts/merge-backfill.js <백필본> <최신본> <YYYY-MM-DD>');
  process.exit(1);
}
const RECENT_DAYS = 3;   // fetch-and-tally.js 의 롤링 창(오늘 포함 3일)과 같다

function load(p) {
  const text = fs.readFileSync(p, 'utf8');
  const w = {}; new Function('window', text)(w);
  if (!w.SLACK_DATA || !w.SLACK_DATA.days) throw new Error(p + ': SLACK_DATA 없음');
  return { text, data: w.SLACK_DATA };
}
const bf = load(bfPath).data;
const latest = load(outPath);
const data = latest.data;

const kst = new Date(Date.now() + 9 * 3600 * 1000);
const cutObj = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - (RECENT_DAYS - 1)));
const cutoff = cutObj.toISOString().slice(0, 10);   // 이 날부터는 봇 값 유지

let replaced = 0;
for (const d of Object.keys(bf.days)) {
  if (d < from || d >= cutoff) continue;
  data.days[d] = bf.days[d];
  if (bf.noteV && bf.noteV[d] !== undefined) { data.noteV = data.noteV || {}; data.noteV[d] = bf.noteV[d]; }
  replaced++;
}
data.version = Math.max(data.version || 0, bf.version || 0) + 1;
// 머리말은 최신본 그대로 쓴다(fetch-and-tally.js 와 같은 형식 유지)
const header = latest.text.slice(0, latest.text.indexOf('window.SLACK_DATA'));
fs.writeFileSync(outPath, header + 'window.SLACK_DATA = ' + JSON.stringify(data, null, 2) + ';\n', 'utf8');
console.log(`백필 병합: ${from} ~ ${cutoff} 전날까지 ${replaced}일 교체 (최근 ${RECENT_DAYS}일은 최신 집계 유지) · version=${data.version}`);
