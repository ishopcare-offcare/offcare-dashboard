/*
 * 원격 당직시트 → 대시보드 당직근무 달력 데이터
 *   node scripts/fetch-duty.js   →  duty-data.js (window.DUTY_DATA) 갱신
 * 환경변수: GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN
 *          DUTY_SHEET_ID(선택) · DUTY_MONTHS(선택, 기본 6 = 지난달~다섯달 뒤)
 *
 * 시트가 유일한 원본이다(사용자 결정). 대시보드에서 손으로 고친 값은 이 파일이 덮는다.
 *
 * 시트 구조(2026 원격당직시트[C]):
 *  - 탭이 '2026년 8~9월' 처럼 두 달씩 묶여 있다. 대상 월을 포함하는 탭을 이름으로 찾아 읽는다.
 *    ('X' 같은 작업탭, '…의 사본' 은 제외 — 값이 어긋나 있어 원본으로 쓰면 안 된다)
 *  - 달력 격자: 날짜 셀('2026. 8. 1') 바로 아래 칸에 배정이 줄바꿈으로 들어간다.
 *  - 배정 표기 두 가지가 섞여 있다:
 *      이름(주)/이름(오)/이름(야)   ← 근무구분
 *      이름(9)/이름(4.5)/이름(8)    ← 근무시간(주간9·오후4.5·야간8)
 *  - 같은 탭에 다른 달 블록(2026.2, 2025.12 등)이 잔재로 남아 있어, 대상 월 범위 밖 날짜는 버린다.
 */
const fs = require('fs');

const SHEET_ID = process.env.DUTY_SHEET_ID || '1Gto8lYR1Nvh8M_YpcuBs1DG2LiX7b0iMUm2YeN5-2wM';
const OUT = 'duty-data.js';
const MONTHS = Number(process.env.DUTY_MONTHS || 6);   // 지난달부터 앞으로 몇 달치를 읽을지

const pad = (n) => String(n).padStart(2, '0');
const DATE_RE = /^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/;

// 배정 한 줄 → {slot, name} · 판별 불가면 null
const SLOT_BY_MARK = { '주': 'day', '오': 'aft', '야': 'nit', '9': 'day', '4.5': 'aft', '8': 'nit' };
function parseLine(line) {
  const m = String(line).trim().match(/^(.+?)\s*\(\s*([^)]+?)\s*\)\s*$/);
  if (!m) return null;
  const name = m[1].trim();
  const slot = SLOT_BY_MARK[m[2].trim()];
  if (!name || !slot) return null;
  return { slot, name };
}

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

// 탭 이름에서 담당 연·월 범위를 뽑는다. '2026년 8~9월' · '2026년 10월~12월 (작업중)' → {y:2026, months:[...]}
function tabRange(title) {
  if (/사본|복사|copy/i.test(title)) return null;               // 사본 탭은 원본으로 쓰지 않는다
  const m = title.match(/(\d{4})\s*년\s*(\d{1,2})\s*월?\s*(?:~|-|–)\s*(\d{1,2})\s*월/);
  if (m) { const a = +m[2], b = +m[3]; const out = []; for (let x = a; x <= b; x++) out.push(x); return { y: +m[1], months: out }; }
  const s = title.match(/(\d{4})\s*년\s*(\d{1,2})\s*월/);
  if (s) return { y: +s[1], months: [+s[2]] };
  return null;
}

(async () => {
  const tok = await token();
  const H = { Authorization: 'Bearer ' + tok };

  const mr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=properties(title),sheets(properties(sheetId,title))`, { headers: H });
  if (!mr.ok) throw new Error(`시트 메타 조회 실패 HTTP ${mr.status}`);
  const meta = await mr.json();
  const tabs = meta.sheets.map((s) => ({ title: s.properties.title, gid: s.properties.sheetId, range: tabRange(s.properties.title) }))
    .filter((t) => t.range);
  console.log(`시트: ${meta.properties.title} · 월별 탭 ${tabs.length}개 (${tabs.map((t) => t.title).join(', ')})`);

  // 대상 월 목록 = 지난달부터 MONTHS 개월
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const want = [];
  for (let i = -1; i < MONTHS - 1; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    want.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }
  const need = [...new Set(want.map((w) => tabs.find((t) => t.range.y === w.y && t.range.months.includes(w.m))?.title).filter(Boolean))];
  console.log(`대상 월: ${want.map((w) => w.y + '-' + pad(w.m)).join(', ')}`);
  console.log(`읽을 탭: ${need.join(', ') || '(없음)'}`);

  const days = {};
  let cells = 0, unknown = 0, dropped = 0;
  for (const title of need) {
    const vr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${title}'`)}?majorDimension=ROWS`, { headers: H });
    if (!vr.ok) { console.error(`  ⚠ [${title}] 값 조회 실패 HTTP ${vr.status} — 건너뜀`); continue; }
    const rows = (await vr.json()).values || [];
    const range = tabs.find((t) => t.title === title).range;
    let hit = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [], next = rows[r + 1] || [];
      for (let c = 0; c < row.length; c++) {
        const dm = String(row[c] || '').trim().match(DATE_RE);
        if (!dm) continue;
        const y = +dm[1], mo = +dm[2], da = +dm[3];
        if (y !== range.y || !range.months.includes(mo)) continue;   // 잔재로 남은 다른 달 블록 제외
        const raw = String(next[c] || '').trim();
        if (!raw) continue;
        const ds = `${y}-${pad(mo)}-${pad(da)}`;
        const rec = days[ds] || {};
        const etc = [];
        for (const line of raw.split('\n').map((x) => x.trim()).filter(Boolean)) {
          const p = parseLine(line);
          if (p) { if (!rec[p.slot]) rec[p.slot] = p.name; continue; }
          // 한 글자 축약('서','공' 등)은 담당자인지 확정할 수 없어 아예 넣지 않는다(사용자 결정).
          // 잘못 표시하면 실제로 연락이 안 가는 문제라, 비워두는 쪽이 낫다.
          if (line.length <= 1) { dropped++; continue; }
          etc.push(line); unknown++;                                 // 행사·메모성 텍스트(컴포즈 설치 등)
        }
        if (etc.length) rec.inst = etc.join(' / ').slice(0, 60);
        if (Object.keys(rec).length) { days[ds] = rec; hit++; cells++; }
      }
    }
    console.log(`  [${title}] 배정 ${hit}일`);
  }

  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const data = {
    version: 1,
    updatedAt: `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`,
    sheet: SHEET_ID,
    url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    days,
  };
  let prev = null;
  if (fs.existsSync(OUT)) { const w = {}; try { new Function('window', fs.readFileSync(OUT, 'utf8'))(w); prev = w.DUTY_DATA; } catch (e) {} }
  if (prev && JSON.stringify(prev.days) === JSON.stringify(days)) { console.log('변경 없음 — 파일 갱신 생략'); process.exit(0); }
  data.version = ((prev && prev.version) || 0) + 1;
  const header = '/*\n * 원격 당직시트 → 당직근무 달력 데이터\n * scripts/fetch-duty.js 가 GitHub Actions 에서 주기 갱신합니다. 원본은 구글시트입니다.\n */\n';
  fs.writeFileSync(OUT, header + 'window.DUTY_DATA = ' + JSON.stringify(data, null, 1) + ';\n', 'utf8');
  console.log(`✅ ${OUT} 갱신: ${Object.keys(days).length}일 적재 (v${data.version})` +
              `${unknown ? ` · 행사/메모 ${unknown}줄` : ''}${dropped ? ` · 한글자 축약 ${dropped}줄 제외` : ''}`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
