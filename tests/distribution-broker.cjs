// Offline authorization/lifecycle mocks only. No browser, installs, user cache or AI.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
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
const send=(message,sender=game)=>broker.handle(message,sender);
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
assert.deepEqual((await send({type:'DISTRIBUTION_STATUS'},other)).session,{status:'busy',count:0});await reject({type:'DISTRIBUTION_OPEN',action:'finish',id},other,'OWNER_MISMATCH');await reject({type:'DISTRIBUTION_CAPTURE',id,items:[]},other,'OWNER_MISMATCH');assert(!Object.hasOwn((await send({type:'DISTRIBUTION_STATUS'})).session,'selectionId'));
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
const frozen=await send({type:'DISTRIBUTION_FREEZE',intent:window.intent,id},window.sender);assert.equal(frozen.status,'ready');assert.equal(frozen.header.identity,'source-v3');assert.equal(frozen.header.appVersion,'0.3.5');assert.equal(frozen.session.count,1);assert.equal((await send({type:'DISTRIBUTION_FREEZE',intent:window.intent,id},window.sender)).header.exportedAt,frozen.header.exportedAt);
});
await run('client-reported partial finish is strict, owner/id scoped and persists a warning',async()=>{
await reject({type:'DISTRIBUTION_OPEN',action:'finish',id,partial:'true'},game,'INVALID_ENTRY');await reject({type:'DISTRIBUTION_OPEN',action:'start',partial:false},game,'INVALID_ENTRY');await reject({type:'DISTRIBUTION_OPEN',action:'finish',partial:true},game,'STALE_SESSION');await reject({type:'DISTRIBUTION_OPEN',action:'finish',id:'dist:stale',partial:true},game,'STALE_SESSION');await reject({type:'DISTRIBUTION_OPEN',action:'finish',id,partial:true},other,'OWNER_MISMATCH');
const result=await send({type:'DISTRIBUTION_OPEN',action:'finish',id,partial:true});assert.equal(result.opened,true);assert.equal(result.session.status,'ready');assert.equal(result.session.warning,'PARTIAL_RECORDING');assert.deepEqual(chrome.storage.local.data.distributionError,{id,code:'STORAGE'});
const nonce=new URL(opened.at(-1).url).searchParams.get('intent');const info=await send({type:'DISTRIBUTION_WINDOW_GET',intent:nonce},{id:'offline',url:opened.at(-1).url,frameId:0});assert.equal(info.session.errorCode,'STORAGE');
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
assert(calls.every(x=>!Object.hasOwn(x,'settings')));const bg=fs.readFileSync(path.join(root,'background.mjs'),'utf8');assert(bg.indexOf("if(message.type.startsWith('DISTRIBUTION_'))")<bg.indexOf('if(!isAdmin(sender)&&!isGame(sender))'));assert(!bg.includes('distribution.html\');}'));
assert.equal(distributionErrorResponse(Error('SECRET')).error,'녹화를 저장하지 못했습니다. 다시 시도해 주세요.');
});
console.log('Distribution broker: '+tests+' offline mock tests passed. No live cache, browser, provider or settings changes.');
})().catch(e=>{console.error(e);process.exitCode=1;});
