// Offline authorization/lifecycle mocks only. No browser, installs, user cache or AI.
const assert=require('node:assert/strict'),path=require('node:path');
globalThis.crypto??=require('node:crypto').webcrypto;
(async()=>{
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..'),url=require('node:url').pathToFileURL;
const {createDistributionBroker,distributionErrorResponse}=await import(url(path.join(root,'distribution-broker.mjs')));
const {makeCacheEntry,portableEntry}=await import(url(path.join(root,'cache.mjs')));
const clone=x=>structuredClone(x),calls=[],opened=[],rows=new Map();let state={status:'idle',count:0},appendFailure,readGate,canonical;
const area=()=>({data:{},async get(key){return {[key]:clone(this.data[key])};},async set(values){calls.push(clone(values));Object.assign(this.data,clone(values));},async remove(key){delete this.data[key];}});
const chrome={runtime:{id:'offline',getURL:f=>'chrome-extension://offline/'+f},storage:{local:area(),session:area()},windows:{async create(options){opened.push(options);return {id:opened.length};}}};
const game={id:'offline',url:'https://gg-client-r.crave-saga.net/client/test/index_dmm.html',tab:{id:7},frameId:2},other={...game,frameId:3},popup={id:'offline',url:chrome.runtime.getURL('popup.html'),frameId:0};
const isGame=s=>{try{const u=new URL(s.url);return s.id===chrome.runtime.id&&u.protocol==='https:'&&u.hostname==='gg-client-r.crave-saga.net'&&/^\/client\/[^/]+\/index_dmm\.html$/.test(u.pathname);}catch{return false;}};
const own=o=>assert.deepEqual(o,state.owner),typed=code=>Object.assign(Error('SYNTHETIC_SECRET_DO_NOT_LEAK'),{code});
const store={async status(){return clone(state);},async start({owner,target,fileName}){assert(!['recording','ready'].includes(state.status));state={id:'dist:'+crypto.randomUUID(),owner,target,fileName,status:'recording',count:0,createdAt:1};rows.clear();return clone(state);},async append(owner,entries){own(owner);if(appendFailure)throw appendFailure;assert.equal(state.status,'recording');for(const e of entries)rows.set(e.id,clone(e));state.count=rows.size;return {...clone(state),added:entries.length,upserted:entries.length};},async finish(owner,id){own(owner);assert.equal(id,state.id);assert(['recording','ready'].includes(state.status));state.status='ready';state.finishedAt??=2;return clone(state);},async exportPage(args){assert.equal(args.id,state.id);assert.equal(state.status,'ready');assert.equal(args.limit,250);assert.equal(args.maxBytes,1024*1024);return {id:state.id,entries:[...rows.values()],cursor:null,done:true};},async saved(owner,id){own(owner);assert.equal(id,state.id);assert(['ready','saved'].includes(state.status));state.status='saved';return clone(state);},async discard(owner,id){own(owner);assert.equal(id,state.id);state.status='discarded';return clone(state);}};
const editor={async get({id}){if(readGate)await readGate;return canonical?{entry:{...canonical,id:canonical.id}}:null;}};
const dependencies={chrome,store,editor,cache:{put(){throw Error('MUST NOT WRITE PERSONAL CACHE');}},settings:async()=>({target:'한국어',apiKey:'SYNTHETIC_SECRET'}),isGame};
let broker=createDistributionBroker(dependencies),tests=0;
const run=async(name,fn)=>{await fn();console.log('PASS broker: '+name);tests++;};
const send=async(message,sender=game)=>{const result=await broker.handle(message,sender);if(message.type==='DISTRIBUTION_STATUS'&&result.ok===true)assert.equal(result.apiVersion,2);return result;};
const busy=(result,reason='OWNER_UNCONFIRMED')=>{
  assert.equal(result.ok,true);assert.equal(result.apiVersion,2);assert.equal(result.session.status,'busy');assert.equal(result.session.count,0);assert.equal(result.session.reason,reason);
  for(const key of ['id','owner','fileName','target','selectionId','createdAt','source','text'])assert(!Object.hasOwn(result.session,key));
  const encoded=JSON.stringify(result);assert(!encoded.includes('SYNTHETIC_SECRET'));
  for(const value of [state.id,state.fileName,state.target,canonical?.source,canonical?.text])if(value)assert(!encoded.includes(value));
};
const reject=(message,sender,code)=>assert.rejects(()=>send(message,sender),e=>e.code===code);
const open=async(action='start',id)=>{const result=await send({type:'DISTRIBUTION_OPEN',action,...(id?{id}:{})});const intent=new URL(opened.at(-1).url).searchParams.get('intent');return {result,intent,sender:{id:'offline',url:opened.at(-1).url,frameId:0}};};
let window,start,id;
await run('exact role boundary and no popup/external/game window routes',async()=>{
for(const sender of [popup,{...game,id:'external'},{...game,url:'https://gg-client-r.crave-saga.net.evil/client/x/index_dmm.html'},{...game,tab:{}}])await reject({type:'DISTRIBUTION_STATUS'},sender,'FORBIDDEN');
await reject({type:'DISTRIBUTION_START',intent:crypto.randomUUID()},game,'FORBIDDEN');
assert.equal((await send({type:'DISTRIBUTION_STATUS'})).session.status,'idle');
});
await run('start opens top-level popup with persisted short-lived intent',async()=>{
window=await open();assert.equal(window.result.opened,true);assert.equal(opened[0].type,'popup');assert.equal(opened[0].width,540);const intent=chrome.storage.session.data['distributionIntent:'+window.intent];assert.deepEqual(intent.owner,{tabId:7,frameId:2});assert(intent.expiresAt>Date.now()&&intent.expiresAt<=Date.now()+600000);
assert.equal((await send({type:'DISTRIBUTION_WINDOW_GET',intent:window.intent},window.sender)).action,'start');
await reject({type:'DISTRIBUTION_WINDOW_GET',intent:window.intent},{...window.sender,frameId:1},'FORBIDDEN');await reject({type:'DISTRIBUTION_WINDOW_GET',intent:window.intent},popup,'FORBIDDEN');
});
await run('strict filename, destination UUID, target snapshot and idempotent start',async()=>{
for(const fileName of ['../private.ndjson','a/b.jsonl','a\\b.jsonl','a\n.ndjson','plain.json','a'.repeat(256)+'.ndjson','.ndjson'])await reject({type:'DISTRIBUTION_START',intent:window.intent,fileName,selectionId:crypto.randomUUID()},window.sender,'INVALID_FILE_NAME');
await reject({type:'DISTRIBUTION_START',intent:window.intent,fileName:'ok.ndjson',selectionId:'not-uuid'},window.sender,'INVALID_SELECTION');
const selectionId=crypto.randomUUID();start=await send({type:'DISTRIBUTION_START',intent:window.intent,fileName:'test.ndjson',selectionId},window.sender);id=start.session.id;assert.equal(start.session.selectionId,selectionId);assert.equal(start.session.target,'한국어');assert.equal(start.session.createdAt,1);
assert.equal((await send({type:'DISTRIBUTION_START',intent:window.intent,fileName:'other.jsonl',selectionId:crypto.randomUUID()},window.sender)).session.id,id);assert.equal((await open()).result.opened,false);
});
await run('other owner sees only busy, cannot capture or finish; no filename/selection leak',async()=>{
busy(await send({type:'DISTRIBUTION_STATUS'},other));await reject({type:'DISTRIBUTION_OPEN',action:'finish',id},other,'OWNER_MISMATCH');await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},other,'OWNER_MISMATCH');assert(!Object.hasOwn((await send({type:'DISTRIBUTION_STATUS'})).session,'selectionId'));
});
await run('canonical capture only: exact source/text/target, manual and timestamps from personal entry',async()=>{
canonical=portableEntry(await makeCacheEntry({source:'星の勇者',text:'별의 용사',target:'한국어',context:'cache-only',createdAt:5,updatedAt:10,manual:true}));
const item={source:canonical.source,text:canonical.text,target:canonical.target};const result=await send({type:'DISTRIBUTION_CAPTURE',id,items:[item]});assert.equal(result.accepted,1);assert.deepEqual(rows.get(canonical.id),canonical);
assert.equal((await send({type:'DISTRIBUTION_CAPTURE',id,items:[{...item,text:'이전 번역'}]})).skipped,1);
await reject({type:'DISTRIBUTION_CAPTURE',id,items:[{...item,manual:false}]},game,'INVALID_ENTRY');await reject({type:'DISTRIBUTION_CAPTURE',id,items:[{...item,target:'English'}]},game,'TARGET_MISMATCH');await reject({type:'DISTRIBUTION_CAPTURE',id:'dist:stale',items:[item]},game,'STALE_SESSION');await reject({type:'DISTRIBUTION_CAPTURE',id,items:Array(33).fill(item)},game,'BATCH_LIMIT');
const good=canonical;canonical={...good,id:'v3:'+'0'.repeat(64)};await reject({type:'DISTRIBUTION_CAPTURE',id,items:[item]},game,'INVALID_ENTRY');canonical=good;
});
await run('quota failures are safe, persistent, recoverable and isolated from personal cache',async()=>{
appendFailure=typed('QUOTA');let caught;try{await send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:canonical.source,text:canonical.text,target:canonical.target}]});}catch(e){caught=e;}const response=distributionErrorResponse(caught);assert.equal(response.code,'QUOTA');assert.equal(response.session.status,'recording');assert.equal(response.session.warning,'PARTIAL_RECORDING');assert(!JSON.stringify(response).includes('SYNTHETIC_SECRET'));assert.equal(chrome.storage.local.data.distributionError.id,id);
broker=createDistributionBroker(dependencies);assert.equal((await send({type:'DISTRIBUTION_STATUS'})).session.errorCode,'QUOTA');appendFailure=null;
await send({type:'DISTRIBUTION_CAPTURE',id,items:[]});assert.equal((await send({type:'DISTRIBUTION_STATUS'})).session.status,'recording');assert.equal((await send({type:'DISTRIBUTION_STATUS'})).session.warning,'PARTIAL_RECORDING');
});
await run('finish is serialized behind canonical read/capture then frozen durably',async()=>{
let release;readGate=new Promise(r=>{release=r;});const capture=send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:canonical.source,text:canonical.text,target:canonical.target}]});const finish=open('finish',id);await new Promise(r=>setTimeout(r,10));assert.equal(state.status,'recording');release();readGate=null;await capture;window=await finish;assert.equal(state.status,'ready');await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},game,'FROZEN');
const frozen=await send({type:'DISTRIBUTION_FREEZE',intent:window.intent,id},window.sender);assert.equal(frozen.status,'ready');assert.equal(frozen.header.identity,'source-v3');assert.equal(frozen.session.count,1);assert.equal((await send({type:'DISTRIBUTION_FREEZE',intent:window.intent,id},window.sender)).header.exportedAt,frozen.header.exportedAt);
});
await run('client-reported partial finish is strict, owner/id scoped and persists a warning',async()=>{
await reject({type:'DISTRIBUTION_OPEN',action:'finish',id,partial:'true'},game,'INVALID_ENTRY');await reject({type:'DISTRIBUTION_OPEN',action:'start',partial:false},game,'INVALID_ENTRY');await reject({type:'DISTRIBUTION_OPEN',action:'finish',partial:true},game,'STALE_SESSION');await reject({type:'DISTRIBUTION_OPEN',action:'finish',id:'dist:stale',partial:true},game,'STALE_SESSION');await reject({type:'DISTRIBUTION_OPEN',action:'finish',id,partial:true},other,'OWNER_MISMATCH');
const result=await send({type:'DISTRIBUTION_OPEN',action:'finish',id,partial:true});assert.equal(result.opened,true);assert.equal(result.session.status,'ready');assert.equal(result.session.warning,'PARTIAL_RECORDING');assert.deepEqual(chrome.storage.local.data.distributionError,{id,code:'QUOTA'});
const nonce=new URL(opened.at(-1).url).searchParams.get('intent');const info=await send({type:'DISTRIBUTION_WINDOW_GET',intent:nonce},{id:'offline',url:opened.at(-1).url,frameId:0});assert.equal(info.session.errorCode,'QUOTA');
});
await run('frozen pages require bound session, destination can be reselected; save idempotent',async()=>{
await reject({type:'DISTRIBUTION_PAGE',intent:window.intent,id:'dist:other'},window.sender,'STALE_SESSION');const page=await send({type:'DISTRIBUTION_PAGE',intent:window.intent,id,cursor:null},window.sender);assert.equal(page.entries.length,1);const resumed=await open('start');assert.equal((await send({type:'DISTRIBUTION_WINDOW_GET',intent:resumed.intent},resumed.sender)).action,'finish');
const selectionId=crypto.randomUUID();const selected=await send({type:'DISTRIBUTION_RESELECT',intent:window.intent,id,fileName:'recovery.jsonl',selectionId},window.sender);assert.equal(selected.session.selectionId,selectionId);assert.equal(selected.session.fileName,'recovery.jsonl');
assert.equal((await send({type:'DISTRIBUTION_SAVED',intent:window.intent,id},window.sender)).session.status,'saved');assert.equal((await send({type:'DISTRIBUTION_SAVED',intent:window.intent,id},window.sender)).session.status,'saved');assert.equal(chrome.storage.local.data.distributionDestination,undefined);
});
await run('destination metadata failure keeps recoverable session and never touches personal cache',async()=>{
const next=await open(),original=chrome.storage.local.set;chrome.storage.local.set=async()=>{throw typed('STORAGE');};let result;try{result=await send({type:'DISTRIBUTION_START',intent:next.intent,fileName:'recover.ndjson',selectionId:crypto.randomUUID()},next.sender);}finally{chrome.storage.local.set=original;}assert.equal(result.ok,true);assert.equal(result.warning,'DESTINATION_UNAVAILABLE');assert.equal(result.session.status,'recording');const recovery=await open('finish',result.session.id);assert.equal((await send({type:'DISTRIBUTION_FREEZE',intent:recovery.intent},recovery.sender)).status,'ready');await send({type:'DISTRIBUTION_DISCARD',intent:recovery.intent,id:result.session.id},recovery.sender);
});
await run('storage unavailable and expired intent fail closed; no settings writes',async()=>{
const old=chrome.storage.session;chrome.storage.session=undefined;await reject({type:'DISTRIBUTION_OPEN',action:'start'},game,'UNAVAILABLE');chrome.storage.session=old;
chrome.storage.session.data['distributionIntent:'+window.intent].expiresAt=Date.now()-1;await reject({type:'DISTRIBUTION_WINDOW_GET',intent:window.intent},window.sender,'INVALID_INTENT');
assert(calls.every(x=>!Object.hasOwn(x,'settings')));
assert.equal(distributionErrorResponse(Error('SECRET')).error,'녹화를 저장하지 못했습니다. 다시 시도해 주세요.');
});
const recording=async()=>{
  state={status:'idle',count:0};rows.clear();appendFailure=null;readGate=null;canonical=null;
  chrome.storage.local=area();chrome.storage.session=area();delete chrome.tabs;
  chrome.windows.create=async options=>{opened.push(options);return {id:opened.length};};
  broker=createDistributionBroker(dependencies);
  const startWindow=await open(),selectionId=crypto.randomUUID();
  const result=await send({type:'DISTRIBUTION_START',intent:startWindow.intent,fileName:'refresh.ndjson',selectionId},startWindow.sender);
  return {id:result.session.id,selectionId,startWindow};
};
const captureRow=async(id)=>{
  canonical=portableEntry(await makeCacheEntry({source:'星の勇者',text:'별의 용사',target:'한국어',context:'refresh',createdAt:5,updatedAt:10,manual:true}));
  await send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:canonical.source,text:canonical.text,target:canonical.target}]});
  return clone(canonical);
};
const latestWindow=()=>({intent:new URL(opened.at(-1).url).searchParams.get('intent'),sender:{id:'offline',url:opened.at(-1).url,frameId:0}});
const absent=()=>Promise.reject(Error('Could not establish connection. Receiving end does not exist.'));
await run('initial status is strict; ordinary polling and worker restart never finish a live owner',async()=>{
  const {id}=await recording(),before=opened.length;
  for(const initial of [null,0,'true',{},undefined])await reject({type:'DISTRIBUTION_STATUS',initial},game,'INVALID_ENTRY');
  assert.equal((await send({type:'DISTRIBUTION_STATUS',initial:false})).session.status,'recording');
  broker=createDistributionBroker(dependencies);
  assert.equal((await send({type:'DISTRIBUTION_STATUS'})).session.id,id);
  assert.equal(state.status,'recording');assert.equal(opened.length,before);
});
await run('same-frame refresh runs original selected-file Finish pipeline; only save ack is terminal',async()=>{
  const {id,selectionId}=await recording(),entry=await captureRow(id),before=opened.length,destination=clone(chrome.storage.local.data.distributionDestination),owner=clone(state.owner);
  const refreshed=await send({type:'DISTRIBUTION_STATUS',initial:true});
  assert.equal(refreshed.session.status,'ready');assert.equal(refreshed.session.count,1);assert.equal(opened.length,before+1);
  assert.deepEqual(state.owner,owner);assert.deepEqual(rows.get(entry.id),entry);assert.deepEqual(chrome.storage.local.data.distributionDestination,destination);
  assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],true);
  const finish=latestWindow(),intent=chrome.storage.session.data['distributionIntent:'+finish.intent];
  assert.deepEqual(intent.owner,owner);assert.equal(intent.action,'finish');assert.equal(intent.id,id);
  const info=await send({type:'DISTRIBUTION_WINDOW_GET',intent:finish.intent},finish.sender);
  assert.equal(info.session.selectionId,selectionId);assert.equal(info.session.fileName,'refresh.ndjson');
  const frozen=await send({type:'DISTRIBUTION_FREEZE',intent:finish.intent,id},finish.sender);
  assert.equal(frozen.session.id,id);assert.equal(frozen.session.createdAt,1);
  assert.deepEqual((await send({type:'DISTRIBUTION_PAGE',intent:finish.intent,id},finish.sender)).entries,[entry]);
  assert.equal(state.status,'ready');await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},game,'FROZEN');
  await send({type:'DISTRIBUTION_SAVED',intent:finish.intent,id},finish.sender);
  assert.equal((await send({type:'DISTRIBUTION_STATUS',initial:true})).session.status,'saved');
  assert.equal(chrome.storage.local.data.distributionDestination,undefined);
  const next=await open();assert.equal((await send({type:'DISTRIBUTION_WINDOW_GET',intent:next.intent},next.sender)).action,'start');
});
await run('unload and initial status race behind capture; duplicates and worker restart open only one automatic Finish',async()=>{
  const {id}=await recording();
  canonical=portableEntry(await makeCacheEntry({source:'勇者',text:'용사',target:'한국어',createdAt:5,updatedAt:10,manual:true}));
  let release;readGate=new Promise(resolve=>{release=resolve;});const before=opened.length;
  const capture=send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:canonical.source,text:canonical.text,target:canonical.target}]});
  const unload=send({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:false});
  const initial=send({type:'DISTRIBUTION_STATUS',initial:true});
  const duplicate=send({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:true});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(state.status,'recording');assert.equal(opened.length,before);
  release();await Promise.all([capture,unload,initial,duplicate]);readGate=null;
  assert.equal(state.count,1);assert.equal(state.status,'ready');assert.equal(opened.length,before+1);
  assert.equal((await send({type:'DISTRIBUTION_STATUS'})).session.warning,'PARTIAL_RECORDING');
  broker=createDistributionBroker(dependencies);
  await send({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:false});await send({type:'DISTRIBUTION_STATUS',initial:true});
  assert.equal(opened.length,before+1);assert.deepEqual(rows.get(canonical.id),canonical);
});
await run('unload validates exact game owner, session and partial flag before freezing or opening',async()=>{
  const {id}=await recording(),before=opened.length,otherTab={...game,tab:{id:8}};
  for(const sender of [popup,{...game,id:'foreign'}])await reject({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:false},sender,'FORBIDDEN');
  for(const sender of [other,otherTab])await reject({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:false},sender,'OWNER_MISMATCH');
  for(const message of [{partial:false},{id,partial:'false'},{id},{id:null,partial:false}])await reject({type:'DISTRIBUTION_FINISH_ON_UNLOAD',...message},game,'INVALID_ENTRY');
  await reject({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id:'dist:stale',partial:false},game,'STALE_SESSION');
  assert.equal(state.status,'recording');assert.equal(opened.length,before);
  assert.equal(chrome.storage.local.data.distributionError,undefined);
});
await run('same-tab dead-frame status freezes without owner transfer on initial and ordinary polling',async()=>{
  for(const initial of [true,false,undefined]){
    const {id}=await recording(),entry=await captureRow(id),owner=clone(state.owner),before=opened.length,probes=[];
    chrome.tabs={async sendMessage(...args){probes.push(args);throw Error('No frame with id 2 in tab 7.');}};
    const result=await send({type:'DISTRIBUTION_STATUS',...(initial===undefined?{}:{initial})},other);
    assert.equal(result.session.status,'ready');assert.equal(result.session.id,id);assert.equal(result.session.count,1);
    assert.deepEqual(probes,[[7,{type:'GET_ENGINE_STATUS'},{frameId:2}]]);assert.deepEqual(state.owner,owner);assert.deepEqual(rows.get(entry.id),entry);
    assert.equal(opened.length,before+1);assert.deepEqual(chrome.storage.session.data['distributionIntent:'+latestWindow().intent].owner,owner);
    await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},other,'OWNER_MISMATCH');
    await send({type:'DISTRIBUTION_STATUS',initial:true},other);assert.equal(opened.length,before+1);
  }
});
await run('live, absent API, empty replies and unexpected failures preserve privacy in same and different tabs',async()=>{
  const {id}=await recording();await captureRow(id);const before=opened.length,owner=clone(state.owner),destination=clone(chrome.storage.local.data.distributionDestination);
  const probes=[undefined,async()=>({ok:true}),async()=>undefined,async()=>null,async()=>({}),async()=>({ok:false}),async()=>({ok:'true'}),async()=>{throw Error('Permission denied');},async()=>{throw Error('The message port closed before a response was received.');},async()=>{throw Error('SYNTHETIC_SECRET');}];
  for(const sender of [other,{...game,tab:{id:8}}])for(const probe of probes){
    if(probe)chrome.tabs={sendMessage:probe};else delete chrome.tabs;
    busy(await send({type:'DISTRIBUTION_STATUS',initial:true},sender),probe===probes[1]?'OWNER_ACTIVE':'OWNER_UNCONFIRMED');
    await reject({type:'DISTRIBUTION_OPEN',action:'finish',id},sender,'OWNER_MISMATCH');
    await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},sender,'OWNER_MISMATCH');
    assert.equal(state.status,'recording');assert.equal(opened.length,before);assert.deepEqual(state.owner,owner);
    assert.deepEqual(chrome.storage.local.data.distributionDestination,destination);assert.equal(rows.size,1);
  }
});
await run('failed automatic window creation clears claim, preserves frozen rows and permits explicit stale-frame manual Finish',async()=>{
  const {id,selectionId}=await recording(),entry=await captureRow(id),before=opened.length,create=chrome.windows.create;
  chrome.tabs={sendMessage:absent};chrome.windows.create=async()=>{throw Error('Window unavailable');};
  await assert.rejects(()=>send({type:'DISTRIBUTION_STATUS',initial:true},other));
  assert.equal(state.status,'ready');assert.deepEqual(rows.get(entry.id),entry);assert.equal(opened.length,before);
  assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],undefined);
  assert(!Object.values(chrome.storage.session.data).some(value=>value?.action==='finish'));
  chrome.windows.create=create;broker=createDistributionBroker(dependencies);
  const ready=await send({type:'DISTRIBUTION_STATUS',initial:true},other);assert.equal(ready.session.id,id);assert.equal(ready.session.status,'ready');assert.equal(opened.length,before);
  await reject({type:'DISTRIBUTION_OPEN',action:'start'},other,'OWNER_MISMATCH');
  await reject({type:'DISTRIBUTION_OPEN',action:'finish'},other,'OWNER_MISMATCH');
  await reject({type:'DISTRIBUTION_OPEN',action:'finish',id:'dist:stale'},other,'OWNER_MISMATCH');
  const manual=await send({type:'DISTRIBUTION_OPEN',action:'finish',id},other);assert.equal(manual.opened,true);
  const finish=latestWindow(),info=await send({type:'DISTRIBUTION_WINDOW_GET',intent:finish.intent},finish.sender);
  assert.equal(info.session.selectionId,selectionId);assert.deepEqual(chrome.storage.session.data['distributionIntent:'+finish.intent].owner,{tabId:7,frameId:2});
  assert.deepEqual((await send({type:'DISTRIBUTION_PAGE',intent:finish.intent,id},finish.sender)).entries,[entry]);
  await send({type:'DISTRIBUTION_SAVED',intent:finish.intent,id},finish.sender);assert.equal(state.status,'saved');
});
await run('orphaned automatic claim after worker failure still has a manually reachable Finish and re-probes stale owner',async()=>{
  const {id}=await recording();await store.finish(state.owner,id);await chrome.storage.session.set({['distributionAutoFinish:'+id]:true});
  broker=createDistributionBroker(dependencies);const before=opened.length;chrome.tabs={sendMessage:absent};
  assert.equal((await send({type:'DISTRIBUTION_STATUS'},other)).session.status,'ready');assert.equal(opened.length,before);
  chrome.tabs={async sendMessage(){return {ok:true};}};
  await reject({type:'DISTRIBUTION_OPEN',action:'finish',id},other,'OWNER_MISMATCH');
  chrome.tabs={sendMessage:absent};assert.equal((await send({type:'DISTRIBUTION_OPEN',action:'finish',id},other)).opened,true);
  assert.equal(opened.length,before+1);
});
await run('canonical skips and rejected capture persist partial warnings before disappearing client can report them',async()=>{
  for(const failure of ['missing','outdated','invalid','quota']){
    const {id}=await recording();await captureRow(id);const retained=clone(rows.get(canonical.id)),item={source:canonical.source,text:canonical.text,target:canonical.target};
    if(failure==='missing')canonical=null;
    if(failure==='outdated')item.text='이전 번역';
    if(failure==='invalid')item.manual=false;
    if(failure==='quota')appendFailure=typed('QUOTA');
    if(failure==='invalid'||failure==='quota')await reject({type:'DISTRIBUTION_CAPTURE',id,items:[item]},game,failure==='quota'?'QUOTA':'INVALID_ENTRY');
    else {const skipped=await send({type:'DISTRIBUTION_CAPTURE',id,items:[item]});assert.equal(skipped.skipped,1);assert.deepEqual(skipped.skipReasons,{CACHE_MISSING:failure==='missing'?1:0,TEXT_CHANGED:failure==='outdated'?1:0});}
    assert.deepEqual(rows.get(retained.id),retained);
    broker=createDistributionBroker(dependencies);const result=await send({type:'DISTRIBUTION_STATUS',initial:true});
    assert.equal(result.session.warning,'PARTIAL_RECORDING');assert.equal(result.session.errorCode,{missing:'CACHE_MISSING',outdated:'TEXT_CHANGED',invalid:'INVALID_ENTRY',quota:'QUOTA'}[failure]);assert.equal(result.session.count,1);
    const finish=latestWindow(),info=await send({type:'DISTRIBUTION_WINDOW_GET',intent:finish.intent},finish.sender);assert.equal(info.session.warning,'PARTIAL_RECORDING');
  }
});
await run('strict protected-span validation rejects matching malformed durable AI or manual rows',async()=>{
  for(const manual of [false,true])for(const text of ['<b>용사10%</b>\n전진\n','<b>용사-10%</b>\n전진','<i>용사10%</i>\n전진']){
    const {id}=await recording(),retained=await captureRow(id);
    canonical=portableEntry(await makeCacheEntry({source:'<b>勇者10%</b>\n進む',text,target:'한국어',manual}));
    let caught;
    try{await send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:canonical.source,text:canonical.text,target:canonical.target}]});}catch(e){caught=e;}
    assert(caught);const response=distributionErrorResponse(caught);
    assert.equal(response.code,'INVALID_ENTRY');assert.equal(response.retryable,false);
    assert.equal(response.session.errorCode,'INVALID_ENTRY');assert.equal(response.session.warning,'PARTIAL_RECORDING');
    assert.deepEqual([...rows.values()],[retained]);
    broker=createDistributionBroker(dependencies);
    const status=await send({type:'DISTRIBUTION_STATUS'});
    assert.equal(status.session.errorCode,'INVALID_ENTRY');assert.equal(status.session.count,1);
    canonical=portableEntry(await makeCacheEntry({source:canonical.source,text:'<b>용사10%</b>\n전진',target:'한국어',manual}));
    const valid=await send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:canonical.source,text:canonical.text,target:canonical.target}]});
    assert.equal(valid.accepted,1);assert.equal(valid.skipped,0);assert.equal(valid.session.count,2);
    assert.equal(valid.session.errorCode,'INVALID_ENTRY');
  }
});
await run('mixed canonical skip counts remain private and survive polling, restart and generic unload partial flags',async()=>{
  const {id}=await recording(),valid=await captureRow(id),originalGet=editor.get;
  const missing={source:'SYNTHETIC_PRIVATE_SOURCE',text:'SYNTHETIC_PRIVATE_TEXT',target:valid.target};
  editor.get=async({id:requested})=>requested===valid.id?{entry:clone(valid)}:null;
  try{
    const result=await send({type:'DISTRIBUTION_CAPTURE',id,items:[missing,{source:valid.source,text:'SYNTHETIC_OLD_TEXT',target:valid.target},{source:valid.source,text:valid.text,target:valid.target}]});
    assert.equal(result.accepted,1);assert.equal(result.skipped,2);assert.deepEqual(result.skipReasons,{CACHE_MISSING:1,TEXT_CHANGED:1});
    const diagnostic={code:result.session.errorCode,details:result.session.errorDetails};
    assert.deepEqual(diagnostic,{code:'CAPTURE_SKIPPED',details:{skipReasons:{CACHE_MISSING:1,TEXT_CHANGED:1}}});
    const persisted=clone(chrome.storage.local.data.distributionError);assert.deepEqual(persisted,{id,...diagnostic});
    const encoded=JSON.stringify(diagnostic);for(const value of [missing.source,missing.text,'SYNTHETIC_OLD_TEXT',valid.source,valid.text,state.fileName])assert(!encoded.includes(value));
    broker=createDistributionBroker(dependencies);
    await send({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:true});
    const polled=await send({type:'DISTRIBUTION_STATUS',initial:false});
    assert.equal(polled.session.errorCode,diagnostic.code);assert.deepEqual(polled.session.errorDetails,diagnostic.details);assert.deepEqual(chrome.storage.local.data.distributionError,persisted);
    assert.equal(rows.size,1);assert.deepEqual(rows.get(valid.id),valid);
  }finally{editor.get=originalGet;}
});
await run('unknown storage exceptions cannot export arbitrary diagnostic details',async()=>{
  const {id}=await recording(),entry=await captureRow(id);
  appendFailure=Object.assign(typed('SYNTHETIC_PRIVATE_CODE'),{details:{source:'SYNTHETIC_PRIVATE_SOURCE',fileName:state.fileName}});
  let caught;try{await send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:entry.source,text:entry.text,target:entry.target}]});}catch(e){caught=e;}
  const response=distributionErrorResponse(caught);assert.equal(response.code,'STORAGE');assert.equal(response.session.errorCode,'STORAGE');assert.equal(response.session.errorDetails,undefined);
  assert(!JSON.stringify({error:response.error,code:response.code,details:response.session.errorDetails}).includes('SYNTHETIC_PRIVATE'));
});
await run('automatic claim exists before popup creation and initial-first duplicate unload cannot create a second window',async()=>{
  const {id}=await recording(),before=opened.length,create=chrome.windows.create;
  chrome.windows.create=async options=>{
    assert.equal(state.status,'ready');assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],true);
    const nonce=new URL(options.url).searchParams.get('intent'),intent=chrome.storage.session.data['distributionIntent:'+nonce];
    assert.deepEqual(intent.owner,{tabId:7,frameId:2});assert.equal(intent.id,id);return create(options);
  };
  await Promise.all([send({type:'DISTRIBUTION_STATUS',initial:true}),send({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:false}),send({type:'DISTRIBUTION_STATUS',initial:true})]);
  assert.equal(opened.length,before+1);
});
await run('manual Finish overlapping refresh or unload keeps one writer and its original Finish intent valid',async()=>{
  for(const trigger of ['initial','stale-frame','unload']){
    const {id}=await recording(),entry=await captureRow(id),before=opened.length,create=chrome.windows.create;
    chrome.windows.create=async options=>{
      assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],true);
      return create(options);
    };
    chrome.tabs={sendMessage:absent};
    const manual=open('finish');
    const automatic=trigger==='unload'?send({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:false}):send({type:'DISTRIBUTION_STATUS',initial:true},trigger==='stale-frame'?other:game);
    const existing=await manual;await automatic;
    assert.equal(opened.length,before+1);assert.equal(state.status,'ready');
    assert.deepEqual(chrome.storage.session.data['distributionIntent:'+existing.intent].owner,{tabId:7,frameId:2});
    assert.equal((await send({type:'DISTRIBUTION_FREEZE',intent:existing.intent,id},existing.sender)).session.status,'ready');
    assert.deepEqual((await send({type:'DISTRIBUTION_PAGE',intent:existing.intent,id},existing.sender)).entries,[entry]);
    await send({type:'DISTRIBUTION_SAVED',intent:existing.intent,id},existing.sender);assert.equal(state.status,'saved');
  }
});
await run('failed automatic session claim leaves ready data and selected destination reachable through manual Finish',async()=>{
  const {id,selectionId}=await recording(),before=opened.length,set=chrome.storage.session.set;
  chrome.storage.session.set=async()=>{throw typed('STORAGE');};
  await assert.rejects(()=>send({type:'DISTRIBUTION_STATUS',initial:true}));
  assert.equal(state.status,'ready');assert.equal(opened.length,before);assert.equal(chrome.storage.local.data.distributionDestination.selectionId,selectionId);
  chrome.storage.session.set=set;
  assert.equal((await send({type:'DISTRIBUTION_STATUS',initial:true})).session.status,'ready');assert.equal(opened.length,before);
  const manual=await open('finish',id);assert.equal(manual.result.opened,true);
  assert.equal((await send({type:'DISTRIBUTION_WINDOW_GET',intent:manual.intent},manual.sender)).session.selectionId,selectionId);
});
await run('legacy ready orphan in a different closed tab exposes explicit Finish with original owner and destination',async()=>{
  const {id,selectionId}=await recording(),entry=await captureRow(id),owner=clone(state.owner);
  await store.finish(owner,id);broker=createDistributionBroker(dependencies);
  const before=opened.length,otherTab={...other,tab:{id:8}};
  const probes=[undefined,async()=>undefined,async()=>({ok:true}),async()=>{throw Error('Permission denied');},async()=>{throw Error('The message port closed before a response was received.');}];
  for(const probe of probes){
    if(probe)chrome.tabs={sendMessage:probe};else delete chrome.tabs;
    busy(await send({type:'DISTRIBUTION_STATUS',initial:true},otherTab),probe===probes[2]?'OWNER_ACTIVE':'OWNER_UNCONFIRMED');
    await reject({type:'DISTRIBUTION_OPEN',action:'finish',id},otherTab,'OWNER_MISMATCH');assert.equal(opened.length,before);
  }
  chrome.tabs={async get(tabId){assert.equal(tabId,owner.tabId);throw Error('No tab with id: 7.');},sendMessage(){throw Error('Closed tab must not be messaged');}};
  const ready=await send({type:'DISTRIBUTION_STATUS'},otherTab);
  assert.equal(ready.session.status,'ready');assert.equal(ready.session.id,id);assert.equal(ready.session.count,1);assert.equal(opened.length,before);
  for(const action of ['start','finish'])await reject({type:'DISTRIBUTION_OPEN',action},otherTab,'OWNER_MISMATCH');
  await reject({type:'DISTRIBUTION_OPEN',action:'finish',id:'dist:stale'},otherTab,'OWNER_MISMATCH');
  assert.equal((await send({type:'DISTRIBUTION_OPEN',action:'finish',id},otherTab)).opened,true);
  const finish=latestWindow(),info=await send({type:'DISTRIBUTION_WINDOW_GET',intent:finish.intent},finish.sender);
  assert.deepEqual(chrome.storage.session.data['distributionIntent:'+finish.intent].owner,owner);assert.equal(info.session.selectionId,selectionId);
  assert.deepEqual((await send({type:'DISTRIBUTION_PAGE',intent:finish.intent,id},finish.sender)).entries,[entry]);
  await send({type:'DISTRIBUTION_SAVED',intent:finish.intent,id},finish.sender);
  assert.equal((await send({type:'DISTRIBUTION_STATUS'},otherTab)).session.status,'idle');assert.deepEqual(state.owner,owner);
});
await run('failed manual Finish removes only its new claim; existing claim survives failed reopen and explicit recovery stays reachable',async()=>{
  for(const existingClaim of [false,true]){
    const {id}=await recording(),create=chrome.windows.create;
    if(existingClaim)await open('finish');
    const before=opened.length;
    chrome.windows.create=async()=>{throw Error('Window unavailable');};
    await assert.rejects(()=>open('finish'));
    assert.equal(state.status,'recording');assert.equal(opened.length,before);
    assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],existingClaim?true:undefined);
    chrome.windows.create=create;
    await send({type:'DISTRIBUTION_STATUS',initial:true});
    assert.equal(state.status,'ready');assert.equal(opened.length,before+(existingClaim?0:1));
    const automaticCount=opened.length,reopened=await open('finish',id);
    assert.equal(reopened.result.opened,true);assert.equal(opened.length,automaticCount+1);
    assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],true);
  }
});
await run('already closed old tab recovers every stored row and original selected-file intent before a new tab can Start',async()=>{
  for(const withTabLookup of [true,false]){
    const {id,selectionId}=await recording(),first=await captureRow(id),owner=clone(state.owner),otherTab={...game,tab:{id:8}};
    canonical=portableEntry(await makeCacheEntry({source:'月の勇者',text:'달의 용사',target:'한국어',createdAt:6,updatedAt:11,manual:true}));
    await send({type:'DISTRIBUTION_CAPTURE',id,items:[{source:canonical.source,text:canonical.text,target:canonical.target}]});
    const entries=[first,clone(canonical)],destination=clone(chrome.storage.local.data.distributionDestination),before=opened.length;
    let tabProbes=0,frameProbes=0;
    chrome.tabs={
      ...(withTabLookup?{async get(tabId){tabProbes++;assert.equal(tabId,owner.tabId);throw Error('No tab with id: 7.');}}:{}),
      async sendMessage(tabId,message,options){frameProbes++;assert.equal(tabId,owner.tabId);assert.equal(message.type,'GET_ENGINE_STATUS');assert.equal(options.frameId,owner.frameId);throw Error('No tab with id: 7.');}
    };
    broker=createDistributionBroker(dependencies);
    const recovered=await send({type:'DISTRIBUTION_STATUS'},otherTab);
    assert.equal(recovered.session.status,'ready');assert.equal(recovered.session.id,id);assert.equal(recovered.session.count,2);
    assert.equal(tabProbes,withTabLookup?1:0);assert.equal(frameProbes,withTabLookup?0:1);
    assert.equal(opened.length,before+1);assert.deepEqual(state.owner,owner);assert.deepEqual([...rows.values()],entries);
    assert.deepEqual(chrome.storage.local.data.distributionDestination,destination);assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],true);
    const finish=latestWindow(),intent=chrome.storage.session.data['distributionIntent:'+finish.intent];
    assert.deepEqual(intent.owner,owner);assert.equal(intent.id,id);assert.equal(intent.action,'finish');assert.equal(intent.automatic,true);
    const info=await send({type:'DISTRIBUTION_WINDOW_GET',intent:finish.intent},finish.sender);
    assert.equal(info.session.selectionId,selectionId);assert.equal(info.session.fileName,destination.fileName);
    await send({type:'DISTRIBUTION_FREEZE',intent:finish.intent,id},finish.sender);
    assert.deepEqual((await send({type:'DISTRIBUTION_PAGE',intent:finish.intent,id},finish.sender)).entries,entries);
    await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},otherTab,'OWNER_MISMATCH');
    await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},game,'FROZEN');
    broker=createDistributionBroker(dependencies);
    await send({type:'DISTRIBUTION_STATUS',initial:true},otherTab);await send({type:'DISTRIBUTION_STATUS'},other);
    assert.equal(state.status,'ready');assert.equal(opened.length,before+1);
    await send({type:'DISTRIBUTION_SAVED',intent:finish.intent,id},finish.sender);
    assert.equal((await send({type:'DISTRIBUTION_STATUS'},otherTab)).session.status,'idle');
    assert.equal(chrome.storage.local.data.distributionDestination,undefined);assert.equal(chrome.storage.session.data['distributionAutoFinish:'+id],undefined);
    assert.deepEqual(state.owner,owner);
    assert.equal((await send({type:'DISTRIBUTION_OPEN',action:'start'},otherTab)).opened,true);
    assert.equal(state.status,'saved');
  }
});
await run('removed old frame in a still-existing different tab is recoverable only for documented absence errors',async()=>{
  for(const message of ['No frame with id 2 in tab 7.','The frame was removed.','Frame with ID 2 was removed.','Could not establish connection. Receiving end does not exist.']){
    const {id}=await recording(),entry=await captureRow(id),owner=clone(state.owner),before=opened.length,probes=[];
    chrome.tabs={
      async get(tabId){probes.push('tab');assert.equal(tabId,owner.tabId);return {id:tabId};},
      async sendMessage(tabId,request,options){probes.push('frame');assert.equal(tabId,owner.tabId);assert.equal(request.type,'GET_ENGINE_STATUS');assert.equal(options.frameId,owner.frameId);throw Error(message);}
    };
    const result=await send({type:'DISTRIBUTION_STATUS',initial:true},{...other,tab:{id:8}});
    assert.equal(result.session.status,'ready');assert.equal(result.session.id,id);assert.deepEqual(probes,['tab','frame']);
    assert.deepEqual(state.owner,owner);assert.deepEqual(rows.get(entry.id),entry);assert.equal(opened.length,before+1);
  }
});
await run('tab lookup unknown errors, invalid replies and missing frame API fail closed even if a fallback could claim absence',async()=>{
  const {id}=await recording(),entry=await captureRow(id),owner=clone(state.owner),destination=clone(chrome.storage.local.data.distributionDestination),before=opened.length;
  const otherTab={...game,tab:{id:8}};
  for(const get of [async()=>{throw Error('Permission denied: SYNTHETIC_SECRET');},async()=>{throw Error('The message port closed before a response was received.');},async()=>{throw Error('No tab with id: 7. SYNTHETIC_SECRET');},async()=>undefined,async()=>({}),async()=>({id:8})]){
    let frames=0;
    chrome.tabs={get,async sendMessage(){frames++;return absent();}};
    busy(await send({type:'DISTRIBUTION_STATUS',initial:true},otherTab));
    await reject({type:'DISTRIBUTION_OPEN',action:'finish',id},otherTab,'OWNER_MISMATCH');assert.equal(frames,0);
  }
  chrome.tabs={async get(tabId){return {id:tabId};}};
  busy(await send({type:'DISTRIBUTION_STATUS'},otherTab));
  for(const sender of [other,otherTab])for(const action of ['start','finish'])await reject({type:'DISTRIBUTION_OPEN',action,id},sender,'OWNER_MISMATCH');
  assert.equal(state.status,'recording');assert.equal(opened.length,before);assert.deepEqual(state.owner,owner);
  assert.deepEqual(chrome.storage.local.data.distributionDestination,destination);assert.deepEqual([...rows.values()],[entry]);
});
await run('positively live cross-tab frame remains private after tab lookup and blocks every ownership-changing path',async()=>{
  const {id}=await recording(),entry=await captureRow(id),owner=clone(state.owner),before=opened.length,otherTab={...game,tab:{id:8}};
  chrome.tabs={async get(tabId){assert.equal(tabId,owner.tabId);return {id:tabId};},async sendMessage(tabId,message,options){assert.equal(tabId,owner.tabId);assert.equal(message.type,'GET_ENGINE_STATUS');assert.equal(options.frameId,owner.frameId);return {ok:true,enabled:true};}};
  for(const status of ['recording','ready']){
    if(status==='ready')await store.finish(owner,id);
    busy(await send({type:'DISTRIBUTION_STATUS',initial:true},otherTab),'OWNER_ACTIVE');
    for(const action of ['start','finish'])await reject({type:'DISTRIBUTION_OPEN',action,id},otherTab,'OWNER_MISMATCH');
    await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},otherTab,'OWNER_MISMATCH');
    await reject({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id,partial:false},otherTab,'OWNER_MISMATCH');
    assert.equal(state.status,status);assert.equal(opened.length,before);assert.deepEqual(state.owner,owner);assert.deepEqual([...rows.values()],[entry]);
  }
});
console.log('Distribution broker: '+tests+' offline mock tests passed. No live cache, browser, provider or settings changes.');
})().catch(e=>{console.error(e);process.exitCode=1;});
