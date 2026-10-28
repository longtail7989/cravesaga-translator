import {createCacheStore} from '../cache-store.mjs';
import {createCacheTransfer} from '../cache-transfer.mjs';
import {makeCacheEntry,portableEntry,buildExport,CACHE_FORMAT} from '../cache.mjs';
import {createDistributionStore} from '../distribution-store.mjs';
const $=x=>document.getElementById(x),results=[],owned=[];
const check=(v,s)=>{if(!v)throw Error(s);};
const rejected=async fn=>{let failed=false;try{await fn();}catch{failed=true;}check(failed,'Operation should have rejected');};
const txRun=(db,names,mode,fn)=>new Promise((resolve,reject)=>{const tx=db.transaction(names,mode);let result;tx.oncomplete=()=>resolve(typeof result==='function'?result():result);tx.onabort=tx.onerror=()=>reject(tx.error||Error('transaction failed'));try{fn(tx,x=>{result=x;});}catch(e){tx.abort();reject(e);}});
const row=async(source,text,manual=false,time=20,target='한국어')=>portableEntry(await makeCacheEntry({source,text,target,context:'synthetic',manual,createdAt:time,updatedAt:time}));
const header={format:CACHE_FORMAT,version:3,identity:'source-v3',exportedAt:new Date().toISOString(),appVersion:'0.3.2'};
async function test(name,fn){const before=performance.now();try{await fn();results.push({name,passed:true,ms:performance.now()-before});}catch(e){results.push({name,passed:false,error:String(e.message)});throw e;}finally{$('results').textContent=JSON.stringify(results,null,2);}}
$('start').addEventListener('click',()=>{if($('start').disabled)return;$('start').disabled=true;window.__mergePromise=run();});
async function run(){results.length=0;const name='crave-ai-merge-test-'+crypto.randomUUID();owned.push(name);let store,transfer,db;try{
 store=createCacheStore(indexedDB,{databaseName:name});transfer=createCacheTransfer(store);db=await store._database();
 const lookup=(source,target='한국어')=>store.lookup({source,context:'changed context'},{target,provider:'mock',model:'no-ai'});
 const count=()=>txRun(db,'translations','readonly',(tx,set)=>{const r=tx.objectStore('translations').count();r.onsuccess=()=>set(r.result);});
 const apply=async(entries,policy,stream)=>{if(!stream)return store.import(buildExport(entries).data,'merge',{conflictPolicy:policy});const s=await transfer.importStart('merge',{conflictPolicy:policy});await transfer.importStage(s.token,entries);return transfer.importCommit(s.token,header,{expectedCount:entries.length});};
 for(const stream of [false,true])for(const policy of ['keep-local','use-incoming'])await test((stream?'NDJSON':'JSON')+' '+policy+' manual/auto matrix; exact identities and atomic counts',async()=>{
  for(const localManual of [false,true])for(const fileManual of [false,true]){
   const local=await row('星の勇者','별의 용사',localManual,40),incoming=await row(local.source,'별의 영웅',fileManual,10),localOnly=await row('月の祭壇','달의 제단'),spaced=await row(local.source+' ','공백 있는 영웅'),english=await row(local.source,'Star hero',false,20,'English'),fileOnly=await row('夜の神殿','밤의 신전');
   await store.import(buildExport([local,localOnly,spaced,english]).data,'replace');
   const result=await apply([incoming,fileOnly],policy,stream),hit=await lookup(local.source),winner=policy==='keep-local'?local:incoming;
   check(hit?.text===winner.text,'Wrong chosen translation');check((hit.manual===true)===(winner.manual===true),'Manual flag inherited or lost');check(hit.updatedAt===winner.updatedAt,'Chosen timestamp changed');check((await lookup(localOnly.source))?.text===localOnly.text,'Local-only removed');check((await lookup(spaced.source))?.text===spaced.text,'Whitespace identity changed');check((await lookup(english.source,'English'))?.text===english.text,'Language identity changed');check((await lookup(fileOnly.source))?.text===fileOnly.text,'File-only missing');check(result.imported===(policy==='keep-local'?1:2)&&result.skipped===(policy==='keep-local'?1:0),'Report mismatch');check(result.cacheCount===5&&await count()===5&&await store.count()===5,'Atomic count mismatch');
  }
 });
 await test('Incoming duplicate rows choose deterministic manual winner across pages and order',async()=>{const local=await row('星の勇者','별의 용사',true,50),automatic=await row(local.source,'별의 영웅',false,80),manual=await row(local.source,'별의 수호자',true,10);for(const stream of [false,true])for(const entries of [[automatic,manual],[manual,automatic]]){await store.import(buildExport([local]).data,'replace');let r;if(stream){const s=await transfer.importStart('merge',{conflictPolicy:'use-incoming'});for(const e of entries)await transfer.importStage(s.token,[e]);r=await transfer.importCommit(s.token,header,{expectedCount:2});}else r=await apply(entries,'use-incoming',false);check((await lookup(local.source))?.text===manual.text,'Incoming duplicate order changed winner');check(r.imported===1&&r.skipped===1&&r.cacheCount===1,'Duplicate counts wrong');}});
 await test('Invalid policy and truncated footer do not write or remove real rows',async()=>{const local=await row('星の勇者','별의 용사',true,50),incoming=await row(local.source,'별의 영웅',false,10);await store.import(buildExport([local]).data,'replace');for(const policy of [null,'bad',{},false,1]){await rejected(()=>store.import(buildExport([incoming]).data,'merge',{conflictPolicy:policy}));await rejected(()=>transfer.importStart('merge',{conflictPolicy:policy}));}const s=await transfer.importStart('merge',{conflictPolicy:'use-incoming'});await transfer.importStage(s.token,[incoming]);await rejected(()=>transfer.importCommit(s.token,header,{expectedCount:2}));check((await lookup(local.source))?.text===local.text,'Truncated file overwrote local');await transfer.importAbort(s.token);check(await count()===1&&await store.count()===1,'Failed import changed counter');});
 await test('Persisted policy survives new transfer instance and preserves selection',async()=>{const local=await row('星の勇者','별의 용사',true,50),incoming=await row(local.source,'별의 영웅',false,10);await store.import(buildExport([local]).data,'replace');const s=await transfer.importStart('merge',{conflictPolicy:'use-incoming'});await transfer.importStage(s.token,[incoming]);const resumed=createCacheTransfer(store);await resumed.importCommit(s.token,header,{expectedCount:1});const hit=await lookup(local.source);check(hit?.text===incoming.text&&hit.manual!==true,'Persisted policy was dropped or manual pin inherited');});
 await test('Commit transaction abort rolls back earlier writes, staged deletes and count',async()=>{const local=await row('星の勇者','별의 용사',true,50),incoming=await row(local.source,'별의 영웅',false,10);await store.import(buildExport([local]).data,'replace');const s=await transfer.importStart('merge',{conflictPolicy:'use-incoming'});await transfer.importStage(s.token,[incoming]);await txRun(db,'imports','readwrite',tx=>tx.objectStore('imports').put({token:s.token,id:'v3:'+'f'.repeat(64),entry:{id:'corrupt'}}));await rejected(()=>transfer.importCommit(s.token,header,{expectedCount:1}));check((await lookup(local.source))?.text===local.text,'Aborted transaction overwrote local');check(await count()===1&&await store.count()===1,'Abort changed count');await transfer.importAbort(s.token);});
 await test('No-option legacy policy and replace remain compatible',async()=>{const local=await row('星の勇者','별의 용사',false,50),incoming=await row(local.source,'별의 영웅',true,10);await store.import(buildExport([local]).data,'replace');await store.import(buildExport([incoming]).data,'merge');check((await lookup(local.source))?.text===incoming.text,'Legacy manual preference changed');await store.import(buildExport([local]).data,'replace',{conflictPolicy:'keep-local'});check((await lookup(local.source))?.text===local.text,'Replace became keep-local');});
 await test('Mismatch imports retain exact bytes in lookup warm and JSON/NDJSON exports; warnings count writes only',async()=>{
  const text='  수치99% <i>그대로</i>\r\n{other}  ',mismatch=await row('警告対象10%',text);
  for(const stream of [false,true]){
   await store.clear();
   let result;
   if(stream){const start=await transfer.importStart('merge',{conflictPolicy:'keep-local'});await transfer.importStage(start.token,[mismatch,mismatch]);const {exportedAt,...metadata}=header;result=await transfer.importCommit(start.token,{...metadata,version:2,exportedAtISO:exportedAt},{expectedCount:2});}
   else{const {exportedAt,...data}=buildExport([mismatch,mismatch]).data;result=await store.import({...data,version:1,exportedAtISO:exportedAt},'merge',{conflictPolicy:'keep-local'});}
   check(result.imported===1&&result.skipped===1&&result.validationWarnings===1,'Warnings counted skipped duplicate or rejected content');
   check((await lookup(mismatch.source))?.text===text,'Mismatch lookup omitted or changed content');
   check((await store.warm('한국어')).entries.find(e=>e.source===mismatch.source)?.text===text,'Warm omitted or changed content');
   check((await store.export()).data.entries[0].text===text,'JSON export changed content');
   const start=await transfer.exportStart(),page=await transfer.exportNext({token:start.token});check(page.entries[0].text===text,'NDJSON page changed content');await transfer.exportEnd(start.token);
   const skipped=await apply([mismatch],'keep-local',stream);check(skipped.imported===0&&skipped.skipped===1&&skipped.validationWarnings===0,'Skipped local warning counted');
   const written=await apply([mismatch],'use-incoming',stream);check(written.imported===1&&written.validationWarnings===1,'Incoming write warning missing');
  }
  const result=await store.importBatch([mismatch,mismatch],{conflictPolicy:'keep-local'});check(result.imported===0&&result.skipped===2&&result.validationWarnings===0,'Batch skipped duplicate warned');
 });
 await test('Clear atomically removes every language manual row tombstone staging and job, preserving non-cache metadata and distribution',async()=>{
  const recording=createDistributionStore(indexedDB,{databaseName:name+'-distribution'});owned.push(name+'-distribution');
  try{
   const owner={tabId:1,frameId:0},session=await recording.start({owner,target:'한국어'}),recorded=await row('配布記録','배포 기록');await recording.append(owner,[recorded]);await recording.finish(owner,session.id);
   const manual=await row('手動項目','수동 항목',true),english=await row('英語項目','English item',false,20,'English');await store.import(buildExport([manual,english]).data,'replace');
   const pending=await transfer.importStart('replace');await transfer.importStage(pending.token,[recorded]);const exporting=await transfer.exportStart();
   const keep={id:'settings:synthetic',value:{enabled:true}},distributionMeta={id:'distribution:synthetic',value:'preserve'};
   await txRun(db,'cache-metadata','readwrite',tx=>{const meta=tx.objectStore('cache-metadata');meta.put(keep);meta.put(distributionMeta);meta.put({id:'deleted-source:'+manual.id,deleted:true});});
   const cleared=await store.clear();check(cleared.cacheCount===0&&await store.count()===0&&await count()===0,'Clear count is not zero');
   const state=await txRun(db,['cache-metadata','imports'],'readonly',(tx,set)=>{let staged,rows;const a=tx.objectStore('imports').count(),b=tx.objectStore('cache-metadata').getAll();a.onsuccess=()=>{staged=a.result;};b.onsuccess=()=>{rows=b.result;};set(()=>({staged,rows}));});
   check(state.staged===0&&!state.rows.some(e=>e.id.startsWith('transfer:')||e.id.startsWith('deleted-source:')),'Clear left staging, transfer jobs or tombstones');
   check(JSON.stringify(state.rows.find(e=>e.id===keep.id))===JSON.stringify(keep)&&JSON.stringify(state.rows.find(e=>e.id===distributionMeta.id))===JSON.stringify(distributionMeta),'Clear removed unrelated metadata');
   check((await recording.status(owner)).count===1&&(await recording.exportPage({id:session.id})).entries[0].text===recorded.text,'Clear changed distribution state');
   const resumed=createCacheTransfer(store);await rejected(()=>resumed.importStage(pending.token,[recorded]));await rejected(()=>resumed.importCommit(pending.token,header,{expectedCount:1}));await rejected(()=>resumed.exportNext({token:exporting.token}));check(await store.count()===0,'Stale job resurrected translations');
  }finally{await recording.destroy();}
 });
 await test('In-flight export cannot recreate its deleted job after clear',async()=>{
  await store.import(buildExport([await row('進行中の出力','진행 중 출력')]).data,'replace');
  let reached,release;const waiting=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;}),original=store.exportPage;
  store.exportPage=async options=>{const page=await original(options);reached();await gate;return page;};
  try{
   const start=await transfer.exportStart(),pending=transfer.exportNext({token:start.token}),settled=pending.then(()=>false,()=>true);
   await waiting;await store.clear();release();check(await settled,'In-flight export succeeded after reset');
   const job=await txRun(db,'cache-metadata','readonly',(tx,set)=>{const r=tx.objectStore('cache-metadata').get('transfer:'+start.token);r.onsuccess=()=>set(r.result);});check(!job&&await store.count()===0,'Export recreated transfer job');
  }finally{release();store.exportPage=original;}
 });
 await test('Legacy JSON import hashing cannot write after a concurrent clear',async()=>{
  const incoming=await row('初期化と競合する取込','초기화와 경합하는 가져오기'),original=crypto.subtle.digest.bind(crypto.subtle);let reached,release;
  const waiting=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});crypto.subtle.digest=async(...args)=>{reached();await gate;return original(...args);};
  try{const pending=store.import(buildExport([incoming]).data,'replace'),settled=pending.then(()=>false,()=>true);await waiting;await store.clear();release();check(await settled,'Stale JSON import wrote after clear');check(await store.count()===0,'Stale JSON import resurrected data');}
  finally{release();crypto.subtle.digest=original;}
 });
 $('status').textContent='All native merge policy tests passed.';
 }catch(e){$('status').textContent='FAILED: '+e.message;}finally{let cleanupComplete=false;try{if(store)await store.destroy();else await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);});cleanupComplete=!(await indexedDB.databases()).some(x=>owned.includes(x.name));}catch(e){results.push({name:'cleanup',passed:false,error:String(e.message)});}const summary={results,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,cleanupComplete,allPassed:results.length===13&&results.every(x=>x.passed)&&cleanupComplete,aiRequests:0};window.__mergeResults=summary;$('results').textContent=JSON.stringify(summary,null,2);$('start').disabled=false;return summary;}}
