/*
 * CX팀 스케줄 공유 시트 → 대시보드 당직근무 달력의 'CX팀' 버튼 데이터
 *   node scripts/fetch-cx-duty.js   →  cx-duty-data.js (window.CX_DUTY_DATA) 갱신
 * 환경변수: GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN
 *          CX_SHEET_ID(선택) · DUTY_MONTHS(선택, 기본 6 = 지난달~다섯달 뒤)
 *
 * 시트 구조([IS / CX] 스케줄 공유 시트):
 *  - 월별 탭 '2026-11 (CX)'. '_영지수정' · '_8/12' · '…의 사본' 같은 작업탭은 이름이 달라 자동 제외.
 *  - B열 '이름' 행이 헤더(D열부터 '11/1' 날짜), 그 아래 사람마다 한 줄씩 근무코드(9 · 6B/콜 · 휴 · 휴무 …).
 *  - 사람 줄 바로 아래 줄은 메모 줄 — '당직' · '희망' · '모' 등이 날짜 칸에 적힌다.
 *  - '포지션' / '휴가자' 행부터는 별도 표라 읽지 않는다.
 *
 * 당직일 = 주말 · 공휴일(출근자가 명단의 40% 이하인 날) · '당직' 표시가 있는 날.
 * 그날 근무코드가 있는 사람 전원을 담고, '당직' 표시된 사람은 duty:true 로 앞에 둔다.
 */
const fs = require('fs');

const SHEET_ID = process.env.CX_SHEET_ID || '1ev9dAXfFlN4Vxz4ZL7OiVkssJhtM44b1Ucb-bmXoznU';
const OUT = 'cx-duty-data.js';
const MONTHS = Number(process.env.DUTY_MONTHS || 6);

const pad = (n) => String(n).padStart(2, '0');
const OFF = /^(휴.*|방학|대휴|리프|경조|병가|결근)?$/;   // 빈칸 포함 — 근무 아님. '휴…' 는 오타(휴뮤 등)까지 쉬는 날로

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

(async () => {
  const H = { Authorization: 'Bearer ' + (await token()) };
  const mr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets(properties(sheetId,title))`, { headers: H });
  if (!mr.ok) throw new Error(`시트 메타 조회 실패 HTTP ${mr.status}`);
  const tabs = (await mr.json()).sheets.map((s) => s.properties.title);

  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const want = [];
  for (let i = -1; i < MONTHS - 1; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    want.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }

  const days = {};
  for (const { y, m } of want) {
    const title = tabs.find((t) => t.trim() === `${y}-${pad(m)} (CX)`);
    if (!title) continue;
    const vr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${title}'`)}?majorDimension=ROWS`, { headers: H });
    if (!vr.ok) { console.error(`  ⚠ [${title}] 값 조회 실패 HTTP ${vr.status} — 건너뜀`); continue; }
    const rows = (await vr.json()).values || [];
    const hi = rows.findIndex((r) => String((r || [])[1] || '').trim() === '이름');
    if (hi < 0) { console.error(`  ⚠ [${title}] '이름' 헤더 행 없음 — 건너뜀`); continue; }
    const hdr = rows[hi];
    const cols = [];   // [열, 'YYYY-MM-DD']
    hdr.forEach((v, c) => {
      const dm = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})$/);
      if (dm && +dm[1] === m) cols.push([c, `${y}-${pad(m)}-${pad(+dm[2])}`]);
    });

    // 사람 줄 수집 (다음 줄 = 메모 줄)
    const people = [];
    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r] || [], name = String(row[1] || '').trim();
      if (/^(포지션|휴가자)$/.test(name)) break;
      if (!name || name === '이름') continue;
      if (!cols.some(([c]) => String(row[c] || '').trim())) continue;   // 요일 줄 등 근무코드 없는 줄
      people.push({ name, row, note: rows[r + 1] && !String((rows[r + 1] || [])[1] || '').trim() ? rows[r + 1] : [] });
    }

    let hit = 0;
    for (const [c, ds] of cols) {
      const dow = new Date(ds + 'T00:00:00Z').getUTCDay();
      const list = [];
      for (const p of people) {
        const code = String(p.row[c] || '').trim(), note = String(p.note[c] || '').trim();
        if (OFF.test(code)) continue;
        list.push({ name: p.name, code, ...(note === '당직' ? { duty: true } : note ? { note } : {}) });
      }
      const isDutyDay = dow === 0 || dow === 6 || list.some((x) => x.duty) || list.length <= people.length * 0.4;
      if (!isDutyDay || !list.length) continue;
      list.sort((a, b) => (b.duty ? 1 : 0) - (a.duty ? 1 : 0));
      days[ds] = list; hit++;
    }
    console.log(`  [${title}] ${people.length}명 · 당직일 ${hit}일`);
  }

  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const data = {
    version: 1,
    updatedAt: `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`,
    url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    days,
  };
  let prev = null;
  if (fs.existsSync(OUT)) { const w = {}; try { new Function('window', fs.readFileSync(OUT, 'utf8'))(w); prev = w.CX_DUTY_DATA; } catch (e) {} }
  if (prev && JSON.stringify(prev.days) === JSON.stringify(days)) { console.log('변경 없음 — 파일 갱신 생략'); process.exit(0); }
  data.version = ((prev && prev.version) || 0) + 1;
  const header = '/*\n * CX팀 스케줄 공유 시트 → 당직근무 달력 CX팀 당직 데이터\n * scripts/fetch-cx-duty.js 가 GitHub Actions 에서 주기 갱신합니다. 원본은 구글시트입니다.\n */\n';
  fs.writeFileSync(OUT, header + 'window.CX_DUTY_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');
  console.log(`✅ ${OUT} 갱신: ${Object.keys(days).length}일 적재 (v${data.version})`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
