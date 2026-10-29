/*
 * 원격지원 만족도 조사 시트 → 대시보드 NPS 탭 데이터
 *   node scripts/fetch-nps.js   →  nps-data.js (window.NPS_DATA) 갱신
 * 환경변수: GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN · NPS_SHEET_ID(선택)
 *
 * 시트 구조(new 아이샵케어 원격지원 만족도 조사 대시보드):
 *  - 직원 이름 탭마다 구글폼 응답이 쌓인다. 열: 타임스탬프 · 이메일 · 매장명 · 전반 만족도 · 설명 이해도 · 태도 · 접속 편리 · 의견
 *    점수는 0~10.
 *  - 'dashboard' 탭은 시트 수식 요약인데 이름·응답 수가 빠져 있어 쓰지 않는다. 원본 응답 탭에서 직접 계산한다.
 *  - 첫 칸이 '타임스탬프' 인 탭만 응답 탭으로 본다('0' 같은 빈 작업탭은 이름이 숫자라 제외).
 *
 * 개인정보: 이메일은 버린다. 의견 속 전화번호·메일 주소는 가린다(매장명은 그대로 — 다른 데이터 파일과 같은 기준).
 */
const fs = require('fs');

const SHEET_ID = process.env.NPS_SHEET_ID || '1HEbamBqekvq6YTeUEncQs65ljlA3o2jbrqeM-MzgqUk';
const OUT = 'nps-data.js';
const pad = (n) => String(n).padStart(2, '0');

async function token() {
  const { GDRIVE_CLIENT_ID: id, GDRIVE_CLIENT_SECRET: sec, GDRIVE_REFRESH_TOKEN: rt } = process.env;
  if (!id || !sec || !rt) throw new Error('GDRIVE_* 환경변수 없음');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: sec, refresh_token: rt, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('토큰 갱신 실패: ' + (j.error_description || j.error || '?'));
  return j.access_token;
}

// '2026. 4. 9 오후 12:36:41' → '2026-04-09 12:36'
function parseTs(s) {
  const m = String(s || '').match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = +m[5];
  if (m[4] === '오후' && h < 12) h += 12;
  if (m[4] === '오전' && h === 12) h = 0;
  return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(h)}:${m[6]}`;
}
const score = (v) => { const n = parseFloat(String(v || '').trim()); return isFinite(n) && n >= 0 && n <= 10 ? n : null; };
const mask = (s) => String(s || '')
  .replace(/\b0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}\b/g, '[전화번호]')
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[메일]')
  .trim();

(async () => {
  const H = { Authorization: 'Bearer ' + (await token()) };
  const mr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=properties(title),sheets(properties(title))`, { headers: H });
  if (!mr.ok) throw new Error(`시트 메타 조회 실패 HTTP ${mr.status}`);
  const meta = await mr.json();
  const tabs = meta.sheets.map((s) => s.properties.title).filter((t) => t !== 'dashboard' && !/^\d+$/.test(t.trim()));

  const emps = {};
  for (const title of tabs) {
    const vr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${title}'`)}?majorDimension=ROWS`, { headers: H });
    if (!vr.ok) { console.error(`  ⚠ [${title}] 값 조회 실패 HTTP ${vr.status} — 건너뜀`); continue; }
    const rows = (await vr.json()).values || [];
    if (String((rows[0] || [])[0] || '').trim() !== '타임스탬프') continue;   // 응답 탭이 아님
    const list = [];
    for (const r of rows.slice(1)) {
      const d = parseTs(r[0]);
      if (!d) continue;
      list.push({ d, shop: mask(r[2]).slice(0, 40), s: [3, 4, 5, 6].map((i) => score(r[i])), c: mask(r[7]).slice(0, 600) });
    }
    list.sort((a, b) => (a.d < b.d ? 1 : -1));   // 최근 응답부터
    emps[title.trim()] = list;
    console.log(`  [${title}] 응답 ${list.length}건 · 의견 ${list.filter((x) => x.c).length}건`);
  }

  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const data = {
    version: 1,
    updatedAt: `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`,
    title: meta.properties.title,
    url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    emps,
  };
  let prev = null;
  if (fs.existsSync(OUT)) { const w = {}; try { new Function('window', fs.readFileSync(OUT, 'utf8'))(w); prev = w.NPS_DATA; } catch (e) {} }
  if (prev && JSON.stringify(prev.emps) === JSON.stringify(emps)) { console.log('변경 없음 — 파일 갱신 생략'); process.exit(0); }
  data.version = ((prev && prev.version) || 0) + 1;
  const header = '/*\n * 원격지원 만족도 조사 시트 → NPS 탭 데이터\n * scripts/fetch-nps.js 가 GitHub Actions 에서 주기 갱신합니다. 원본은 구글시트입니다.\n */\n';
  fs.writeFileSync(OUT, header + 'window.NPS_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');
  console.log(`✅ ${OUT} 갱신: 직원 ${Object.keys(emps).length}명 · 응답 ${Object.values(emps).reduce((a, l) => a + l.length, 0)}건 (v${data.version})`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
