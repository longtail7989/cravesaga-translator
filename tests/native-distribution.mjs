// Real native IndexedDB and OPFS. No UI module, picker, provider or primary cache.
import {createDistributionStore} from '../distribution-store.mjs';
import {createCacheStore} from '../cache-store.mjs';
import {createCacheEditor} from '../cache-editor.mjs';
import {createDistributionFileStore,DISTRIBUTION_FILES_DATABASE} from '../distribution-files.mjs';
import {makeCacheEntry,portableEntry,validatePortableEntries,validateImport,cacheId,byteSize,CACHE_FORMAT,CACHE_FILE_VERSION} from '../cache.mjs';
const $=id=>document.getElementById(id),assert=(value,message)=>{if(!value)throw Error(message);};
let active=false;
async function rejects(fn,code){let caught;try{await fn();}catch(e){caught=e;}assert(caught&&(!code||caught.code===code),'Expected rejection: '+(code||'any'));}
const deleteDatabase=name=>new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('Test database deletion blocked'));});
const countRows=(db,name)=>new Promise((resolve,reject)=>{const tx=db.transaction(name,'readonly'),r=tx.objectStore(name).count();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error||Error('Count failed'));});
$('buttonRun').addEventListener('click',()=>{if(active)return;active=true;$('buttonRun').disabled=true;window.__distributionPromise=run();});
async function run(){
  const suffix=crypto.randomUUID(),names={recording:'crave-ai-distribution-native-'+suffix,personal:'crave-ai-distribution-personal-test-'+suffix,roundtrip:'crave-ai-distribution-import-test-'+suffix,files:'crave-ai-distribution-handles-test-'+suffix};
  const opfsName='crave-ai-distribution-test-'+suffix+'.ndjson',results=[],groups=[];
  const owner={tabId:901,frameId:13},target='한국어';
  let store,personal,roundtrip,files,rootDirectory,originalHandle,selectionId,session,ready,exportedRows=[],opfsCreated=false;
  let cleanupComplete=false,databasesRemoved=false,opfsRemoved=false,fileReferencesRemoved=false;
  const state=()=>({active:true,databaseNames:names,opfsName,results,groups,cleanupComplete:false,nativePickerInvoked:false,aiRequests:0});
  const report=()=>{$('results').textContent=JSON.stringify(state(),null,2);};
  async function test(name,fn){const started=performance.now();try{await fn();results.push({name,passed:true,ms:performance.now()-started});}catch(e){results.push({name,passed:false,error:String(e.message),ms:performance.now()-started});throw e;}finally{report();}}
  async function group(name,fn){const started=performance.now(),first=results.length;try{await fn();groups.push({name,status:'passed',passed:results.slice(first).filter(x=>x.passed).length,ms:performance.now()-started});return true;}catch(e){groups.push({name,status:e.code==='BLOCKED'?'blocked':'failed',reason:String(e.message),passed:results.slice(first).filter(x=>x.passed).length,ms:performance.now()-started});return false;}finally{report();}}
  const row=async(source,text,extra={})=>portableEntry(await makeCacheEntry({source,text,target,context:'native synthetic fixture',createdAt:10,updatedAt:20,...extra}));
  const blocked=message=>{throw Object.assign(Error(message),{code:'BLOCKED'});};
  try{
    $('status').textContent='Running native recording and file-handle tests. No picker or AI.';
    const recordingPassed=await group('native-recording',async()=>{
      store=createDistributionStore(indexedDB,{databaseName:names.recording});
      personal=createCacheStore(indexedDB,{databaseName:names.personal});
      roundtrip=createCacheStore(indexedDB,{databaseName:names.roundtrip});
      const editor=createCacheEditor(personal);
      await test('Unique native databases; one global active session and strict owner',async()=>{
        assert((await store.status()).status==='idle','New recording not idle');
        await rejects(()=>store.start({owner:{tabId:'901',frameId:13},target}),'INVALID_OWNER');
        session=await store.start({owner,target,fileName:opfsName});
        const second=createDistributionStore(indexedDB,{databaseName:names.recording});
        try{await rejects(()=>second.start({owner,target}),'ACTIVE_SESSION');await rejects(()=>second.status({tabId:901,frameId:14}),'OWNER_MISMATCH');assert((await second.status(owner)).id===session.id,'Cross-connection metadata mismatch');}finally{await second.close();}
        assert(await personal.count()===0,'Synthetic personal cache not empty');
      });
      await test('Latest canonical duplicate wins over old manual priority and preserves incoming times',async()=>{
        const source='星の勇者',manual=await row(source,'수동 용사',{manual:true,createdAt:100,updatedAt:200});
        const latest={...await row(source,'최신 자동 캡처',{createdAt:1,updatedAt:2}),manual:false};
        await personal.importBatch([manual],{keepExisting:false});
        await store.append(owner,[manual]);await store.append(owner,[manual,latest]);
        await store.append(owner,[await row(source+' ','공백 있는 용사')]);
        const saved=await editor.save({source:'手動の修正',target,text:'수동으로 수정',create:true});
        await store.append(owner,[saved.entry]);
        assert((await store.status()).count===3,'Canonical/whitespace count wrong');
        assert((await personal.lookup({source},{target})).manual===true,'Recorder changed independent personal cache');
        assert((await editor.get({id:saved.entry.id})).entry.text===saved.entry.text,'Manual editor data changed');
      });
      await test('Schema/hash and wrong-target batches fail without partial writes',async()=>{
        const good=await row('月の神殿','달의 신전'),before=(await store.status()).count;
        await rejects(()=>store.append(owner,[good,{...good,id:'v3:'+'0'.repeat(64)}]),'INVALID_ENTRY');
        await rejects(()=>store.append(owner,[good,{...good,endpoint:'SYNTHETIC_FORBIDDEN_FIELD'}]),'INVALID_ENTRY');
        const english=await row('別の言語','Different language',{target:'English'});
        await rejects(()=>store.append(owner,[good,english]),'TARGET_MISMATCH');
        await rejects(()=>store.append(owner,Array(251).fill(good)),'BATCH_LIMIT');
        assert((await store.status()).count===before,'Rejected batch partially committed');
      });
      await test('Native restart preserves recording; more than one bounded page persists',async()=>{
        await store.close();store=createDistributionStore(indexedDB,{databaseName:names.recording});
        assert((await store.status(owner)).id===session.id,'Recording did not resume');
        const rows=[];for(let i=0;i<251;i++)rows.push(await row('記録'+String.fromCodePoint(0x4e00+i),'기록'+String.fromCodePoint(0xac00+i)));
        await store.append(owner,rows.slice(0,250));await store.append(owner,rows.slice(250));
        assert((await store.status()).count===254,'Large recording count mismatch');
        assert(await personal.count()===2,'Recording modified personal database');
      });
      await test('Finish freezes atomically, idempotently and survives another connection',async()=>{
        ready=await store.finish(owner,session.id);assert(ready.status==='ready','Finish did not freeze');
        assert((await store.finish(owner,session.id)).finishedAt===ready.finishedAt,'Finish is not idempotent');
        await rejects(async()=>store.append(owner,[await row('追加の記録','추가 기록')]),'FROZEN');
        await store.close();store=createDistributionStore(indexedDB,{databaseName:names.recording});
        assert((await store.status()).status==='ready','Ready snapshot lost after reopen');
      });
      await test('Bounded export pages validate source-v3 hashes and exact latest/manual timestamps',async()=>{
        await rejects(()=>store.exportPage({id:session.id,maxBytes:1}),'ROW_TOO_LARGE');
        await rejects(()=>store.exportPage({id:session.id,limit:251}),'PAGE_LIMIT');
        let cursor=null,pages=0,lastId=null;
        do{const page=await store.exportPage({id:session.id,cursor,limit:41,maxBytes:18000});
          assert(page.entries.length<=41&&page.bytes<=18000,'Page exceeded bounds');
          assert(page.bytes===page.entries.reduce((n,e)=>n+byteSize(e)+1,0),'Page byte accounting wrong');
          await validatePortableEntries(page.entries);
          for(const entry of page.entries){assert(lastId===null||entry.id>lastId,'Duplicate/unordered export');lastId=entry.id;assert(Object.keys(entry).every(k=>['id','source','context','target','text','createdAt','updatedAt','manual'].includes(k)),'Internal field exported');}
          exportedRows.push(...page.entries);pages++;cursor=page.cursor;if(page.done)break;assert(cursor,'Missing export cursor');
        }while(cursor);
        assert(exportedRows.length===ready.count&&pages>1,'Export count/paging mismatch');
        const latest=exportedRows.find(x=>x.source==='星の勇者');
        assert(latest.text==='최신 자동 캡처'&&latest.manual===false&&latest.createdAt===1&&latest.updatedAt===2,'Latest capture metadata lost');
        assert(exportedRows.some(x=>x.source==='星の勇者 '),'Exact whitespace source lost');
        assert(exportedRows.find(x=>x.source==='手動の修正')?.manual===true,'Editor manual row lost');
        for(const entry of exportedRows)assert(await cacheId(entry.target,entry.source)===entry.id,'Canonical hash mismatch');
      });
    });
    await group('native-opfs-and-file-handles',async()=>{
      if(!recordingPassed)blocked('Recording prerequisites failed; no file-save claim made.');
      if(typeof navigator.storage?.getDirectory!=='function')blocked('OPFS navigator.storage.getDirectory is unavailable on this origin.');
      try{rootDirectory=await navigator.storage.getDirectory();}catch(e){blocked('OPFS directory unavailable: '+e.name);}
      await test('Real OPFS handle survives native IndexedDB structured clone and reopen',async()=>{
        originalHandle=await rootDirectory.getFileHandle(opfsName,{create:true});opfsCreated=true;
        // The file store has a fixed production database name. Map only that
        // exact name to a unique native database; never open the production DB.
        const testFactory={open(name,version){assert(name===DISTRIBUTION_FILES_DATABASE,'Unexpected file-store database');return indexedDB.open(names.files,version);}};
        files=createDistributionFileStore(testFactory);selectionId=await files.put(originalHandle);await files.close();
        files=createDistributionFileStore(testFactory);const recovered=await files.get(selectionId);
        assert(recovered?.kind==='file'&&recovered.name===opfsName&&typeof recovered.createWritable==='function','File handle did not persist natively');
        assert(await recovered.isSameEntry(originalHandle),'Retrieved handle refers to another file');
        const clone=structuredClone(recovered);assert(await clone.isSameEntry(originalHandle),'Native structuredClone lost file handle');
      });
      await test('Real createWritable writes compatible NDJSON, closes, then reads back and roundtrips',async()=>{
        const recovered=await files.get(selectionId),header={format:CACHE_FORMAT,version:CACHE_FILE_VERSION,identity:'source-v3',exportedAt:new Date().toISOString(),appVersion:'0.3.4'};
        let writer=await recovered.createWritable({keepExistingData:false});
        try{
          await writer.write(JSON.stringify(header)+'\n');let cursor=null,count=0;
          do{const page=await store.exportPage({id:session.id,cursor,limit:37,maxBytes:16000});for(const entry of page.entries){await writer.write(JSON.stringify(entry)+'\n');count++;}cursor=page.cursor;if(page.done)break;}while(cursor);
          assert(count===ready.count,'Written row count differs from frozen snapshot');await writer.write(JSON.stringify({end:true,count})+'\n');await writer.close();writer=undefined;
        }finally{if(writer)await writer.abort();}
        const file=await recovered.getFile(),text=await file.text(),lines=text.trimEnd().split('\n'),parsedHeader=JSON.parse(lines.shift()),footer=JSON.parse(lines.pop()),rows=lines.map(line=>JSON.parse(line));
        assert(parsedHeader.format===CACHE_FORMAT&&parsedHeader.version===3&&parsedHeader.identity==='source-v3','Header incompatible');
        assert(footer.end===true&&footer.count===ready.count&&rows.length===ready.count,'Footer/file count mismatch');
        assert(JSON.stringify(rows)===JSON.stringify(exportedRows),'File changed portable rows/order/metadata');
        const canonical=await validateImport({format:parsedHeader.format,version:parsedHeader.version,exportedAt:parsedHeader.exportedAt,appVersion:parsedHeader.appVersion,entries:rows});
        assert(canonical.length===ready.count,'File schema/hash validation failed');
        for(let i=0;i<rows.length;i+=250)await roundtrip.importBatch(rows.slice(i,i+250),{keepExisting:false});
        assert(await roundtrip.count()===ready.count,'Native personal-cache roundtrip count mismatch');
        const imported=await roundtrip.lookup({source:'星の勇者'},{target});assert(imported.text==='최신 자동 캡처'&&imported.updatedAt===2,'Native roundtrip row mismatch');
      });
      await test('Only after actual close/readback: saved commits and cleans recording plus handle reference',async()=>{
        assert((await store.status()).status==='ready','Store marked saved before successful file close');
        const saved=await store.saved(owner,session.id);assert(saved.status==='saved'&&saved.cleanupComplete===true,'Saved cleanup incomplete');
        assert(await countRows(await store._database(),'entries')===0,'Saved left recording entries');
        await files.delete(selectionId);assert((await files.get(selectionId))===undefined,'File reference cleanup failed');fileReferencesRemoved=true;
        assert(await personal.count()===2,'Saving changed independent personal cache');
      });
    });
  }catch(e){results.push({name:'fixture setup',passed:false,error:String(e.message)});}
  finally{
    const cleanupErrors=[];
    for(const [name,object] of [['files',files],['recording',store],['personal',personal],['roundtrip',roundtrip]])if(object)try{await object.close();}catch(e){cleanupErrors.push(name+': '+e.message);}
    for(const name of Object.values(names))try{await deleteDatabase(name);}catch(e){cleanupErrors.push(name+': '+e.message);}
    try{if(rootDirectory&&opfsCreated)await rootDirectory.removeEntry(opfsName);opfsRemoved=!opfsCreated;if(rootDirectory&&opfsCreated){try{await rootDirectory.getFileHandle(opfsName);throw Error('Temporary OPFS file still exists');}catch(e){if(e.name!=='NotFoundError')throw e;opfsRemoved=true;}}}catch(e){cleanupErrors.push('OPFS: '+e.message);}
    try{if(typeof indexedDB.databases!=='function')throw Error('Cannot verify native database removal');const remaining=await indexedDB.databases();databasesRemoved=!remaining.some(x=>Object.values(names).includes(x.name));if(!databasesRemoved)throw Error('Temporary test database remains');}catch(e){cleanupErrors.push('Verification: '+e.message);}
    cleanupComplete=cleanupErrors.length===0&&databasesRemoved&&opfsRemoved;
    groups.push({name:'cleanup',status:cleanupComplete?'passed':'failed',databasesRemoved,opfsRemoved,fileReferencesRemoved,...(cleanupErrors.length?{errors:cleanupErrors}:{})});
    active=false;$('buttonRun').disabled=false;
    const summary={active:false,databaseNames:names,opfsName,results,groups,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,blocked:groups.filter(x=>x.status==='blocked').length,cleanupComplete,databasesRemoved,opfsRemoved,fileReferencesRemoved,allPassed:results.length===9&&results.every(x=>x.passed)&&groups.every(x=>x.status==='passed')&&cleanupComplete,nativePickerInvoked:false,aiRequests:0};
    window.__distributionResults=summary;$('results').textContent=JSON.stringify(summary,null,2);$('status').textContent=summary.allPassed?'All 9 native distribution tests passed; temporary databases and OPFS file removed.':summary.blocked?'BLOCKED: native OPFS/file-handle verification unavailable. See results.':'FAILED: see native distribution results.';
    return summary;
  }
}
