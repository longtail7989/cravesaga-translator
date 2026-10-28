/* Offline dialogue/backlog regressions: real backend/store and MAIN/relay, synthetic text only. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..'),ORIGIN='https://gg-client-r.crave-saga.net',CHANNEL='crave-ai-translator/v1';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await pause(5);}throw Error('Offline operation did not settle');}
(async()=>{
// Reuse the established bounded worker IDB/provider fixture, not its test cases.
const worker=fs.readFileSync(path.join(root,'tests/worker.cjs'),'utf8'),start=worker.indexOf('(async()=>{')+'(async()=>{'.length,end=worker.indexOf('let httpBefore=httpCalls;');
assert(start>10&&end>start,'Worker fixture boundaries unavailable');
const B=await vm.runInNewContext('(async()=>{'+worker.slice(start,end)+'return {send,game,admin,cache,memory,modules,idb,databases,makeDatabase,sentMessages,http:()=>httpCalls,defer:()=>{responseMode="deferred";},held:()=>typeof releaseFetch==="function",release:()=>{responseMode="normal";const done=releaseFetch;releaseFetch=null;done();}};})()',{fs,path,vm,assert,process,__dirname,require,console,setTimeout,clearTimeout,structuredClone,URL,TextEncoder,TextDecoder,Uint8Array,AbortController,Response});
const C=B.modules.get('./cache.mjs').namespace,S=B.modules.get('./cache-store.mjs').namespace,D=B.modules.get('./dialogue-text.js');
const dialogue=vm.runInContext("globalThis[Symbol.for('crave-ai-dialogue-text.v1')]",D.context);
let n=0;const gameSend=m=>B.send(m,{...B.game,documentId:'backlog-'+(++n)}),result=answer=>{assert.equal(answer.ok,true,answer.error);return answer.results[0];};
const lookup=(source,context='AdvRichBackLogText',templates)=>gameSend({type:'CACHE_LOOKUP',items:[{id:'lookup',source,context,...(templates?{templates}:{})}]}).then(result);
const translate=(source,context='AdvRichBackLogText',templates)=>gameSend({type:'TRANSLATE',items:[{id:'translate',source,context,...(templates?{templates}:{})}]}).then(result);
const target='한국어',body='{USER}、攻撃力が10%上昇する。\r\n次の行',text='{USER}님, 공격력이 10% 상승합니다.\r\n다음 줄',backlog='<size=24>アレン、攻撃力が10%上昇する。次の行</size>',template=backlog.replace('アレン','{USER}');
const row=async(source,translated,extra={})=>C.portableEntry(await C.makeCacheEntry({source,text:translated,target,context:'AdvText / ggMessageView',createdAt:10,updatedAt:20,...extra}));
const file=entries=>C.buildExport(entries).data;
const importRows=async entries=>{const answer=await B.send({type:'IMPORT_CACHE',mode:'replace',data:file(entries)});assert.equal(answer.ok,true,answer.error);};
await B.send({type:'SAVE_SETTINGS',settings:{provider:'custom',endpoint:'http://127.0.0.1:1234/v1',model:'mock',enabled:true,consent:true}});
assert(dialogue.equivalent(body,template));
for(const changed of [template.replace('10','11'),template.replace('次',' 次'),template.replace('10','１０'),template.replace('次','別'),template.replace('{USER}','{OTHER}'),template.replace('次','<b>次</b>')])assert(!dialogue.equivalent(body,changed));
assert(!dialogue.equivalent('<b title="a\nb">文</b>','<b title="ab">文</b>'));
assert(!dialogue.equivalent('<b title="a>\nb">文</b>','<b title="a>b">文</b>'));
assert(!dialogue.equivalent('{line\nbreak}文','{linebreak}文'));
assert(!dialogue.equivalent('<size=24>文</size>余分<size=24>字</size>','文余分字'));
assert.equal(dialogue.split('<size=24><size=12>文</size></size>').body,'<size=12>文</size>');
assert(!dialogue.isStory('Menu / AdvTextLike'));
await importRows([await row(body,text)]);
let before=B.http(),hit=await translate(backlog,'AdvRichBackLogText',[template]);assert.equal(hit.cached,true);assert.equal(hit.cacheSource,body);assert.equal(hit.text,text);assert.equal(B.http(),before,'backlog reuse must not call provider');
assert.equal((await lookup(backlog,'Menu',[template])).missing,true,'non-story labels cannot use equivalence');
assert.equal((await lookup(backlog.replace('10','11'),'AdvRichBackLogText',[template.replace('10','11')])).missing,true);
assert.equal((await lookup(backlog.replace('アレン','別人'),'AdvRichBackLogText')).missing,true,'unknown names are not globally normalized');
const manualBody=body.replace('\r\n','\n'),manualText=text.replace('\r\n','\n').replace('다음 줄','수동 줄');
await importRows([await row(body,text,{updatedAt:100}),await row(manualBody,manualText,{manual:true}),await row(dialogue.split(template).body,'{USER}님 10% 자동',{updatedAt:200})]);assert.equal((await lookup(backlog,'AdvRichBackLogText',[template])).text,manualText,'equivalence ordering is manual-first, not newest automatic');
const exact=await row(backlog,'<size=24>개별 공격력 10% 번역</size>',{manual:true,context:'AdvRichBackLogText'});
await importRows([await row(body,text),exact]);hit=await lookup(backlog,'AdvRichBackLogText',[template]);assert.equal(hit.cacheSource,backlog);assert.equal(hit.text,exact.text,'exact custom backlog override wins over templates and equivalence');
const storedBacklog='<size=24>{USER}、攻撃力が10%上昇する。次の行</size>',storedText='<size=24>{USER}님, 공격력이 10% 상승합니다.다음 줄</size>';
await importRows([await row(storedBacklog,storedText,{context:'AdvRichBackLogText'})]);
hit=await lookup(body.replace('{USER}','レオン'),'AdvText',[body]);assert.equal(hit.cacheSource,storedBacklog);assert.equal(hit.text,storedText,'backlog supplies multiline live dialogue');
const warnings=await row(template,'태그와 수치가 누락된 번역',{context:'AdvRichBackLogText',manual:true});await importRows([warnings]);assert.equal((await lookup(template)).text,warnings.text,'exact warning rows remain usable');assert.equal((await lookup(body,'AdvText')).missing,true,'warning rows are not equivalence sources');
// A v4 database with a completed old migration must still derive the new bounded index.
const migrationName='offline-dialogue-migration',state=B.makeDatabase(migrationName);B.databases.set(migrationName,state);state.db.createObjectStore('translations',{keyPath:'id'});state.db.createObjectStore('cache-metadata',{keyPath:'id'});state.setVersion(4);
const oldRows=[];for(let i=0;i<70;i++)oldRows.push(await row('移行文'+i+'\n続き','이전 문장'+i+'\n계속'));
await new Promise((resolve,reject)=>{const tx=state.db.transaction(['translations','cache-metadata'],'readwrite');tx.oncomplete=resolve;tx.onerror=tx.onabort=reject;for(const r of oldRows)tx.objectStore('translations').put(r);tx.objectStore('cache-metadata').put({id:'source-identity-v3-recent-v1',done:true});});
const migrated=S.createCacheStore(B.idb,{databaseName:migrationName});assert.equal(await migrated.count(),70);let bounded=[];const transaction=state.db.transaction.bind(state.db);state.db.transaction=(...args)=>{const tx=transaction(...args),objectStore=tx.objectStore.bind(tx);tx.objectStore=name=>{const store=objectStore(name),index=store.index;store.index=name=>{const idx=index(name),getAll=idx.getAll;idx.getAll=(range,count)=>{bounded.push(count);return getAll(range,count);};return idx;};return store;};return tx;};
assert.equal((await migrated.lookupDialogue({source:'<size=24>移行文69続き</size>',context:'AdvRichBackLogText'},{target})).text,'이전 문장69\n계속');assert(bounded.length&&bounded.every(count=>Number.isInteger(count)&&count>0&&count<=16));assert.equal((await migrated.export()).data.entries.length,70);await migrated.destroy();
await importRows([]);before=B.http();hit=await translate(backlog,'AdvRichBackLogText',[template]);assert.equal(hit.cached,false);assert.equal(hit.cacheSource,dialogue.split(template).body);assert.equal(B.http(),before+1);assert([...B.cache.values()].some(r=>r.source===dialogue.split(template).body));assert(![...B.cache.values()].some(r=>r.source===template),'new AI backlog stores unwrapped source');
await importRows([await row(body,text),exact]);await B.send({type:'SET_CACHE_ENABLED',cacheEnabled:false});before=B.http();hit=await translate(backlog,'AdvRichBackLogText',[template]);assert.equal(hit.cached,false);assert.equal(B.http(),before+1);assert(![...B.cache.values()].some(r=>r.source===body||r.source===backlog),'cache-off fresh canonical write removes stale formatting aliases');await B.send({type:'SET_CACHE_ENABLED',cacheEnabled:true});
// Real pending provider writes must lose to edits/deletion of an equivalent canonical row.
const raceSource='{USER}、攻撃力が21%上昇する。\n続き',raceBacklog='<size=24>アレン、攻撃力が21%上昇する。続き</size>',raceTemplate=raceBacklog.replace('アレン','{USER}');
await importRows([await row(raceSource,'{USER}님 21%\n기존')]);await B.send({type:'SET_CACHE_ENABLED',cacheEnabled:false});B.defer();let pending=translate(raceBacklog,'AdvRichBackLogText',[raceTemplate]);await until(B.held);
let saved=await B.send({type:'CACHE_EDIT_SAVE',id:await C.cacheId(target,raceSource),source:raceSource,target,text:'{USER}님 21%\n수정',expectedUpdatedAt:20,expectedText:'{USER}님 21%\n기존'});assert.equal(saved.ok,true,saved.error);B.release();hit=await pending;assert.equal(hit.text,saved.entry.text);assert(![...B.cache.values()].some(r=>r.source===dialogue.split(raceTemplate).body),'late AI cannot recreate another formatting alias after manual edit');
B.defer();pending=translate(raceBacklog,'AdvRichBackLogText',[raceTemplate]);await until(B.held);const removed=await B.send({type:'CACHE_ENTRY_DELETE',id:saved.entry.id,source:raceSource,target,expectedUpdatedAt:saved.entry.updatedAt,expectedText:saved.entry.text});assert.equal(removed.ok,true,removed.error);B.release();hit=await pending;assert.equal(hit.code,'CANCELLED');assert(![...B.cache.values()].some(r=>dialogue.equivalent(r.source,raceSource)),'late write cannot restore deleted equivalent row');await B.send({type:'SET_CACHE_ENABLED',cacheEnabled:true});
// MAIN + relay fixture uses actual modules; no game account or real click exists.
async function screen({entries,sources=[backlog],names=['アレン','レオン'],hold=false,displayName=''}={}){
  await importRows(entries);let now=100000,sequence=0,remote,release,held=false;const timers=new Map(),messages=[],listeners=[],runtimeListeners=[],calls=[],scene={_components:[],children:[],parent:null};
  class Base{get string(){return this._s||'';}set string(value){this._s=String(value);}}class Label extends Base{}class RichText extends Base{}
  function add(source,story=true){const label=new RichText(),marker={kind:story?'AdvRichBackLogText':'Menu'},node={activeInHierarchy:true,_components:[label,marker],children:[],parent:scene};label.node=node;label._s=source;scene.children.push(node);return label;}
  const labels=sources.map(source=>add(source)),cc={Label,RichText,isValid:()=>true,director:{getScene:()=>scene},js:{getClassName:c=>c.kind||'cc.RichText'}};
  const window={cc,__require:()=>({getUserBasicData:()=>({getMainCharacterName:()=>names[0],getUserName:()=>names[1]})}),addEventListener:(type,fn)=>{if(type==='message')listeners.push(fn);},removeEventListener(){},postMessage:message=>{messages.push(message);for(const fn of [...listeners])fn({source:window,origin:ORIGIN,data:message});}};
  window[Symbol.for('crave-ai-remote.v1')]={create:api=>(remote=api,{update(){}})};
  class Clock extends Date{static now(){return now;}}
  const globals={window,cc,document:{hidden:false,getElementById:()=>null,addEventListener(){},removeEventListener(){}},location:{origin:ORIGIN,pathname:'/client/game/index_dmm.html'},console,Date:Clock,Map,Set,Symbol,Math,TextEncoder,setTimeout:(fn,ms=0)=>{timers.set(++sequence,{fn,at:now+ms});return sequence;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval(){}};
  const chrome={runtime:{onMessage:{addListener:fn=>runtimeListeners.push(fn)},sendMessage:async m=>{calls.push(m);if(m.type==='PUBLIC_CONFIG'){const answer=await gameSend(m);answer.config.playerName='';answer.config.displayName=displayName;return answer;}if(m.type==='CACHE_WARM')return {ok:true,entries:[]};if(m.type==='DISTRIBUTION_STATUS')return {ok:true,session:{status:'idle',count:0}};const answer=await gameSend(m);if(hold&&!held&&m.type==='CACHE_LOOKUP'){held=true;await new Promise(resolve=>release=resolve);}return answer;}}};
  const main=vm.createContext({...globals}),relay=vm.createContext({...globals,chrome});
  for(const name of ['name-policy.js','dialogue-text.js','story-policy.js','main.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),main,{filename:name});
  for(const name of ['retry-policy.js','dialogue-text.js','distribution-client.js','auto-advance.js','content.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),relay,{filename:name});
  await until(()=>messages.some(m=>m.from==='bridge'&&m.type==='CONFIG'&&m.config.enabled));
  async function advance(ms){const end=now+ms;for(let i=0;i<10000;i++){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next){now=end;await pause(20);return;}timers.delete(next[0]);now=next[1].at;next[1].fn();await pause(1);}throw Error('Offline timer loop');}
  async function entry(type,source,translated){const existing=await B.send({type:'CACHE_GET',id:await C.cacheId(target,source)});assert.equal(existing.ok,true,existing.error);const e=existing.entry,answer=await B.send({type:type==='CACHE_ENTRY_UPDATED'?'CACHE_EDIT_SAVE':'CACHE_ENTRY_DELETE',id:e.id,source,target,text:translated,expectedUpdatedAt:e.updatedAt,expectedText:e.text});assert.equal(answer.ok,true,answer.error);for(const fn of runtimeListeners)fn({type,entry:{source,text:translated,target,manual:true}},{},()=>{});await pause(20);}
  return {labels,add,messages,calls,advance,entry,held:()=>held,release:()=>release(),remote:()=>remote,refresh:()=>window[Symbol.for('crave-ai-translator.v1')].refresh(),send:(type,payload={})=>window.postMessage({channel:CHANNEL,from:'bridge',type,...payload})};
}
let h=await screen({entries:[await row(body,text)],sources:[backlog,backlog.replace('アレン','レオン')]});before=B.http();await h.advance(40);await until(()=>h.labels.every(l=>l.string.includes('공격력')));assert.equal(h.labels[0].string,'<size=24>アレン님, 공격력이 10% 상승합니다.다음 줄</size>');assert.equal(h.labels[1].string,'<size=24>レオン님, 공격력이 10% 상승합니다.다음 줄</size>');assert.equal(B.http(),before);assert(!h.calls.some(m=>m.type==='TRANSLATE'));
h.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d100'});const captured=h.messages.filter(m=>m.type==='RECORD_TEXT');assert(captured.some(m=>m.item.source===body&&m.item.text===text));assert(!captured.some(m=>m.item.source===body&&m.item.text.includes('アレン')));const visible=await h.remote().getVisible();assert.equal(visible.items[0].source,body);assert.equal(visible.items[0].text,text);const exported=await B.send({type:'EXPORT_CACHE'});assert.equal(exported.data.entries[0].source,body);assert.equal(exported.data.entries[0].text,text);assert(!Object.hasOwn(exported.data.entries[0],'dialogueKey'));
await h.entry('CACHE_ENTRY_UPDATED',body,'{USER}님, 수정 10%\r\n새 줄');await h.advance(40);await until(()=>h.labels[0].string.includes('수정'));assert.equal(h.labels[0].string,'<size=24>アレン님, 수정 10%새 줄</size>');
await h.entry('CACHE_ENTRY_DELETED',body);assert.equal(h.labels[0].string,backlog);await h.advance(500);assert(!h.calls.some(m=>m.type==='TRANSLATE'),'deleted alias occurrence is suppressed');
h=await screen({entries:[await row(body,text),exact],hold:true});await h.advance(20);await until(h.held);await h.entry('CACHE_ENTRY_DELETED',body);await until(()=>h.labels[0].string===exact.text);h.release();await pause(50);assert.equal(h.labels[0].string,exact.text,'late equivalent result cannot overwrite preserved exact override');
h=await screen({entries:[await row(body,text)]});await h.advance(40);await until(()=>h.labels[0].string.includes('공격력'));const menu=h.add(backlog,false);h.refresh();await h.advance(40);assert.equal(menu.string,backlog,'MAIN/relay memory aliases never leak into non-story labels');
h=await screen({entries:[await row(storedBacklog,storedText,{context:'AdvRichBackLogText'})],sources:[body.replace('{USER}','レオン')]});await h.advance(40);await until(()=>h.labels[0].string.includes('공격력'));assert.equal(h.labels[0].string,'レオン님, 공격력이 10% 상승합니다.다음 줄','live display removes the stored backlog wrapper without changing canonical text');
// Literal nickname rows remain exact/manual records while displayName affects speaker and body only.
for(const [alias,displayName]of [['ロングテール','이사무'],['カイ','용사']]){
  const speaker=`<size=24>${alias}</size>`,literal=backlog.replace('アレン',alias),legacy=text.replace('{USER}',alias).replace(/\r?\n/g,''),legacyBody=`<size=24>${legacy}</size>`;
  h=await screen({names:[alias,'別アカウント'],displayName,sources:[speaker,literal],entries:[await row(speaker,speaker,{manual:true,context:'AdvRichBackLogText'}),await row(literal,legacyBody,{manual:true,context:'AdvRichBackLogText'}),await row(body,'{USER}님, 다른 자동 10%\r\n줄')]});
  await h.advance(40);await until(()=>h.labels[0].string.includes(displayName)&&h.labels[1].string.includes(displayName));
  assert.equal(h.labels[0].string,`<size=24>${displayName}</size>`);assert.equal(h.labels[1].string,legacyBody.replace(alias,displayName),'personalization does not replace the exact manual translation with an equivalent automatic row');
  const legacyExport=await B.send({type:'EXPORT_CACHE'});assert(legacyExport.data.entries.some(row=>row.source===literal&&row.text===legacyBody&&row.manual),'legacy manual cache bytes stay intact');
  const legacyVisible=await h.remote().getVisible();assert(legacyVisible.items.some(row=>row.source===literal&&row.text===legacyBody),'editor receives complete durable literal value, not personalized display');
}
await importRows([]);before=B.http();
for(const alias of ['ロングテール','カイ']){
  const speaker=await translate(`<size=24>${alias}</size>`,'AdvRichBackLogText',['<size=24>{USER}</size>']);
  assert.equal(speaker.cacheSource,'{USER}');assert.equal(speaker.text,'{USER}');
  const fresh=await translate(backlog.replace('アレン',alias),'AdvRichBackLogText',[template]);assert(fresh.text.includes('{USER}'));assert.equal(fresh.cacheSource,dialogue.split(template).body);
}
assert.equal(B.http(),before+1,'two player backlog speakers and bodies share canonical identity without extra provider requests');
const canonicalExport=await B.send({type:'EXPORT_CACHE'});assert.equal(canonicalExport.data.entries.length,2);assert(canonicalExport.data.entries.every(row=>row.source.includes('{USER}')&&row.text.includes('{USER}')&&!/ロングテール|カイ|이사무/.test(row.source+row.text)),'fresh worker writes retain complete canonical source and target without real/display nicknames');
console.log('PASS backlog both-direction indexed reuse/exact precedence/protected spans/migration/AI persistence/cache-off/races/canonical display and export');
})().catch(error=>{console.error(error);process.exitCode=1;});
