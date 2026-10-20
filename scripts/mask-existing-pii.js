#!/usr/bin/env node
/*
 * 이미 커밋된 공개 데이터 파일을 pii-mask 규칙으로 한 번에 가린다 (2026-10-20 이관용).
 * 생성 스크립트들은 이제 쓸 때 스스로 가리므로, 평소엔 돌릴 일이 없다.
 * 몇 번을 돌려도 결과가 같다.
 *
 *   node scripts/mask-existing-pii.js
 *
 * franchise/data/compose.js 와 done-backfill.js 는 여기서 가린 원본으로 다시 만든다:
 *   node scripts/tally-compose.js && node scripts/build-done-backfill.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { maskDeep, maskText, maskKeyTail } = require('./pii-mask');

const ROOT = path.join(__dirname, '..');
const P = f => path.join(ROOT, f);

/* header + 'window.X = ' + JSON.stringify(data, null, indent) + ';\n' 꼴 */
function jsData(file, name, indent){
  if(!fs.existsSync(P(file))) return console.log('없음  ' + file);
  const src = fs.readFileSync(P(file), 'utf8');
  const mark = 'window.' + name + ' = ';
  const i = src.indexOf(mark);
  if(i < 0) throw new Error(file + ': ' + mark + ' 를 찾지 못했습니다');
  const w = {};
  new Function('window', src)(w);
  const out = src.slice(0, i) + mark + JSON.stringify(maskDeep(w[name]), null, indent) + ';\n';
  write(file, src, out);
}

/* 한 줄에 레코드 하나씩 '  {...},' 로 쓰인 파일 (visit-data.js) */
function jsonLines(file){
  if(!fs.existsSync(P(file))) return console.log('없음  ' + file);
  const src = fs.readFileSync(P(file), 'utf8');
  const out = src.replace(/^(\s*)(\{.*\})(,?)(\r?)$/gm, (m, sp, json, comma, cr) => {
    try { return sp + JSON.stringify(maskDeep(JSON.parse(json))) + comma + cr; } catch(e){ return m; }
  });
  write(file, src, out);
}

function emojiTimes(file){
  if(!fs.existsSync(P(file))) return console.log('없음  ' + file);
  const src = fs.readFileSync(P(file), 'utf8');
  const j = JSON.parse(src);
  j.items = Object.fromEntries(Object.entries(j.items || {}).map(([k, v]) => [maskKeyTail(k), v]));
  write(file, src, JSON.stringify(j));
}

/* 표·CSV 처럼 통째 텍스트 — 사업자번호 칸은 검증번호로, 요청내용 속 주소는 주소 규칙으로 */
function plain(file){
  if(!fs.existsSync(P(file))) return console.log('없음  ' + file);
  const src = fs.readFileSync(P(file), 'utf8');
  write(file, src, maskText(src));
}

function write(file, before, after){
  if(before === after) return console.log('그대로 ' + file);
  fs.writeFileSync(P(file), after, 'utf8');
  console.log('가림  ' + file);
}

jsData('slack-data.js', 'SLACK_DATA', 2);
jsData('menu-requests.js', 'MENU_REQUESTS', 1);
jsonLines('visit-data.js');
emojiTimes('share/emoji-times.json');
plain('share/booking-report.html');
for(const f of process.argv.slice(2)) plain(f);     // 추가 파일(예: CSV)은 인자로
