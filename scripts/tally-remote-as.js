/*
 * 원격 AS요청 채널 집계 스크립트 (날짜별 누적)
 * 사용법:
 *   집계만 출력:   node scripts/tally-remote-as.js <슬랙읽기결과파일> <YYYY-MM-DD>
 *   파일에 기록:   node scripts/tally-remote-as.js <슬랙읽기결과파일> <YYYY-MM-DD> --write slack-data.js
 * --write 하면 slack-data.js 의 days["YYYY-MM-DD"] 항목을 추가/갱신하고 version 을 +1 합니다.
 */
const fs = require('fs');
const file = process.argv[2];
const targetDate = process.argv[3];
const writeIdx = process.argv.indexOf('--write');
const outPath = writeIdx > -1 ? process.argv[writeIdx + 1] : null;
if (!file || !targetDate) { console.error('usage: node tally-remote-as.js <file> <YYYY-MM-DD> [--write slack-data.js]'); process.exit(1); }

let t = fs.readFileSync(file, 'utf8');
t = t.replace(/\\u([0-9a-fA-F]{4})/g, (m, g) => String.fromCharCode(parseInt(g, 16))); // \uXXXX 디코드
t = t.replace(/\\\//g, '/'); // \/ 언이스케이프

const personMap = { '규빈':'김규빈','선유':'배선유','성현':'심성현','동욱':'김동욱','현기':'김현기','태양':'송태양','기범':'김기범','상원':'서상원','민석':'최민석','경림':'고경림','하림':'박하림' };
const catMap = { '원격온보딩':'onboarding', '원격as':'as', '원격명의변경':'transfer', '원격메뉴등록':'menu', '원격voc':'voc', '원격배달':'delivery', '원격예약':'booking', '예약':'booking' };
// 이모지 이름 목록은 personMap에서 자동 생성 — 입·퇴사 시 personMap만 고치면 됨
const NAMES = Object.keys(personMap).join('|');
const RE_EMP      = new RegExp('^원격(' + NAMES + ')$');          // 원격OOO (완료 담당자)
const RE_CONFIRM  = new RegExp('^(' + NAMES + ')(_확인.*)?$');     // OOO / OOO_확인
const RE_CONFIRM2 = new RegExp('^(' + NAMES + ')_?확인_?$');       // OOO_확인_

const counts = {};
const pending = [];
let completed = 0, externCount = 0, latestTime = '';

for (const b of t.split('=== Message from').slice(1)) {
  const at = (b.match(/at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/) || []);
  const date = at[1], time = at[2] || '';
  if (date !== targetDate) continue;
  if (time > latestTime) latestTime = time;

  const rm = b.match(/Reactions: (.*)/);
  const names = rm ? [...rm[1].matchAll(/([^,()]+?) \((\d+)\)/g)].map(x => x[1].trim()) : [];

  let store = ((b.match(/상호\s*[:：]\s*(.+)/) || [])[1] || '').trim().split('/')[0].trim();
  if (store.length > 30) store = store.slice(0, 30);
  const biz = ((b.match(/사업자\s*번?호?\s*[:：]\s*([\d\-]+)/) || [])[1] || '').replace(/-/g, '').trim();

  // 착수 담당자 (원격OOO) — 2026-09-16 규칙 변경으로 '완료'가 아니라 '손댐' 표시다.
  // 완료 판정은 카테고리 이모지(원격as·원격온보딩…)·원격외주가 한다.
  let emp = null;
  for (const n of names) { const pm = n.match(RE_EMP); if (pm) { emp = personMap[pm[1]]; break; } }
  // 카테고리 이모지
  let catKey = null;
  for (const n of names) { if (catMap[n]) { catKey = catMap[n]; break; } }
  if (names.some(n => catMap[n] === 'booking')) catKey = 'booking';   // 예약 이모지가 있으면 예약 우선 (fetch-and-tally 와 같은 규칙)
  const hasExtern = names.includes('원격외주');
  // 카테고리 이모지가 없으면 완료가 아니다 — 예전엔 '원격OOO'만 있어도 AS 완료로 쳤지만
  // 이제 '원격OOO'는 착수 표시라, 그대로 두면 잡기만 한 건이 완료로 잡힌다.
  // 확인 담당자 (OOO_확인) — 예: 태양_확인 → 송태양
  let confirmPerson = null;
  for (const n of names) { const cm = n.match(RE_CONFIRM); if (cm) { confirmPerson = personMap[cm[1]]; break; } }
  const has2ndAbsent = names.some(n => /2차.?부재/.test(n)); // 2차부재는 확인필요에서 제외
  const doer = emp || confirmPerson;   // 처리자(원격OOO 우선, 없으면 확인자)

  if (hasExtern) {                     // 외주 → 처리완료로 인정, 별도 집계
    const who = doer || '미지정';
    counts.extern = counts.extern || {};
    counts.extern[who] = (counts.extern[who] || 0) + 1; externCount++;
  } else if (catKey) {                 // AS/온보딩 완료 — 카테고리 이모지가 완료 신호
    if (!counts[catKey]) counts[catKey] = {};
    const who = doer || '미지정';
    counts[catKey][who] = (counts[catKey][who] || 0) + 1;
    completed++;
  } else if (doer && !has2ndAbsent) {
    // 착수(원격OOO·OOO_확인)만 되고 완료·분류가 안 됐고 2차부재가 아닌 건만 확인필요로 적재
    pending.push({ time, store, biz, handler: doer, reasons: ['확인 후 미완료'] });
  }
  // 그 외(무반응 / 부재만 / 이미 분류됨) → 적재하지 않음
}
pending.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

const dayEntry = { updatedAt: latestTime, counts, pending };

console.log('=== 집계 결과 (' + targetDate + ') ===');
console.log('완료:', completed, '/ 확인필요:', pending.length, '/ 외주:', externCount);
if (counts.extern) console.log('외주(별도 집계):', JSON.stringify(counts.extern));

if (outPath) {
  // 기존 slack-data.js 로드 → 병합 → 재작성
  let data = { version: 0, days: {} };
  if (fs.existsSync(outPath)) {
    const win = {};
    try { new Function('window', fs.readFileSync(outPath, 'utf8'))(win); if (win.SLACK_DATA) data = win.SLACK_DATA; } catch (e) {}
  }
  data.days = data.days || {};
  data.days[targetDate] = dayEntry;       // 해당 날짜 추가/갱신
  data.version = (data.version || 0) + 1;  // 브라우저 재반영용 버전 증가
  const header = '/*\n * 슬랙 #0_원격_as_요청 채널 집계 데이터 (날짜별 누적)\n * /원격집계 스킬이 매일 days["YYYY-MM-DD"] 항목을 추가/갱신합니다.\n */\n';
  fs.writeFileSync(outPath, header + 'window.SLACK_DATA = ' + JSON.stringify(data, null, 2) + ';\n', 'utf8');
  console.log('\n✅ ' + outPath + ' 갱신 완료 (version=' + data.version + ', 누적 날짜: ' + Object.keys(data.days).join(', ') + ')');
} else {
  console.log('\n--- days["' + targetDate + '"] 항목 (붙여넣기) ---');
  console.log(JSON.stringify(dayEntry, null, 2));
}
