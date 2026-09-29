/*
 * ============================================================
 *  프랜차이즈 고객사 레지스트리
 * ============================================================
 *  새 프랜차이즈 관리를 맡게 되면 아래 CLIENTS 배열에
 *  블록 하나만 추가하면 전용 대시보드가 개설됩니다.
 *  (client.html 은 손댈 필요 없습니다)
 *
 *  ── 새 고객사 추가 절차 ────────────────────────────────────
 *  1) data/<slug>.js 파일을 만든다 (data/compose.js 를 복사해서 시작)
 *  2) 아래 CLIENTS 에 블록 추가
 *  3) brands.js 에 { n:'브랜드명' } 추가 → 프랜차이즈 허브 집계에도 잡힘
 *  끝. 허브(index.html)의 브랜드명을 누르면 바로 그 대시보드로 이동합니다.
 *
 *  ── 계약 고객사 vs 일반 브랜드 ─────────────────────────────
 *  · CLIENTS 에 등록 + dataFile 있음 → "계약 고객사" 모드
 *      전용 원장(data/*.js)을 읽고 8종 카테고리로 집계, 월간 보고서·엑셀 제공
 *  · CLIENTS 에 없음 → "일반 브랜드" 모드
 *      ../slack-data.js 의 기존 원격 집계를 브랜드명으로 걸러 보여줌
 *      (방문AS·단순문의·세금계산서는 기존 파이프라인에 분류가 없어 표시 안 됨)
 * ============================================================
 */

window.FRANCHISE_CLIENTS = [
  {
    slug       : 'compose',
    brand      : '컴포즈커피',          // brands.js 의 브랜드명과 정확히 일치시켜야 함
    icon       : '☕',
    startDate  : '2026-08-15',          // 관리 개시일. 이전 월은 집계 대상 아님
    provider   : 'iShopCare 원격파트',
    reportTitle: 'AS지원 월간 리포트',
    dataFile   : 'data/compose.js',     // 이 파일이 window.CLIENT_DATA['compose'] 를 채운다
    note       : '2026-08-15 관리 개시',
  },

  /* ── 새 고객사 예시 (주석 해제 후 값만 바꾸면 됩니다) ──────
  {
    slug       : 'dropTop',
    brand      : '드롭탑',
    icon       : '🥤',
    startDate  : '2026-10-01',
    provider   : 'iShopCare 원격파트',
    reportTitle: '원격 지원 월간 리포트',
    dataFile   : 'data/droptop.js',
    note       : '',
  },
  ──────────────────────────────────────────────────────── */
];

/* ── A등급 브랜드 = 계약 고객사로 간주 ─────────────────────────
 *  brands.js 에서 tier:'A'(지점 2곳 이상 확인된 확정 브랜드)인 브랜드는
 *  위에 따로 적지 않아도 계약 고객사로 자동 등록된다.
 *  → 전용 대시보드(계약 모드) · 월간 보고서 · 엑셀이 그대로 열린다.
 *
 *  전용 원장 파일(dataFile)이 없으므로 원장은 ../slack-data.js 에서
 *  그 브랜드 건만 골라 즉석으로 만든다 (ledger:'slack').
 *  개별 설정(개시일·아이콘·원장 파일)이 필요해지면 위 CLIENTS 에 블록을
 *  직접 추가하면 된다 — 직접 등록한 블록이 항상 우선한다.
 *
 *  ※ brands.js 가 이 파일보다 먼저 로드돼야 한다.
 * ───────────────────────────────────────────────────────── */
(function(){
  const norm = s => String(s).replace(/\s+/g,'').toLowerCase();
  const have = new Set(window.FRANCHISE_CLIENTS.map(c=>norm(c.brand)));
  (window.FRANCHISE_BRANDS || []).forEach(b=>{
    if((b.tier || 'A') !== 'A' || have.has(norm(b.n))) return;
    window.FRANCHISE_CLIENTS.push({
      slug       : b.n,
      brand      : b.n,
      icon       : '🏢',
      startDate  : '',
      provider   : 'iShopCare 원격파트',
      reportTitle: '원격 지원 월간 리포트',
      ledger     : 'slack',             // dataFile 대신 slack-data.js 에서 원장 생성
      auto       : true,                // A등급 자동 등록
      note       : 'A등급 · 계약 고객사 간주',
    });
  });
})();

/*
 * 카테고리 체계
 *  contract : 계약 고객사 전용 8종. 여기에 한 줄 추가하면 표 열·차트·보고서 행·엑셀 시트가 전부 따라 늘어남
 *  slack    : ../slack-data.js 6종 + 현장방문(visit-data.js 에서 합침).
 *             그 밖으로 늘리면 안 됨(데이터에 없는 분류가 생김)
 * 특정 고객사만 다른 체계를 쓰려면 그 CLIENTS 블록에 cats: [...] 를 넣어 덮어쓸 수 있습니다.
 */
window.FRANCHISE_TAXONOMY = {
  contract: [
    { key:'as',         name:'원격AS',         color:'#34c759' },
    { key:'visit',      name:'현장방문',       color:'#ff3b30', onsite:true },
    { key:'inquiry',    name:'단순문의',       color:'#0071e3' },
    { key:'tax',        name:'세금계산서발급', color:'#af52de' },
    { key:'onboarding', name:'온보딩',         color:'#5e5ce6' },
    { key:'transfer',   name:'명의변경',       color:'#ff9500' },
    { key:'menu',       name:'메뉴등록',       color:'#00c7be' },
    { key:'terminate',  name:'해지·철거',      color:'#8e8e93' },
  ],
  slack: [
    { key:'onboarding', name:'온보딩',   color:'#5e5ce6' },
    { key:'as',         name:'AS',       color:'#34c759' },
    { key:'visit',      name:'현장방문', color:'#ff3b30', onsite:true },
    { key:'transfer',   name:'명의변경', color:'#ff9500' },
    { key:'menu',       name:'메뉴등록', color:'#00c7be' },
    { key:'delivery',   name:'배달',     color:'#0071e3' },
    { key:'extern',     name:'외주',     color:'#8e8e93' },
  ],
};

/* 인입 경로 */
window.FRANCHISE_INTAKES = [
  { key:'online',  name:'온라인',   color:'#0071e3', desc:'슬랙·메신저·웹 접수' },
  { key:'phone',   name:'유선',     color:'#ff9500', desc:'전화 인입' },
  { key:'offline', name:'오프라인', color:'#ff9500', desc:'유선 등 오프라인 인입' },
  { key:'hq',      name:'본사경유', color:'#5e5ce6', desc:'프랜차이즈 본사 전달' },
  { key:'unknown', name:'미기재',   color:'#aeaeb4', desc:'경로 미기재' },
];

/* 처리 상태 */
window.FRANCHISE_STATUSES = [
  { key:'done',    name:'처리완료', color:'#34c759' },
  { key:'pending', name:'진행중',   color:'#ff9500' },
  { key:'hold',    name:'보류',     color:'#ff3b30' },
];

/* ── 현장방문 수행 주체 ────────────────────────────────────
 *  방문 건의 '설치 담당 배정' 에는 자사 직원 이름과 외주 업체명이 섞여 들어온다.
 *  이름 생김새로 추측하면 틀리므로 자사 직원만 명시하고 나머지를 외주로 본다.
 *  ※ 새 직원이 들어오면 여기에 이름을 추가해야 외주로 잘못 잡히지 않는다.
 * ───────────────────────────────────────────────────────── */
window.FRANCHISE_INHOUSE = [
  '이성철', '김명석', '김주진', '공명현', '박성민',
  '강승철', '홍남수', '황선혁', '유동건',
];

/* 담당자 이름 → '자사직원' | '외주' | '미지정' */
window.visitBy = function(assignee){
  const v = String(assignee == null ? '' : assignee).trim();
  if(!v) return '미지정';
  /* 스레드에서 잘못 긁힌 문구는 담당자로 치지 않는다 (예: '분께 확인요청중 .') */
  if(/요청|확인|문의|대기|미정/.test(v)) return '미지정';
  return (window.FRANCHISE_INHOUSE || []).indexOf(v) >= 0 ? '자사직원' : '외주';
};

/* 브랜드명 → 고객사 조회 (client.html·index.html 공용) */
window.findClient = function(brand){
  if(!brand) return null;
  const k = String(brand).replace(/\s+/g,'').toLowerCase();
  return (window.FRANCHISE_CLIENTS||[]).find(c=>
    String(c.brand).replace(/\s+/g,'').toLowerCase() === k || c.slug === brand) || null;
};
