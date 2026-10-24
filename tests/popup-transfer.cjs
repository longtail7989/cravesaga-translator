'use strict';
// MOCKED UI protocol tests. No native Chrome API or real save picker is exercised.
// Run from the repository: node --test tests/popup-transfer.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..'),'options.js'),'utf8');
const HEADER={format:'crave-ai-translation-cache',version:2,identity:'source-v3',exportedAt:'2026-10-24T00:00:00.000Z',appVersion:'0.2.4'};
const ENTRY={source:'原文𐐀',context:'screen metadata',target:'한국어',text:'번역𐐀',createdAt:1,updatedAt:2};
function fixture(){
  const nodes=new Map(), calls=[], confirmations=[], listeners={}, writes=[];
  const state={confirm:true,closed:false,aborted:false,pickerBeforeMessages:false};
  function node(id){if(!nodes.has(id))nodes.set(id,{id,value:'',type:'text',checked:false,disabled:false,hidden:false,dataset:{},textContent:'',handlers:{},classList:{toggle(){},remove(){},add(){}},setAttribute(){},removeAttribute(){},addEventListener(k,f){this.handlers[k]=f},focus(){},replaceChildren(){}});return nodes.get(id)}
  let responder=m=>({ok:true,token:'session',staged:m.entries?.length,imported:1,skipped:0,cacheCount:1});
  const ctx={console,TextDecoder,TextEncoder,Blob,URL,Intl,Date,Number,Object,Error,setTimeout,CustomEvent:class{},Event:class{},window:{confirm(t){confirmations.push(t);return state.confirm},addEventListener(k,f){const previous=listeners[k];listeners[k]=previous?(...args)=>{previous(...args);f(...args)}:f}},document:{getElementById:node,querySelectorAll(){return[]},dispatchEvent(){},createElement(){return{remove(){},click(){}}},body:{append(){}}},chrome:{runtime:{sendMessage(m,cb){calls.push(m);const r=responder(m);if(r)cb(r)}}}};
  ctx.globalThis=ctx;
  assert(source.includes('  init();'),'test harness init anchor');
  vm.runInNewContext(source.replace('  init();','  globalThis.harness={importStream,importSmallLegacy,portableEntry,ready(){loaded=true},markSessions(){activeImportToken="active-import";activeExportToken="active-export"}};'),ctx,{filename:'options.js'});
  ctx.harness.ready();
  function picker(){ctx.window.showSaveFilePicker=()=>{state.pickerBeforeMessages=calls.length===0;return Promise.resolve({createWritable:async()=>({write:async s=>writes.push(s),close:async()=>{state.closed=true},abort:async()=>{state.aborted=true}})})}}
  return {node,calls,confirmations,listeners,writes,state,ctx,picker,api:ctx.harness,respond(fn){responder=fn}};
}
function ndjson(entries=[ENTRY],footer={end:true,count:entries.length},header=HEADER){return [header,...entries,footer].map(JSON.stringify).join('\n')+'\n'}
function splitFile(text,size=7){const bytes=new TextEncoder().encode(text);let offset=0;return{size:bytes.length,text:async()=>text,stream(){return new ReadableStream({pull(c){if(offset>=bytes.length)c.close();else{const end=Math.min(offset+size,bytes.length);c.enqueue(bytes.slice(offset,end));offset=end}}})}}}
test('[MOCKED] UTF-8 split parsing, <=250 batches, metadata retained and footer expectedCount',async()=>{
  const f=fixture(),entries=Array.from({length:601},(_,i)=>({...ENTRY,source:ENTRY.source+i,apiKey:'MUST-NOT-EXPORT',endpoint:'secret'}));
  await f.api.importStream(splitFile(ndjson(entries),3),'replace');
  const batches=f.calls.filter(x=>x.type==='IMPORT_BATCH');
  assert.deepEqual(batches.map(x=>x.entries.length),[250,250,101]);
  assert.equal(batches[0].entries[0].source,ENTRY.source+'0');
  assert.equal(batches[0].entries[0].context,ENTRY.context);
  assert.equal(batches[0].entries[0].apiKey,undefined);assert.equal(batches[0].entries[0].endpoint,undefined);
  assert.equal(f.calls.at(-1).type,'IMPORT_COMMIT');assert.equal(f.calls.at(-1).expectedCount,601);
});
test('[MOCKED] large valid-size rows flush by UTF-8 message bytes below 1 MiB',async()=>{
  const f=fixture(),entries=Array.from({length:48},(_,i)=>({...ENTRY,source:'原'.repeat(7998)+String(i).padStart(2,'0'),text:'번'.repeat(8000)}));
  await f.api.importStream(splitFile(ndjson(entries),65521),'merge');
  const batches=f.calls.filter(x=>x.type==='IMPORT_BATCH');
  assert.equal(batches.length,3);
  assert.equal(batches.reduce((sum,x)=>sum+x.entries.length,0),entries.length);
  for(const batch of batches){assert(batch.entries.length<=250);assert(Buffer.byteLength(JSON.stringify(batch),'utf8')<=1024*1024)}
  assert.equal(f.calls.at(-1).type,'IMPORT_COMMIT');assert.equal(f.calls.at(-1).expectedCount,entries.length);
});
test('[MOCKED] invalid header never starts; malformed/footer/trailing/truncated input aborts without commit',async()=>{
  const invalid=fixture();await assert.rejects(invalid.api.importStream(splitFile(ndjson([ENTRY],{end:true,count:1},{...HEADER,identity:'bad'})),'replace'));assert(!invalid.calls.some(x=>x.type==='IMPORT_START'));
  for(const text of [ndjson([ENTRY],{end:true,count:2}),ndjson()+'{}\n',ndjson().replace('"text":"번역𐐀"','"text":INVALID'),JSON.stringify(HEADER)+'\n'+JSON.stringify(ENTRY)+'\n']){
    const f=fixture();await assert.rejects(f.api.importStream(splitFile(text),'replace'));assert(!f.calls.some(x=>x.type==='IMPORT_COMMIT'));assert.equal(f.calls.at(-1).type,'IMPORT_ABORT');
  }
});
test('[MOCKED] legacy v1/v2 small fallback confirmed, large whole JSON rejected before reading',async()=>{
  for(const version of [1,2]){const f=fixture();await f.api.importStream(splitFile(JSON.stringify({...HEADER,version,entries:[ENTRY]})),'merge');assert.equal(f.calls.at(-1).type,'IMPORT_CACHE');assert(f.confirmations.length)}
  const f=fixture();await assert.rejects(f.api.importSmallLegacy({size:33554433,text(){throw Error('must not read')}},'merge'));assert.equal(f.calls.length,0);
});
test('[MOCKED] direct-click picker precedes messages; inexact stored count permits legacy exclusion/concurrent changes',async()=>{
  const f=fixture();f.picker();f.respond(m=>m.type==='EXPORT_START'?{ok:true,token:'export',header:HEADER,count:99,countIsExact:false}:m.type==='EXPORT_PAGE'?{ok:true,entries:[{...ENTRY,apiKey:'hidden',endpoint:'hidden'}],cursor:null,done:true}:{ok:true});
  await f.node('exportCache').handlers.click();assert(f.state.pickerBeforeMessages);assert(f.state.closed);assert(!f.state.aborted);
  const lines=f.writes.join('').trim().split('\n').map(JSON.parse);assert.equal(lines[1].context,ENTRY.context);assert.equal(lines[1].apiKey,undefined);assert.equal(lines[1].endpoint,undefined);assert.deepEqual(lines.at(-1),{end:true,count:1});assert.equal(f.calls.at(-1).type,'EXPORT_END');
});
test('[MOCKED] exact export count mismatch aborts writer and ends session',async()=>{
  const f=fixture();f.picker();f.respond(m=>m.type==='EXPORT_START'?{ok:true,token:'export',header:HEADER,count:99,countIsExact:true}:m.type==='EXPORT_PAGE'?{ok:true,entries:[ENTRY],cursor:null,done:true}:{ok:true});await f.node('exportCache').handlers.click();assert(f.state.aborted);assert(!f.state.closed);assert.equal(f.calls.at(-1).type,'EXPORT_END');
});
test('[MOCKED] oldest count validation, cancellation and destructive before/remaining confirmation',async()=>{
  const f=fixture();for(const value of ['', '0','-1','1.5','9007199254740992']){f.node('deleteOldestCount').value=value;await f.node('deleteOldest').handlers.click()}assert.equal(f.calls.length,0);
  f.respond(m=>m.type==='GET_SETTINGS'?{ok:true,cacheCount:20}:{ok:true,deleted:20,cacheCount:0});f.node('deleteOldestCount').value='1000';f.state.confirm=false;await f.node('deleteOldest').handlers.click();assert(!f.calls.some(x=>x.type==='DELETE_OLDEST'));
  f.state.confirm=true;await f.node('deleteOldest').handlers.click();assert.equal(f.calls.at(-1).count,1000);const prompt=f.confirmations.at(-1);assert(prompt.includes('마지막 번역 저장 시각'));assert(prompt.includes('삭제 전: 20개'));assert(prompt.includes('예상 남음: 0개'));assert(f.node('status').textContent.includes('0개 남음'));
});
test('[MOCKED] unload best-effort abort/end is deduplicated across beforeunload/pagehide',()=>{
  const f=fixture();f.api.markSessions();f.listeners.beforeunload();assert.deepEqual(f.calls.map(x=>x.type),['IMPORT_ABORT','EXPORT_END']);assert.equal(f.calls[0].token,'active-import');assert.equal(f.calls[1].token,'active-export');f.listeners.pagehide();assert.equal(f.calls.length,2);
});

test('[MOCKED] merge selector hides for replace and keeps choice when switched back',()=>{
 const f=fixture();f.node('importMode').value='merge';f.node('importMode').handlers.change();assert.equal(f.node('importConflictField').hidden,false);assert.equal(f.node('importConflictPolicy').disabled,false);
 f.node('importConflictPolicy').value='use-incoming';f.node('importMode').value='replace';f.node('importMode').handlers.change();assert.equal(f.node('importConflictField').hidden,true);assert.equal(f.node('importConflictPolicy').disabled,true);
 f.node('importMode').value='merge';f.node('importMode').handlers.change();assert.equal(f.node('importConflictPolicy').value,'use-incoming');assert.equal(f.node('importConflictField').hidden,false);
});
test('[MOCKED] both conflict policies propagate through NDJSON and legacy JSON fallback',async()=>{
 for(const policy of ['keep-local','use-incoming'])for(const legacy of [false,true]){
  const f=fixture(),file=splitFile(legacy?JSON.stringify({...HEADER,entries:[ENTRY]}):ndjson());await f.api.importStream(file,'merge',policy);
  const start=f.calls.find(x=>x.type===(legacy?'IMPORT_CACHE':'IMPORT_START'));assert.equal(start.conflictPolicy,policy);assert.equal(start.mode,'merge');
  for(const m of f.calls.filter(x=>['IMPORT_BATCH','IMPORT_COMMIT'].includes(x.type)))assert.equal(m.conflictPolicy,undefined);
 }
});
test('[MOCKED] incoming overwrite warns about manual edits, cancellation has zero cache or settings writes',async()=>{
 const f=fixture();f.node('cacheFile').files=[splitFile(ndjson())];f.node('importMode').value='merge';f.node('importConflictPolicy').value='use-incoming';f.state.confirm=false;
 await f.node('importCache').handlers.click();assert.equal(f.calls.length,0);assert(f.confirmations[0].includes('수동 수정'));assert(f.confirmations[0].includes('파일에 없는 로컬 번역은 유지'));
 f.state.confirm=true;f.respond(m=>{if(m.type==='IMPORT_START')f.node('importConflictPolicy').value='keep-local';return {ok:true,token:'session',staged:m.entries?.length,imported:1,skipped:0,cacheCount:1}});
 await f.node('importCache').handlers.click();assert.equal(f.calls.find(x=>x.type==='IMPORT_START').conflictPolicy,'use-incoming');assert(f.node('status').textContent.includes('파일 번역 우선'));assert(!f.calls.some(x=>['SAVE_SETTINGS','TEST_CONNECTION','TRANSLATE','RESET_USAGE'].includes(x.type)));
});
test('[MOCKED] local choice needs no destructive confirmation; invalid policy does not read file',async()=>{
 const f=fixture();f.node('cacheFile').files=[splitFile(ndjson())];f.node('importMode').value='merge';f.node('importConflictPolicy').value='invalid';await f.node('importCache').handlers.click();assert.equal(f.calls.length,0);
 f.node('importConflictPolicy').value='keep-local';await f.node('importCache').handlers.click();assert.equal(f.confirmations.length,0);assert.equal(f.calls.find(x=>x.type==='IMPORT_START').conflictPolicy,'keep-local');assert(f.node('status').textContent.includes('로컬 번역 유지'));
});
test('[MOCKED] replace preserves destructive confirmation and omits merge policy',async()=>{
 const f=fixture();f.node('cacheFile').files=[splitFile(ndjson())];f.node('importMode').value='replace';f.node('importConflictPolicy').value='invalid';await f.node('importCache').handlers.click();assert(f.confirmations[0].includes('전체 교체'));const start=f.calls.find(x=>x.type==='IMPORT_START');assert.equal(start.mode,'replace');assert.equal(start.conflictPolicy,undefined);
});
test('[STATIC] local is default and both choices identify the winning side',()=>{
 const html=fs.readFileSync(path.join(process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..'),'popup.html'),'utf8');assert(html.includes('<option value="keep-local" selected>'));assert(html.includes('<option value="use-incoming">'));assert(html.includes('수동 수정 여부보다 우선'));assert(html.includes('제공자 설정 저장과는 별개'));
});
