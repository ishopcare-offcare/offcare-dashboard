/*
 * 메뉴등록 요청 채널(#oc팀_메뉴요청) 집계 스크립트 (날짜별 누적)
 * 사용법:
 *   집계만 출력:   node scripts/tally-menu.js <슬랙읽기결과파일> <YYYY-MM-DD>
 *   파일에 기록:   node scripts/tally-menu.js <슬랙읽기결과파일> <YYYY-MM-DD> --write menu-data.js
 * --write 하면 menu-data.js 의 days["YYYY-MM-DD"] 항목을 추가/갱신하고 version 을 +1 합니다.
 *
 * 이 채널은 전부 '메뉴등록' 한 카테고리이므로 counts 는 { menu: { 담당자: 건수 } } 형태로 적재합니다.
 * (원격집계(slack-data.js)와 동일한 counts.menu 구조 → 대시보드에서 병합하기 쉽게)
 */
const fs = require('fs');
const file = process.argv[2];
const targetDate = process.argv[3];
const writeIdx = process.argv.indexOf('--write');
const outPath = writeIdx > -1 ? process.argv[writeIdx + 1] : null;
if (!file || !targetDate) { console.error('usage: node tally-menu.js <file> <YYYY-MM-DD> [--write menu-data.js]'); process.exit(1); }

let t = fs.readFileSync(file, 'utf8');
t = t.replace(/\\u([0-9a-fA-F]{4})/g, (m, g) => String.fromCharCode(parseInt(g, 16))); // \uXXXX 디코드
t = t.replace(/\\\//g, '/'); // \/ 언이스케이프

// 원격집계와 동일한 담당자 매핑
const personMap = { '규빈':'김규빈','선유':'배선유','성현':'심성현','동욱':'김동욱','현기':'김현기','태양':'송태양','기범':'김기범','상원':'서상원','민석':'최민석','경림':'고경림','하림':'박하림' };
const NAMES = Object.keys(personMap).join('|');

const counts = { menu: {} };
const pending = [];
const seen = new Set();            // 같은 날 사업자번호/상호 중복(사진·문자 릴레이) 제거
let completed = 0, dupSkipped = 0, latestTime = '';

for (const b of t.split('=== Message from').slice(1)) {
  const at = (b.match(/at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/) || []);
  const date = at[1], time = at[2] || '';
  if (date !== targetDate) continue;

  const rm = b.match(/Reactions: (.*)/);
  const names = rm ? [...rm[1].matchAll(/([^,()]+?) \((\d+)\)/g)].map(x => x[1].trim()) : [];

  // 상호 / 매장명 (폼 형식이 여러 가지라 둘 다 허용)
  let store = ((b.match(/(?:상호|매장명)\s*[:：]\s*(.+)/) || [])[1] || '').trim().split('/')[0].trim();
  if (store.length > 30) store = store.slice(0, 30);
  const biz = ((b.match(/사업자\s*번?호?\s*[:：]\s*([\d\-]+)/) || [])[1] || '').replace(/-/g, '').trim();

  // 상호도 사업자번호도 없는 메시지(사진·문자·메일 릴레이 등 보조자료)는 건수에서 제외
  if (!store && !biz) continue;

  // 중복 이모지 → 중복요청, 집계 제외
  if (names.some(n => /^중복/.test(n))) { dupSkipped++; continue; }

  if (time > latestTime) latestTime = time;

  // 완료 담당자 (원격OOO)
  let emp = null;
  for (const n of names) { const pm = n.match(new RegExp('^원격(' + NAMES + ')$')); if (pm) { emp = personMap[pm[1]]; break; } }
  // 확인만 한 담당자 (OOO_확인 / OOO확인 / OOO_확인2 …)
  let confirmPerson = null;
  for (const n of names) { const cm = n.match(new RegExp('^(' + NAMES + ')_?확인.*$')); if (cm) { confirmPerson = personMap[cm[1]]; break; } }

  const key = biz || store;
  if (emp) {                                   // 담당자 배정 = 메뉴등록 완료
    if (seen.has(key)) { dupSkipped++; continue; }   // 같은 요청의 추가 메시지(사진 등) 중복 제거
    seen.add(key);
    counts.menu[emp] = (counts.menu[emp] || 0) + 1;
    completed++;
  } else if (confirmPerson) {                  // 확인만 되고 미완료 → 확인필요
    pending.push({ time, store, biz, handler: confirmPerson, reasons: ['확인 후 미완료'] });
  } else {                                     // 무반응 → 미착수
    pending.push({ time, store, biz, handler: null, reasons: ['미착수'] });
  }
}
pending.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

const dayEntry = { updatedAt: latestTime, counts, pending };

console.log('=== 메뉴등록 집계 결과 (' + targetDate + ') ===');
console.log('완료:', completed, '/ 확인필요·미착수:', pending.length, '/ 중복제외:', dupSkipped);
console.log('담당자별 완료:', JSON.stringify(counts.menu));

if (outPath) {
  let data = { version: 0, days: {} };
  if (fs.existsSync(outPath)) {
    const win = {};
    try { new Function('window', fs.readFileSync(outPath, 'utf8'))(win); if (win.MENU_DATA) data = win.MENU_DATA; } catch (e) {}
  }
  data.days = data.days || {};
  data.days[targetDate] = dayEntry;
  data.version = (data.version || 0) + 1;
  const header = '/*\n * 슬랙 #oc팀_메뉴요청 채널 집계 데이터 (날짜별 누적)\n * /메뉴등록집계 스킬이 매일 days["YYYY-MM-DD"] 항목을 추가/갱신합니다.\n */\n';
  fs.writeFileSync(outPath, header + 'window.MENU_DATA = ' + JSON.stringify(data, null, 2) + ';\n', 'utf8');
  console.log('\n✅ ' + outPath + ' 갱신 완료 (version=' + data.version + ', 누적 날짜: ' + Object.keys(data.days).join(', ') + ')');
} else {
  console.log('\n--- days["' + targetDate + '"] 항목 (붙여넣기) ---');
  console.log(JSON.stringify(dayEntry, null, 2));
}
