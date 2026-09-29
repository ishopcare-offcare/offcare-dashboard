/*
 * ============================================================
 *  브랜드 매칭 모듈 (허브 index.html · 고객사 client.html 공용)
 * ============================================================
 *  매장명에서 프랜차이즈 브랜드를 찾아내고 지점명을 분리한다.
 *  판별 기준은 brands.js 의 window.FRANCHISE_BRANDS.
 *
 *  두 페이지가 같은 규칙을 써야 숫자가 어긋나지 않으므로
 *  로직을 한 곳에 모아둔다. (예전엔 각자 복사본을 갖고 있었음)
 * ============================================================
 */
(function(global){
  'use strict';

  /* 법인 표기 제거 — '(주) 강창구 찹쌀진순대' → '강창구 찹쌀진순대' */
  function stripCorp(s){
    return String(s==null?'':s)
      .replace(/\((주|유|합|재)\)/g,' ')
      .replace(/㈜|주식회사|유한회사|합자회사|유한책임회사|사단법인|재단법인/g,' ')
      .replace(/\s+/g,' ').trim();
  }
  /* 비교용 키 — 공백·기호·대소문자 무시.
     '대단한 찜닭' 과 '대단한찜닭' 이 같은 브랜드로 묶이게 하는 핵심 */
  function keyOf(s){
    return stripCorp(s).replace(/[\s\-_·․.,'"’“”()\[\]{}&\/+]/g,'').toLowerCase();
  }
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

  /* 브랜드 인덱스 구축.
     · 브랜드 간: 긴 브랜드명이 먼저 매칭 ('강창구찹쌀진순대' > '강창구')
     · 브랜드 내: 긴 alias 가 먼저 매칭 ('카페드롭탑' > '드롭탑')
       — 안 하면 '카페드롭탑(평택터미널점)' 의 지점명이 '카페 (평택터미널점)' 이 된다 */
  function buildIndex(src){
    const idx = (src || global.FRANCHISE_BRANDS || []).map(b=>{
      const disp = [b.n].concat(b.a || []);
      return {
        name: b.n,
        tier: b.tier || 'B',   // 허브가 매장 수로 다시 판정한다 (index.html computeTiers)
        disp: disp,
        keys: disp.map(d=>({k:keyOf(d), d:d})).filter(x=>x.k.length>=2)
                  .sort((a,b)=>b.k.length-a.k.length),
      };
    }).filter(b=>b.keys.length);
    idx.forEach(b=>{ b.maxLen = Math.max.apply(null, b.keys.map(x=>x.k.length)); });
    idx.sort((a,b)=>b.maxLen-a.maxLen);
    return idx;
  }

  function matchBrand(idx, store){
    const k = keyOf(store);
    if(!k) return null;
    for(let i=0;i<idx.length;i++){
      const b = idx[i];
      for(let j=0;j<b.keys.length;j++){
        if(k.indexOf(b.keys[j].k) >= 0) return {brand:b, hit:b.keys[j].d};
      }
    }
    return null;
  }

  /* 매장명에서 브랜드 표기를 걷어낸 나머지 = 지점명.
     공백 유무가 달라도 지워지도록 글자 사이 구분자를 허용한다. */
  function branchOf(store, hitDisp){
    const s = stripCorp(store);
    let out = s;
    if(hitDisp){
      const chars = hitDisp.replace(/[\s\-_·]/g,'').split('');
      try{ out = s.replace(new RegExp(chars.map(reEsc).join('[\\s\\-_·]*'),'i'), ' '); }catch(e){}
    }
    out = out.replace(/\s+/g,' ').replace(/^[\s\-_·,]+|[\s\-_·,]+$/g,'').trim();
    out = out.replace(/^\((.+)\)$/,'$1').trim();   // '드롭탑(세정아울렛점)' → '세정아울렛점'
    return out || '본점';
  }

  /* 제외 목록 (매장명 부분일치 또는 사업자번호 10자리) */
  function buildExclude(src){
    const list = src || global.FRANCHISE_EXCLUDE || [];
    const biz = [], store = [];
    list.forEach(e=>{
      const d = String(e).replace(/\D/g,'');
      if(d.length === 10 && /^[\d-]+$/.test(String(e))) biz.push(d);
      else { const k = keyOf(e); if(k) store.push(k); }
    });
    return {
      test: function(storeName, bizNo){
        const b = String(bizNo==null?'':bizNo).replace(/\D/g,'');
        if(b && biz.indexOf(b) >= 0) return true;
        const k = keyOf(storeName);
        return store.some(ek=>k.indexOf(ek) >= 0);
      }
    };
  }

  global.BrandMatch = {
    stripCorp: stripCorp, keyOf: keyOf,
    buildIndex: buildIndex, matchBrand: matchBrand,
    branchOf: branchOf, buildExclude: buildExclude,
  };
})(window);
