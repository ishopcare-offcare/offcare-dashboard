/*
 * ============================================================
 *  장비 파서 (client.html '장비 조회' 탭 공용)
 * ============================================================
 *  현장방문 워크플로우의 '장비' 칸은 자유 텍스트다.
 *    '포스기 1EA + 프론트 1EA + 유선프린터기(주방용) 3EA + 금전함 1EA'
 *    '포스 프론트 유선프린터2대 금전함'
 *    'TS100E -> CPP_3000로 교체'
 *  여기서 장비 종류·수량·모델·기존보유 여부를 뽑고, 글 전체가
 *  설치 / 교체 / 회수 / AS / 점검 중 무엇인지 판정한다.
 *
 *  node 에서도 그대로 돌려 검증할 수 있게 window 에만 의존한다.
 *  규칙을 고치면 visit-data.js 전 건에 돌려서 확인할 것 (자유 텍스트라 한 건 고치면 다른 건이 깨진다).
 * ============================================================
 */
(function(global){
  'use strict';

  /* 장비 종류. 배열 순서 = 매칭 우선순위.
     긴 이름이 먼저 와야 한다 — '프론트캠' 을 '프론트' 가 먼저 먹으면 안 되므로
     매칭된 구간은 지우고 다음 종류를 찾는다. */
  const TYPES = [
    {key:'frontcam', name:'프론트캠',          re:/프론트\s*캠/gi},
    {key:'multipad', name:'멀티패드',          re:/멀티\s*패드/gi},
    {key:'keypad',   name:'배리어프리 키패드', re:/배리어\s*(?:프리|플리)\s*키\s*패드/gi},
    {key:'kiosk',    name:'키오스크',          re:/키오스크|kiosk/gi},
    {key:'monitor',  name:'듀얼모니터',        re:/듀얼\s*모니터/gi},
    /* '벽브라캣' 의 '캣' 을 단말기로 읽지 않도록 한글 사이에 낀 캣은 제외 */
    {key:'cat',      name:'CAT 단말기',        re:/cat\s*단말기|캣\s*단말기|\bcat\b|(?<![가-힣])캣(?![가-힣])|(?:타사\s*)?단말기/gi},
    {key:'wprinter', name:'무선프린터',        re:/무선\s*프린터|무프/gi},
    {key:'printer',  name:'유선프린터',        re:/(?:유선|주방|홀)?\s*프린터기?|유프/gi},
    {key:'drawer',   name:'금전함',            re:/금전\s*한?함/gi},
    {key:'scanner',  name:'바코드스캐너',      re:/(?:바코드\s*)?스캐너/gi},
    {key:'tablet',   name:'태블릿',            re:/태블릿|kds/gi},
    {key:'terminal', name:'터미널',            re:/터미널/gi},
    {key:'front',    name:'프론트',            re:/프론트|트론트/gi},
    /* 아펙사·APEXA 는 모델(MODELS)로만 잡는다 — 'APEXA15' 의 15 를 수량으로 읽기 때문 */
    {key:'pos',      name:'포스',              re:/포스기?|\bpos\b/gi},
    {key:'pc',       name:'PC·노트북',         re:/개인\s*(?:소유)?\s*(?:pc|컴퓨터)|자체\s*pc|노트북|컴퓨터|\bpc\b/gi},
  ];
  /* 모델명 → 장비 종류. 종류 단어가 같이 있으면 모델로 붙고, 모델만 있으면 그 장비 1대로 센다 */
  const MODELS = [
    {type:'printer', re:/\b(ts-?\s?\d{3,4}\w?|cpp[-_ ]?\d{3,4}|dk\s?9300)\b/gi},
    {type:'cat',     re:/\b(kis-?\d{3,4}|nc\d{4}|[ne]250|ssrp-?\d{4})\b/gi},
    {type:'kiosk',   re:/\b(t6d)\b/gi},
    {type:'scanner', re:/\b(tsk-?\d{3,4})\b/gi},
    {type:'pos',     re:/(apexa\s?\d*|아펙사|퍼스트포스|하나시스(?:\s*플러스)?|아임유포스|메이트\s*포스)/gi},
  ];
  const TYPE_MAP = Object.fromEntries(TYPES.map(t=>[t.key, t]));

  /* 길이를 보존해 공백으로 덮는다 — 위치가 어긋나면 수량을 엉뚱한 장비에 붙인다 */
  const blank = (s, re) => s.replace(re, m => ' '.repeat(m.length));

  /* 매칭 직후의 수량. '포스기 2EA(메인/오더)', '유선프린터2대', '프론트1', '유선프린터기(주방용) 3EA'
     괄호 하나는 건너뛰되, 괄호 안 숫자(KIS-1421 같은 모델)는 수량으로 읽지 않는다. */
  function qtyAfter(s){
    const t = s.replace(/^\s*(?:기\s*)?\((?:[^()]|\([^()]*\))*\)/, '');
    const m = t.match(/^\s*[x×]?\s*(\d{1,2})\s*(?:ea|대|개|set)?(?![\d\-])/i);
    return m ? +m[1] : 1;
  }

  function parseItems(text){
    /* 전처리
       · '토스포스'(프로그램)는 장비가 아니다
       · '포스기세트(포스+프론트+…)' 의 '포스기세트' 는 괄호 안 구성품의 이름표라 따로 세지 않는다 */
    let src = String(text == null ? '' : text);
    src = blank(src, /토스\s*_?\s*포스(?:\s*프로그램)?/gi);
    src = blank(src, /[가-힣A-Za-z]*\s*세트\s*(?=\()/gi);
    MODELS.forEach(md => { md.re.lastIndex = 0; });

    /* 모델명 안의 '포스'(퍼스트포스·아임유포스·메이트 포스)를 장비 단어로 다시 세지 않게 가린다 */
    let work = blank(src, MODELS.find(md => md.type === 'pos').re);
    MODELS.forEach(md => { md.re.lastIndex = 0; });
    const hits = [];
    TYPES.forEach(function(t){
      t.re.lastIndex = 0;
      const mine = [];
      let m;
      while((m = t.re.exec(work))){
        if(!m[0].trim()){ t.re.lastIndex++; continue; }
        const lead = m[0].length - m[0].replace(/^\s+/, '').length;   // '(?:유선)?\s*프린터' 앞 공백
        mine.push({type:t.key, at:m.index + lead, end:m.index + m[0].length});
      }
      /* 찾은 구간은 지워서 짧은 이름이 다시 먹지 못하게 한다 */
      mine.forEach(h=>{ work = work.slice(0,h.at) + ' '.repeat(h.end-h.at) + work.slice(h.end); });
      hits.push.apply(hits, mine);
    });
    hits.sort((a,b)=>a.at-b.at);

    const items = {};
    const get = type => items[type] || (items[type] = {type:type, name:TYPE_MAP[type].name, qty:0, models:[], existing:false});
    /* 장비 바로 뒤 괄호가 덮는 구간. 그 안의 같은 종류 단어는 설명이다
       ('태블릿 1EA(KDS용)' 의 KDS, '포스기(메인/오더 포스)' 의 포스) — 세지 않는다 */
    const covered = {};
    hits.forEach(function(h, i){
      const next = i+1 < hits.length ? hits[i+1].at : src.length;
      /* 다른 장비 이름에 딱 붙은 단어는 수식어다 ('키오스크배리어프리키패드' 의 키오스크) — 세지 않는다 */
      if(i+1 < hits.length && next === h.end) return;
      if(covered[h.type] && h.at < covered[h.type]) return;
      const pm = src.slice(h.end).match(/^\s*(?:\d{1,2}\s*(?:ea|대|개)?\s*)?(?:기\s*)?\((?:[^()]|\([^()]*\))*\)/i);
      if(pm) covered[h.type] = h.end + pm[0].length;
      const tail = src.slice(h.end, next);
      const it = get(h.type);
      it.qty += qtyAfter(tail);
      /* 기존 보유: 바로 뒤 괄호 '(기존 보유)' · '(점주보유)' 또는 바로 앞 '기존 ' · '개인소유 ' · '매장 보유 ' */
      const paren = pm ? pm[0].match(/\(([\s\S]*)\)/) : null;   // '프론트 1EA(기존 보유)' 처럼 수량 뒤 괄호도
      if((paren && /기존|기보유|보유|소유/.test(paren[1]))
         || /(?:기존|보유|소유)\s*$/.test(src.slice(Math.max(0, h.at-6), h.at))) it.existing = true;
    });
    MODELS.forEach(function(md){
      let m;
      while((m = md.re.exec(src))){
        const it = get(md.type);
        if(!it.qty) it.qty = 1;
        const mdl = m[1].toUpperCase().replace(/\s+/g,'');
        if(it.models.indexOf(mdl) < 0) it.models.push(mdl);
      }
    });
    return TYPES.map(t=>items[t.key]).filter(it=>it && it.qty > 0);
  }

  /* 글 전체의 성격. kind 는 워크플로우의 요청 유형(설치/AS/기타) */
  function eventType(kind, text){
    const t = String(text || '');
    if(/회수|철거/.test(t))                    return '회수';
    if(/교체|->|→/.test(t))                    return '교체';
    if(kind === 'AS')                           return 'AS';
    if(/점검|가결제|재온보딩|환경/.test(t))     return '점검';
    if(kind === '설치')                         return '설치';
    return '기타';
  }

  /* 교체 글에서 '이전 → 새' 모델을 뽑는다 ('TS100E -> CPP_3000로 교체') */
  function replacePair(text){
    const m = String(text || '').match(/([A-Za-z0-9_\-]+)\s*(?:->|→|에서)\s*([A-Za-z0-9_\-]+)/);
    return m ? {from:m[1].toUpperCase(), to:m[2].toUpperCase()} : null;
  }

  /* 원격 AS·온보딩 요청문에서 어떤 장비 얘기인지만 본다 (수량은 의미 없음) */
  function mentions(text){
    return parseItems(text).map(it => it.type);
  }

  global.EquipParse = {
    TYPES:TYPES, TYPE_MAP:TYPE_MAP,
    parseItems:parseItems, eventType:eventType, replacePair:replacePair, mentions:mentions,
  };
})(window);
