// Isolated mock-IDB policy regressions, invoked by worker.cjs. No live browser/cache/provider.
module.exports=async function({send,cm,cache,rawCacheSet,databases,memory,httpCount,header,assert}){
let tests=0;const check=(name,fn)=>{fn();tests++;console.log('PASS merge policy: '+name);};
const metadata=()=>databases.get('crave-ai-cache').stores.get('cache-metadata').rows;
const stagedRows=()=>databases.get('crave-ai-cache').stores.get('imports').rows;
const count=()=>metadata().get('translation-count').count;
const file=rows=>cm.buildExport(rows).data;
const make=(text,manual=false,extra={})=>cm.makeCacheEntry({source:'衝突対象',target:'한국어',context:'Policy',text,createdAt:1,updatedAt:100,...(manual?{manual:true}:{}),...extra});
const baseline=async rows=>{const r=await send({type:'IMPORT_CACHE',mode:'replace',data:file(rows)});assert.equal(r.ok,true);};
const perform=async(route,rows,policy,mode='merge',override)=>{
 const options=policy===undefined?{}:{conflictPolicy:policy};
 if(route==='legacy')return send({type:'IMPORT_CACHE',data:file(rows),mode,...options});
 const s=await send({type:'IMPORT_START',mode,...options});assert.equal(s.ok,true);
 const job=metadata().get('transfer:'+s.token);assert.equal(job.conflictPolicy,policy);
 for(const row of rows){const p=await send({type:'IMPORT_BATCH',token:s.token,entries:[cm.portableEntry(row)],conflictPolicy:override});assert.equal(p.ok,true);assert.equal(metadata().get('transfer:'+s.token).conflictPolicy,policy);}
 return send({type:'IMPORT_COMMIT',token:s.token,header,expectedCount:rows.length,conflictPolicy:override});
};
const settings=JSON.stringify(memory.settings),usage=JSON.stringify(memory.usage),http=httpCount();
for(const route of ['legacy','stream']){
 for(const policy of ['keep-local','use-incoming'])for(const localManual of [false,true])for(const incomingManual of [false,true]){
  const local=await make('로컬 번역',localManual,{updatedAt:900});
  const incoming=await make('파일 번역',incomingManual,{updatedAt:100});
  await baseline([local]);const r=await perform(route,[incoming],policy,'merge',policy==='keep-local'?'use-incoming':'keep-local');
  check(`${route} ${policy} localManual=${localManual} incomingManual=${incomingManual}`,()=>{const use=policy==='use-incoming';assert.equal(r.ok,true);assert.equal(r.imported,use?1:0);assert.equal(r.skipped,use?0:1);assert.equal(r.cacheCount,1);assert.equal(count(),1);assert.equal(cache.get(local.id).text,use?incoming.text:local.text);assert.equal(cache.get(local.id).manual===true,use?incomingManual:localManual);assert.equal(cache.get(local.id).updatedAt,use?100:900);});
 }
 for(const [localManual,incomingManual,expected]of [[false,true,'파일 번역'],[true,false,'로컬 번역'],[false,false,'로컬 번역']]){
  const local=await make('로컬 번역',localManual),incoming=await make('파일 번역',incomingManual,{updatedAt:900});await baseline([local]);const r=await perform(route,[incoming]);
  check(`${route} omitted policy retains legacy manual priority ${localManual}/${incomingManual}`,()=>{assert.equal(r.ok,true);assert.equal(cache.get(local.id).text,expected);assert.equal(count(),1);});
 }
 for(const policy of ['keep-local','use-incoming']){
  const local=await make('로컬 번역'),incoming=await make('파일 번역');await baseline([local]);rawCacheSet(local.id,{...local,text:''});const repaired=await perform(route,[incoming],policy);
  check(`${route} ${policy} repairs unusable local`,()=>{assert.equal(repaired.ok,true);assert.equal(repaired.imported,1);assert.equal(cache.get(local.id).text,incoming.text);assert.equal(count(),1);});
  const manual=await make('파일 수동',true,{context:'Story',updatedAt:100}),auto=await make('파일 자동',false,{context:'Menu',updatedAt:999});
  for(const rows of [[manual,auto],[auto,manual]]){await baseline([]);const r=await perform(route,rows,policy);check(`${route} ${policy} duplicate preferred file row independent of order`,()=>{assert.equal(r.ok,true);assert.equal(r.imported,1);assert.equal(r.skipped,1);assert.equal(r.cacheCount,1);assert.equal(cache.get(manual.id).text,manual.text);assert.equal(cache.get(manual.id).manual,true);assert.equal(count(),1);});}
  const sibling=await make('English text',false,{target:'English'}),exact=await make('별도 원문',false,{source:'衝突対象 '});await baseline([local]);const r=await perform(route,[incoming,sibling,exact],policy);
  check(`${route} ${policy} exact source plus target identity and atomic count`,()=>{assert.equal(r.ok,true);assert.equal(r.imported,policy==='keep-local'?2:3);assert.equal(r.cacheCount,3);assert.equal(count(),3);assert.equal(cache.size,3);assert(cache.has(sibling.id));assert(cache.has(exact.id));});
  const replacement=await make('전체 교체',false);const rep=await perform(route,[replacement],policy,'replace');check(`${route} ${policy} replace semantics unchanged`,()=>{assert.equal(rep.ok,true);assert.equal(rep.imported,1);assert.equal(rep.cacheCount,1);assert.equal(count(),1);assert.equal(cache.get(replacement.id).text,replacement.text);});
 }
}
const seed=await make('안전한 기존 번역',true);await baseline([seed]);
for(const conflictPolicy of [null,'','KEEP_LOCAL','incoming',true,1,{},[]])for(const mode of ['merge','replace']){
 const before=JSON.stringify([...cache]),metaBefore=JSON.stringify([...metadata()]),stagedBefore=JSON.stringify([...stagedRows()]);
 const s=await send({type:'IMPORT_START',mode,conflictPolicy});const l=await send({type:'IMPORT_CACHE',mode,conflictPolicy,data:file([seed])});
 check(`malformed policy rejected before staging/writes ${JSON.stringify(conflictPolicy)} ${mode}`,()=>{assert.equal(s.ok,false);assert.equal(l.ok,false);assert.equal(JSON.stringify([...cache]),before);assert.equal(JSON.stringify([...metadata()]),metaBefore);assert.equal(JSON.stringify([...stagedRows()]),stagedBefore);});
}
for(const mode of ['merge','replace']){
 const s=await send({type:'IMPORT_START',mode,conflictPolicy:'use-incoming'});const row=await make('안전한 파일 번역');const before=JSON.stringify([...cache]),n=count();
 let r=await send({type:'IMPORT_BATCH',token:s.token,entries:[{...cm.portableEntry(row),text:'BAD 99'}]});
 check(`${mode} invalid staging cannot modify live rows/count`,()=>{assert.equal(r.ok,false);assert.equal(JSON.stringify([...cache]),before);assert.equal(count(),n);assert.equal(metadata().get('transfer:'+s.token).inputCount,0);});
 await send({type:'IMPORT_BATCH',token:s.token,entries:[cm.portableEntry(row)]});
 r=await send({type:'IMPORT_COMMIT',token:s.token,header,expectedCount:2});check(`${mode} truncated input count rejected atomically`,()=>{assert.equal(r.ok,false);assert.equal(JSON.stringify([...cache]),before);assert.equal(count(),n);});
 for(const [key,value]of stagedRows())if(value.token===s.token)stagedRows().delete(key);
 r=await send({type:'IMPORT_COMMIT',token:s.token,header,expectedCount:1});check(`${mode} missing persisted staged row aborts whole transaction`,()=>{assert.equal(r.ok,false);assert.equal(JSON.stringify([...cache]),before);assert.equal(count(),n);});
 await send({type:'IMPORT_ABORT',token:s.token});
}
check('all imports preserve settings usage secrets and invoke no HTTP',()=>{assert.equal(JSON.stringify(memory.settings),settings);assert.equal(JSON.stringify(memory.usage),usage);assert.equal(httpCount(),http);});
return tests;
};
