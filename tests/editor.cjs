// Pure mocked IDB coverage. Real native transaction/scale testing remains authoritative.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..');
const data=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const core=data(fs.readFileSync(path.join(root,'core.mjs'),'utf8'));
const reliability=data(fs.readFileSync(path.join(root,'reliability.mjs'),'utf8'));
const dialogueUrl=data(fs.readFileSync(path.join(root,'dialogue-text.js'),'utf8'));
const cacheUrl=data(fs.readFileSync(path.join(root,'cache.mjs'),'utf8').replace("from './core.mjs'",`from '${core}'`).replace("from './reliability.mjs'",`from '${reliability}'`).replace("import './dialogue-text.js'",`import '${dialogueUrl}'`));
const C=await import(cacheUrl);
const E=await import(data(fs.readFileSync(path.join(root,'cache-editor.mjs'),'utf8').replace("from './cache.mjs'",`from '${cacheUrl}'`)));
const S=await import(data(fs.readFileSync(path.join(root,'cache-store.mjs'),'utf8').replace("from './cache.mjs'",`from '${cacheUrl}'`).replace("from './core.mjs'",`from '${core}'`).replace("from './reliability.mjs'",`from '${reliability}'`)));
const cmp=(a,b)=>JSON.stringify(a)===JSON.stringify(b)?0:Array.isArray(a)&&Array.isArray(b)?(()=>{for(let i=0;i<a.length;i++){const n=cmp(a[i],b[i]);if(n)return n;}return 0;})():a<b?-1:1;
global.IDBKeyRange={bound:(lower,upper,lowerOpen=false,upperOpen=false)=>({lower,upper,lowerOpen,upperOpen}),lowerBound:(lower,lowerOpen=false)=>({lower,lowerOpen})};
const inRange=(key,r)=>!r||((r.lower===undefined||cmp(key,r.lower)>(r.lowerOpen?0:-1))&&(r.upper===undefined||cmp(key,r.upper)<(r.upperOpen?0:1)));
function mockDatabase(initial=[]){
  const maps={translations:new Map(initial.map(e=>[e.id,structuredClone(e)])),'cache-metadata':new Map([['translation-count',{id:'translation-count',count:initial.length}],['source-identity-v3-dialogue-v1',{id:'source-identity-v3-dialogue-v1',done:true}]])};
  const stats={getAll:[],count:0,reads:0};let beforeWrite=null;
  const db={maps,stats,close(){},setBeforeWrite(fn){beforeWrite=fn;},transaction(names,mode){
    if(mode==='readwrite'&&beforeWrite){const fn=beforeWrite;beforeWrite=null;fn();}
    const backups=mode==='readwrite'?structuredClone(maps):null;let pending=0,ended=false;
    const tx={abort(){if(ended)return;ended=true;if(backups)for(const k of Object.keys(maps))maps[k]=backups[k];queueMicrotask(()=>tx.onabort?.());},objectStore(name){
      const request=fn=>{const r={};pending++;queueMicrotask(()=>{if(ended)return;try{r.result=structuredClone(fn());r.onsuccess?.();}catch(e){tx.error=e;tx.abort();}finally{pending--;complete();}});return r;};
      const records=(range,count,keyFn=e=>e.id)=>[...maps[name].values()].filter(e=>inRange(keyFn(e),range)).sort((a,b)=>cmp(keyFn(a),keyFn(b))).slice(0,count);
      return {get(id){stats.reads++;return request(()=>maps[name].get(id));},put(e){return request(()=>{maps[name].set(e.id,structuredClone(e));return e.id;});},delete(id){return request(()=>maps[name].delete(id));},clear(){return request(()=>maps[name].clear());},count(){stats.count++;return request(()=>maps[name].size);},getAll(range,count){stats.getAll.push(count);return request(()=>records(range,count));},index(indexName){const key=e=>indexName==='targetRecent'?[e.target,e.reverseTime,e.id]:e.time;return {getAll(range,count){stats.getAll.push(count);return request(()=>records(range,count,key));}};}};}};
    function complete(){queueMicrotask(()=>{if(!pending&&!ended){ended=true;tx.oncomplete?.();}});}complete();return tx;
  }};
  return db;
}
const fakeIDB=db=>({open(){const r={result:db};queueMicrotask(()=>r.onsuccess?.());return r;}});
const cacheFor=db=>({_database:async()=>db,count:async()=>db.maps['cache-metadata'].get('translation-count').count});
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const target='한국어';const entry=await C.makeCacheEntry({source:'攻撃10%<b>名前</b>\n{value}',target,context:'Skill',text:'공격10%<b>이름</b>\n{value}',createdAt:10,updatedAt:20});
await test('get portable full, no credentials/private fields; strict ids',async()=>{
  const db=mockDatabase([{...entry,apiKey:'SECRET',endpoint:'SECRET',privateExtra:'SECRET'}]),editor=E.createCacheEditor(cacheFor(db));
  const result=await editor.get({id:entry.id});assert.deepEqual(result.version,{updatedAt:20,text:entry.text});assert(!JSON.stringify(result).includes('SECRET'));assert(!Object.hasOwn(result.entry,'reverseTime'));
  for(const id of ['v2:'+'0'.repeat(64),'v3:BAD',null,'v3:'+'A'.repeat(64)])await assert.rejects(()=>editor.get({id}),{code:'INVALID'});
});
await test('save CAS, immutable source/context, manual flag, monotonic time and exact count',async()=>{
  const db=mockDatabase([entry]),editor=E.createCacheEditor(cacheFor(db));
  const input={id:entry.id,source:entry.source,target,text:entry.text.replace('공격','공격력'),expectedUpdatedAt:20,expectedText:entry.text,context:'ATTACK',apiKey:'SECRET'};
  const saved=await editor.save(input);assert.equal(saved.entry.manual,true);assert.equal(saved.entry.context,'Skill');assert.equal(saved.cacheCount,1);assert(saved.entry.updatedAt>20);assert.equal(saved.entry.createdAt,10);assert(!JSON.stringify(saved).includes('SECRET'));
  assert.equal(db.maps.translations.get(entry.id).reverseTime,Number.MAX_SAFE_INTEGER-saved.entry.updatedAt);
  await assert.rejects(()=>editor.save(input),{code:'CONFLICT'});
  await assert.rejects(()=>editor.save({...input,source:entry.source+' ',expectedUpdatedAt:saved.entry.updatedAt,expectedText:saved.entry.text}),{code:'CONFLICT'});
  await assert.rejects(()=>editor.save({...input,create:true}),{code:'CONFLICT'});
});
await test('transaction re-read blocks write racing after initial get',async()=>{
  const db=mockDatabase([entry]),editor=E.createCacheEditor(cacheFor(db));
  db.setBeforeWrite(()=>db.maps.translations.set(entry.id,{...entry,text:entry.text+' 새번역',updatedAt:21}));
  await assert.rejects(()=>editor.save({id:entry.id,source:entry.source,target,text:entry.text,expectedUpdatedAt:20,expectedText:entry.text}),{code:'CONFLICT'});
  assert.equal(db.maps.translations.get(entry.id).updatedAt,21);
});
await test('number/tag/variable/newline rejection is safe and atomic',async()=>{
  const db=mockDatabase([entry]),editor=E.createCacheEditor(cacheFor(db));
  for(const text of [entry.text.replace('10','20'),entry.text.replace('<b>',''),entry.text.replace('{value}',''),entry.text.replace('\n',' ')])await assert.rejects(()=>editor.save({id:entry.id,source:entry.source,target,text,expectedUpdatedAt:20,expectedText:entry.text}),e=>e.code==='INVALID'&&!e.message.includes(text));
  assert.equal(db.maps.translations.get(entry.id).text,entry.text);assert.equal(db.maps['cache-metadata'].get('translation-count').count,1);
});
await test('manual editor allows USER movement but rejects count changes and reordered ordinary spans',async()=>{
  const named=await C.makeCacheEntry({source:'{USER}の攻撃10%\n{value}',target,text:'{USER}의 공격10%\n{value}',createdAt:10,updatedAt:20}),db=mockDatabase([named]),editor=E.createCacheEditor(cacheFor(db));
  for(const text of ['공격10%\n{value}','{USER}공격10%\n{value}{USER}','공격\n10%{value}{USER}'])await assert.rejects(()=>editor.save({id:named.id,source:named.source,target,text,expectedUpdatedAt:20,expectedText:named.text}),{code:'INVALID'});
  const text='공격10%\n{value}{USER}',saved=await editor.save({id:named.id,source:named.source,target,text,expectedUpdatedAt:20,expectedText:named.text});
  assert.equal(saved.entry.text,text);assert.equal(saved.entry.manual,true);assert.equal(saved.cacheCount,1);
});
await test('explicit create pins unchanged JP; automatic put and warm preserve manual',async()=>{
  const db=mockDatabase(),store=S.createCacheStore(fakeIDB(db),{databaseName:'editor-unit'}),editor=E.createCacheEditor(store),source='アーサー',id=await C.cacheId(target,source);
  const saved=await editor.save({source,target,text:source,create:true,context:'UNTRUSTED'});assert.equal(saved.entry.id,id);assert.deepEqual(saved.version,{updatedAt:saved.entry.updatedAt,text:source});assert.equal(saved.cacheCount,1);assert.equal(saved.entry.context,'manual edit');
  assert.equal((await store.lookup({source,context:'OTHER'},{target})).text,source);
  await store.put([{source,text:'아서'}],{target});assert.equal((await store.lookup({source},{target})).manual,true);assert.equal(await store.count(),1);
  const warm=await store.warm(target);assert.equal(warm.entries[0].text,source);assert.equal(db.stats.count,0);
  await store.close();
});
await test('manual import outranks automatic despite merge keepExisting and older time',async()=>{
  const db=mockDatabase([entry]),store=S.createCacheStore(fakeIDB(db),{databaseName:'manual-import-unit'});
  const manual=await C.makeCacheEntry({...entry,text:entry.source,updatedAt:10,manual:true});
  const merged=await store.importBatch([C.portableEntry(manual)]);assert.equal(merged.imported,1);assert.equal((await store.lookup({source:entry.source},{target})).manual,true);assert.equal(await store.count(),1);await store.close();
});
await test('exact source gets bad/unchanged cache directly and does not scan',async()=>{
  const bad={...entry,text:'99 invalid'},db=mockDatabase([bad]),editor=E.createCacheEditor(cacheFor(db));
  const result=await editor.search({query:entry.source,target,mode:'exact'});assert.equal(result.results.length,1);assert.equal(result.scanned,1);assert.equal(db.stats.getAll.length,0);
  assert.equal((await editor.search({query:entry.source+' ',target,mode:'exact'})).results.length,0);
  const spaced=await C.makeCacheEntry({...entry,source:' '+entry.source+' ',text:entry.text});db.maps.translations.set(spaced.id,spaced);
  assert.equal((await editor.search({query:spaced.source,target,mode:'exact'})).results[0].id,spaced.id);
});
await test('incremental matches no skips, prefix/target filters and cancellation stateless',async()=>{
  const rows=Array.from({length:1100},(_,i)=>({...entry,id:'v3:'+i.toString(16).padStart(64,'0'),source:i%2?'Needle original':'other original',text:i%2?'other translated':'NEEDLE translated',target:i%11?'한국어':'English'}));
  rows.push({...entry,id:'v2:'+'0'.repeat(64),source:'Needle'});
  const db=mockDatabase(rows),editor=E.createCacheEditor(cacheFor(db));let cursor=null,ids=[],calls=0;
  do{const page=await editor.search({query:'needle',target,cursor});assert(page.scanned<=512);assert(page.results.length<=20);ids.push(...page.results.map(x=>x.id));cursor=page.cursor;calls++;if(page.done)break;}while(cursor&&calls<100);
  assert.equal(new Set(ids).size,1000);assert.equal(ids.length,1000);assert(db.stats.getAll.every(n=>n<=32));assert.equal(db.stats.count,0);
  const start=await editor.search({query:'needle',target}),replay=await editor.search({query:'needle',target});assert.deepEqual(start,replay);const again=E.createCacheEditor(cacheFor(db));assert.deepEqual(await again.search({query:'needle',target,cursor:start.cursor}),await editor.search({query:'needle',target,cursor:start.cursor}));
  const empty=await editor.search({query:'not found',target});assert.equal(empty.scanned,512);assert.equal(empty.results.length,0);assert.equal(empty.done,false);assert(empty.cursor);
});
await test('2MiB scan budget resumes last actually processed; previews bounded',async()=>{
  const rows=Array.from({length:80},(_,i)=>({...entry,id:'v3:'+i.toString(16).padStart(64,'0'),source:'攻'.repeat(8192),text:'한'.repeat(49152)}));
  const db=mockDatabase(rows),editor=E.createCacheEditor(cacheFor(db));let cursor=null,total=0;
  do{const page=await editor.search({cursor});assert(page.scanned<20);assert(page.scanned*C.byteSize(rows[0])<=2*1024*1024);assert(page.results.every(e=>e.sourcePreview.length<=180&&e.textPreview.length<=300));total+=page.results.length;cursor=page.cursor;if(page.done)break;}while(cursor);
  assert.equal(total,80);
});
await test('bounded input rejects regex-like interpretation and unsafe cursors',async()=>{
  const editor=E.createCacheEditor(cacheFor(mockDatabase([entry])));
  assert.equal((await editor.search({query:'.*'})).results.length,0);
  for(const input of [{query:'a'.repeat(257)},{query:'a'.repeat(8193),mode:'exact',target},{cursor:'v2:'+'0'.repeat(64)},{limit:21},{limit:0},{mode:'regex'},{mode:'exact',query:'a'},{target:' '+target}])await assert.rejects(()=>editor.search(input),{code:'INVALID'});
});

const deletionRequest=e=>({id:e.id,source:e.source,target:e.target,expectedUpdatedAt:e.updatedAt,expectedText:e.text});
await test('single delete removes canonical row only and decrements maintained count',async()=>{
  const other=await C.makeCacheEntry({...entry,source:'他の原文10%',text:'다른 원문10%'}),legacy={...entry,id:'legacy-opaque-key'},v2={...entry,id:'v2:'+'1'.repeat(64)};
  const db=mockDatabase([entry,other,legacy,v2]),editor=E.createCacheEditor(cacheFor(db)),before=structuredClone(db.maps.translations);
  assert.deepEqual(await editor.remove(deletionRequest(entry)),{deleted:1,source:entry.source,target,cacheCount:3});
  assert(!db.maps.translations.has(entry.id));for(const e of [other,legacy,v2])assert.deepEqual(db.maps.translations.get(e.id),before.get(e.id));
  assert.equal(db.maps['cache-metadata'].get('translation-count').count,3);assert.equal(db.stats.count,0);
  await assert.rejects(()=>editor.remove(deletionRequest(entry)),{code:'CONFLICT'});assert.equal(db.maps['cache-metadata'].get('translation-count').count,3);
});
await test('delete guards immutable identity, both optimistic tokens and canonical IDs',async()=>{
  const db=mockDatabase([entry]),editor=E.createCacheEditor(cacheFor(db)),request=deletionRequest(entry);
  for(const patch of [{source:entry.source+' '},{target:'English'},{expectedUpdatedAt:21},{expectedText:entry.text+' stale'}])await assert.rejects(()=>editor.remove({...request,...patch}),{code:'CONFLICT'});
  for(const patch of [{id:'v2:'+'1'.repeat(64)},{expectedUpdatedAt:undefined},{expectedText:undefined},{source:''},{target:' '+target}])await assert.rejects(()=>editor.remove({...request,...patch}),{code:'INVALID'});
  assert.deepEqual(db.maps.translations.get(entry.id),entry);assert.equal(db.maps['cache-metadata'].get('translation-count').count,1);
  const forged={...entry,id:'v3:'+'0'.repeat(64)};db.maps.translations.set(forged.id,forged);
  await assert.rejects(()=>editor.remove(deletionRequest(forged)),{code:'INVALID'});assert(db.maps.translations.has(forged.id));
});
await test('delete transaction re-read blocks concurrent token and immutable-field changes',async()=>{
  for(const patch of [{text:entry.text+' raced'},{updatedAt:21},{source:entry.source+' raced'},{target:'English'}]){
    const db=mockDatabase([entry]),editor=E.createCacheEditor(cacheFor(db));
    db.setBeforeWrite(()=>db.maps.translations.set(entry.id,{...entry,...patch}));
    await assert.rejects(()=>editor.remove(deletionRequest(entry)),{code:'CONFLICT'});
    assert.deepEqual(db.maps.translations.get(entry.id),{...entry,...patch});assert.equal(db.maps['cache-metadata'].get('translation-count').count,1);
  }
});
await test('delete transaction handles concurrent disappearance without count changes',async()=>{
  const db=mockDatabase([entry]),editor=E.createCacheEditor(cacheFor(db));
  db.setBeforeWrite(()=>{db.maps.translations.delete(entry.id);db.maps['cache-metadata'].set('translation-count',{id:'translation-count',count:0});});
  await assert.rejects(()=>editor.remove(deletionRequest(entry)),{code:'CONFLICT'});assert.equal(db.maps['cache-metadata'].get('translation-count').count,0);
});
await test('delete rejects broken counters atomically and permits unusable existing translations',async()=>{
  for(const count of [0,-1,undefined,1.5]){
    const db=mockDatabase([entry]),editor=E.createCacheEditor(cacheFor(db));db.maps['cache-metadata'].set('translation-count',{id:'translation-count',count});
    await assert.rejects(()=>editor.remove(deletionRequest(entry)),{code:'STORAGE'});assert.deepEqual(db.maps.translations.get(entry.id),entry);assert.equal(db.maps['cache-metadata'].get('translation-count').count,count);assert(!db.maps['cache-metadata'].has('deleted-source:'+entry.id));
  }
  const bad={...entry,text:'invalid changed 99%'},db=mockDatabase([bad]),editor=E.createCacheEditor(cacheFor(db));
  assert.equal((await editor.remove(deletionRequest(bad))).cacheCount,0);assert.equal(db.maps.translations.size,0);
});


const legacyCore=await import(core),legacySettings={target,provider:'custom',model:'legacy-fixture',endpoint:'https://example.invalid/v1'};
const tombstoneId=id=>'deleted-source:'+id;
const opaqueFor=async(source,context,text)=>{const id=await legacyCore.hashKey(legacyCore.legacyCacheIdentity(legacySettings,source,context));return {id,text,time:5};};
await test('single delete stores hashed tombstone atomically without touching matching opaque legacy rows',async()=>{
  const opaque=await opaqueFor(entry.source,'Skill',entry.text),db=mockDatabase([entry,opaque]),store=S.createCacheStore(fakeIDB(db),{databaseName:'tombstone-unit'}),editor=E.createCacheEditor(store);
  const result=await editor.remove(deletionRequest(entry));assert.equal(result.cacheCount,1);
  assert.deepEqual(db.maps['cache-metadata'].get(tombstoneId(entry.id)),{id:tombstoneId(entry.id),deleted:true});
  assert.deepEqual(db.maps.translations.get(opaque.id),opaque);
  assert.equal(await store.lookup({source:entry.source,context:'Skill'},legacySettings),null);
  assert(!db.maps.translations.has(entry.id));assert.deepEqual(db.maps.translations.get(opaque.id),opaque);assert.equal(await store.count(),1);await store.close();
});
await test('failed delete creates no tombstone and preserves legacy lookup compatibility',async()=>{
  const opaque=await opaqueFor(entry.source,'Skill',entry.text),db=mockDatabase([entry,opaque]),store=S.createCacheStore(fakeIDB(db),{databaseName:'tombstone-failure-unit'}),editor=E.createCacheEditor(store);
  await assert.rejects(()=>editor.remove({...deletionRequest(entry),expectedText:'stale'}),{code:'CONFLICT'});
  assert(!db.maps['cache-metadata'].has(tombstoneId(entry.id)));assert.equal(await store.count(),2);
  db.maps.translations.set(entry.id,{...entry,text:entry.source});
  assert.equal((await store.lookup({source:entry.source,context:'Skill'},legacySettings)).text,entry.text);
  assert(!db.maps.translations.has(opaque.id));assert.equal(await store.count(),1);await store.close();
});
await test('promotion atomically rechecks tombstone after an earlier legacy read',async()=>{
  const bad={...entry,text:entry.source},opaque=await opaqueFor(entry.source,'Skill',entry.text),db=mockDatabase([bad,opaque]),store=S.createCacheStore(fakeIDB(db),{databaseName:'tombstone-race-unit'});
  await store.count();
  db.setBeforeWrite(()=>{db.maps.translations.delete(entry.id);db.maps['cache-metadata'].set(tombstoneId(entry.id),{id:tombstoneId(entry.id),deleted:true});db.maps['cache-metadata'].set('translation-count',{id:'translation-count',count:1});});
  assert.equal(await store.lookup({source:entry.source,context:'Skill'},legacySettings),null);
  assert(!db.maps.translations.has(entry.id));assert.deepEqual(db.maps.translations.get(opaque.id),opaque);assert.equal(await store.count(),1);await store.close();
});
await test('tombstones permit future canonical automatic manual and imported translations',async()=>{
  for(const mode of ['automatic','manual','import']){
    const opaque=await opaqueFor(entry.source,'Skill',entry.text),db=mockDatabase([entry,opaque]),store=S.createCacheStore(fakeIDB(db),{databaseName:'tombstone-recreate-'+mode}),editor=E.createCacheEditor(store);
    await editor.remove(deletionRequest(entry));
    const freshText=entry.text.replace('공격','새 공격');
    if(mode==='automatic')await store.put([{source:entry.source,context:'fresh',text:freshText}],legacySettings);
    if(mode==='manual')await editor.save({source:entry.source,target,text:freshText,create:true});
    if(mode==='import')await store.importBatch([C.portableEntry(await C.makeCacheEntry({...entry,text:freshText}))]);
    assert.equal((await store.lookup({source:entry.source,context:'Skill'},legacySettings)).text,freshText);
    assert(db.maps['cache-metadata'].has(tombstoneId(entry.id)));assert.deepEqual(db.maps.translations.get(opaque.id),opaque);assert.equal(await store.count(),2);await store.close();
  }
});
await test('source tombstone does not block unrelated legacy promotion',async()=>{
  const otherSource='既存互換',opaque=await opaqueFor(otherSource,'Menu','기존 호환'),db=mockDatabase([entry,opaque]),store=S.createCacheStore(fakeIDB(db),{databaseName:'tombstone-compatible-unit'}),editor=E.createCacheEditor(store);
  await editor.remove(deletionRequest(entry));
  assert.equal((await store.lookup({source:otherSource,context:'Menu'},legacySettings)).text,'기존 호환');assert(!db.maps.translations.has(opaque.id));assert.equal(await store.count(),1);await store.close();
});

console.log(passed+' mocked editor tests passed. Native IndexedDB remains authoritative.');
})().catch(e=>{console.error(e);process.exitCode=1;});
