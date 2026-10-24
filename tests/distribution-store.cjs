// Synthetic bounded IDB model only, never a live cache or translation provider.
// Run: node --experimental-vm-modules tests/distribution-store.cjs
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..');
// Reuse the existing offline worker's IDB model, without executing its worker,
// Chrome, provider mocks or integration tests. Native IDB remains the authority.
const worker=fs.readFileSync(path.join(root,'tests/worker.cjs'),'utf8');
const start=worker.indexOf('const databases=new Map()'),end=worker.indexOf('// Trusted raw fixtures');
assert(start>=0&&end>start,'Offline IDB fixture boundaries changed');
const context=vm.createContext({console,setTimeout,clearTimeout,structuredClone,TextEncoder,TextDecoder,crypto:require('node:crypto').webcrypto});
vm.runInContext('let translationReads=0,beforeRead=null;const cache=new Map();\n'+worker.slice(start,end)+'\nglobalThis.testIDB=idb;globalThis.testDatabases=databases;globalThis.IDBKeyRange=IDBKeyRange;',context);
const modules=new Map();
function load(spec){if(modules.has(spec))return modules.get(spec);const m=new vm.SourceTextModule(fs.readFileSync(path.join(root,spec),'utf8'),{context,identifier:spec});modules.set(spec,m);return m;}
const mod=load('./distribution-store.mjs');await mod.link(load);await mod.evaluate();const cm=modules.get('./cache.mjs').namespace,{createDistributionStore,DistributionStoreError}=mod.namespace;
const idb=context.testIDB,databases=context.testDatabases,owner={tabId:7,frameId:3},other={tabId:7,frameId:4},name='crave-ai-distribution-synthetic-test';
let store=createDistributionStore(idb,{databaseName:name}),tests=0;
const test=async(name,fn)=>{await fn();tests++;console.log('PASS distribution: '+name);};
const rejects=(fn,code)=>assert.rejects(fn,e=>e instanceof DistributionStoreError&&e.code===code);
const row=async(source='星の勇者',text='별의 용사',extra={})=>cm.portableEntry(await cm.makeCacheEntry({source,text,target:'한국어',context:'synthetic',createdAt:10,updatedAt:20,...extra}));
let session;
try{
await test('strict owner, target and separate DB validation',async()=>{
for(const owner of [{tabId:'7',frameId:3},{tabId:7,frameId:0.5},{tabId:NaN,frameId:0},{tabId:1,frameId:-1}])await rejects(()=>store.start({owner,target:'한국어'}),'INVALID_OWNER');
await rejects(()=>store.start({owner,target:' 한국어'}),'INVALID_TARGET');await rejects(()=>store.start({owner,target:'한국어',fileName:'../private.json'}),'INVALID_FILE_NAME');
assert.throws(()=>createDistributionStore(idb,{databaseName:'crave-ai-cache'}),e=>e.code==='INVALID_DATABASE');assert.equal((await store.status()).status,'idle');
});
await test('one global recording across instances and durable owner metadata',async()=>{
session=await store.start({owner,target:'한국어',fileName:'recording.ndjson'});assert.equal(session.status,'recording');assert.equal(session.count,0);
const second=createDistributionStore(idb,{databaseName:name});try{await rejects(()=>second.start({owner:other,target:'한국어'}),'ACTIVE_SESSION');await rejects(()=>second.status(other),'OWNER_MISMATCH');assert.equal((await second.status(owner)).id,session.id);}finally{await second.close();}
});
await test('latest capture overrides old manual priority, timestamps and exact whitespace identity',async()=>{
const manual=await row(undefined,'수동 번역',{manual:true,createdAt:100,updatedAt:200}),automatic={...await row(undefined,'최신 캡처',{createdAt:1,updatedAt:2}),manual:false};
await store.append(owner,[manual]);await store.append(owner,[manual,automatic]);await store.append(owner,[await row('星の勇者 ','공백 있는 용사')]);assert.equal((await store.status()).count,2);
const db=await store._database();const state=databases.get(name).stores.get('entries').rows;const saved=[...state.values()].find(x=>x.entry.source===manual.source).entry;
assert.equal(saved.text,automatic.text);assert.equal(saved.manual,false);assert.equal(saved.createdAt,1);assert.equal(saved.updatedAt,2);assert.equal(db.objectStoreNames.contains('translations'),false);
});
await test('invalid schema/hash/protected text and mixed targets reject atomic batch',async()=>{
const before=JSON.stringify([...databases.get(name).stores.get('entries').rows]),good=await row('月の勇者','달의 용사');
for(const bad of [{...good,id:'v3:'+'0'.repeat(64)},{...good,apiKey:'SYNTHETIC_NOT_ALLOWED'},{...good,text:'99'},{...good,updatedAt:0}])await rejects(()=>store.append(owner,[good,bad]),'INVALID_ENTRY');
await rejects(async()=>store.append(owner,[good,await row('別の勇者','Other hero',{target:'English'})]),'TARGET_MISMATCH');await rejects(()=>store.append(other,[good]),'OWNER_MISMATCH');assert.equal(JSON.stringify([...databases.get(name).stores.get('entries').rows]),before);
});
await test('250 rows / 1MiB input limits are enforced before storage',async()=>{
const sample=await row();await rejects(()=>store.append(owner,Array(251).fill(sample)),'BATCH_LIMIT');
const large=await row('勇'.repeat(8192),'용'.repeat(24000));await rejects(()=>store.append(owner,Array(20).fill(large)),'BATCH_LIMIT');assert.equal((await store.status()).count,2);
});
await test('quota failure is typed and rolls back entire batch and metadata',async()=>{
const db=await store._database(),original=db.transaction.bind(db),before=JSON.stringify([...databases.get(name).stores.get('entries').rows]);let writes=0;
db.transaction=(names,mode)=>{const tx=original(names,mode),objectStore=tx.objectStore.bind(tx);tx.objectStore=n=>{const s=objectStore(n);if(n==='entries'&&mode==='readwrite'){const put=s.put;s.put=value=>{if(++writes===2)throw Object.assign(Error('Synthetic quota'),{name:'QuotaExceededError'});return put(value);};}return s;};return tx;};
try{await rejects(async()=>store.append(owner,[await row('山の勇者','산의 용사'),await row('海の勇者','바다의 용사')]),'QUOTA');}finally{db.transaction=original;}
assert.equal(JSON.stringify([...databases.get(name).stores.get('entries').rows]),before);assert.equal((await store.status()).count,2);assert.equal((await store.status()).status,'recording');
});
await test('worker restart resumes and disk-backed recording can exceed one page',async()=>{
await store.close();store=createDistributionStore(idb,{databaseName:name});assert.equal((await store.status(owner)).id,session.id);
const rows=[];for(let i=0;i<251;i++)rows.push(await row('物語'+String.fromCodePoint(0x4e00+i),'이야기'+String.fromCodePoint(0xac00+i)));
await store.append(owner,rows.slice(0,250));await store.append(owner,rows.slice(250));assert.equal((await store.status()).count,253);
});
await test('finish freezes atomically, is idempotent and retryable after external save failure',async()=>{
await rejects(()=>store.exportPage({id:session.id}),'INVALID_STATE');const ready=await store.finish(owner,session.id);assert.equal(ready.status,'ready');assert.equal((await store.finish(owner,session.id)).finishedAt,ready.finishedAt);
await rejects(async()=>store.append(owner,[await row()]),'FROZEN');await rejects(()=>store.start({owner,target:'한국어'}),'ACTIVE_SESSION');await rejects(()=>store.finish(other,session.id),'OWNER_MISMATCH');
await store.close();store=createDistributionStore(idb,{databaseName:name});assert.equal((await store.status()).status,'ready');
});
await test('stable bounded source-v3 pages omit internal/account data and enforce byte limits',async()=>{
for(const args of [{limit:251},{maxBytes:1048577},{cursor:'bad'}])await rejects(()=>store.exportPage({id:session.id,...args}),args.cursor?'INVALID_CURSOR':'PAGE_LIMIT');await rejects(()=>store.exportPage({id:session.id,maxBytes:1}),'ROW_TOO_LARGE');
let cursor=null,rows=[],pages=0;do{const p=await store.exportPage({id:session.id,cursor,limit:40,maxBytes:18000});assert(p.entries.length<=40&&p.bytes<=18000);assert.equal(p.bytes,p.entries.reduce((n,e)=>n+cm.byteSize(e)+1,0));rows.push(...p.entries);cursor=p.cursor;pages++;if(p.done)break;}while(cursor);
assert.equal(rows.length,253);assert(pages>1);assert.equal(new Set(rows.map(r=>r.id)).size,253);assert(rows.every(r=>r.id.startsWith('v3:')));await cm.validatePortableEntries(rows);
for(const r of rows)assert(Object.keys(r).every(k=>['id','source','target','context','text','manual','createdAt','updatedAt'].includes(k)));
assert.equal(JSON.stringify((await store.exportPage({id:session.id})).entries),JSON.stringify((await store.exportPage({id:session.id})).entries));
});
await test('saved performs bounded indexed cleanup, retains safe metadata, and is idempotent',async()=>{
const saved=await store.saved(owner,session.id);assert.equal(saved.status,'saved');assert.equal(saved.cleanupComplete,true);assert.equal(saved.count,253);assert.equal(databases.get(name).stores.get('entries').rows.size,0);assert.equal((await store.saved(owner,session.id)).savedAt,saved.savedAt);
assert.equal((await store.status()).status,'saved');assert.deepEqual([...databases.keys()],[name]);
});
await test('explicit discard and abort release recording without any personal cache operations',async()=>{
for(const method of ['discard','abort']){const s=await store.start({owner,target:'한국어'});await store.append(owner,[await row()]);assert.equal((await store[method](owner,s.id)).status,method==='abort'?'aborted':'discarded');await store[method](owner,s.id);assert.equal(databases.get(name).stores.get('entries').rows.size,0);}
assert.deepEqual([...databases.keys()],[name]);
});
console.log('Distribution store: '+tests+' synthetic tests passed. No live cache, AI, picker, account or network access.');
}finally{await store.destroy();assert.equal(databases.has(name),false);}
})().catch(e=>{console.error(e);process.exitCode=1;});
