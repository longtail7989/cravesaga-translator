import {cacheId,makeCacheEntry,isModernEntry,portableEntry,buildExport,validateImport,validatePortableEntries,preferredEntry,validateTextPair,checkPortableShape,indexedCacheEntry,byteSize,CACHE_MAX_FILE_BYTES} from './cache.mjs';
import {hashKey,legacyCacheIdentity} from './core.mjs';
import {unchangedJapanese} from './reliability.mjs';
const META='cache-metadata',COUNTER='translation-count',DELETED='deleted-source:',MIGRATION='source-identity-v3-recent-v1',BATCH=64;
// Every translations writer must include META in its transaction and update this row.
function adjustCount(tx,delta,{reset=false,onValue=()=>{}}={}){
  const meta=tx.objectStore(META);
  const save=old=>{const count=old+delta;if(!Number.isSafeInteger(count)||count<0){tx.abort();return;}meta.put({id:COUNTER,count});onValue(count);};
  if(reset){save(0);return;}
  const r=meta.get(COUNTER);r.onsuccess=()=>{if(!Number.isSafeInteger(r.result?.count)||r.result.count<0){tx.abort();return;}save(r.result.count);};
}
const range=()=>globalThis.IDBKeyRange;
const useful=e=>{try{return isModernEntry(e)&&validateTextPair(e.source,e.text)&&(e.manual===true||!unchangedJapanese(e.source,e.text,e.target));}catch{return false;}};
function transaction(db,names,mode,fn){return new Promise((resolve,reject)=>{
  const tx=db.transaction(names,mode);let result,error;
  tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
  tx.onerror=()=>reject(error||tx.error||Error('캐시 작업 실패'));
  tx.onabort=()=>reject(error||tx.error||Error('캐시 작업 중단'));
  const set=x=>{result=x;},fail=e=>{error=e;try{tx.abort();}catch{reject(e);}};
  try{fn(tx,set,fail);}catch(e){fail(e);}
});}
export function createCacheStore(idb=globalThis.indexedDB,{databaseName='crave-ai-cache'}={}){
  if(typeof databaseName!=='string'||!databaseName)throw Error('캐시 데이터베이스 이름이 필요합니다.');
  let closed=false;
  const opened=new Promise((resolve,reject)=>{
    const r=idb.open(databaseName,4);
    r.onupgradeneeded=()=>{
      const db=r.result,s=db.objectStoreNames.contains('translations')?r.transaction.objectStore('translations'):db.createObjectStore('translations',{keyPath:'id'});
      if(!s.indexNames.contains('time'))s.createIndex('time','time');
      if(!s.indexNames.contains('targetTime'))s.createIndex('targetTime',['target','time']);
      if(!s.indexNames.contains('targetRecent'))s.createIndex('targetRecent',['target','reverseTime','id']);
      if(!db.objectStoreNames.contains(META))db.createObjectStore(META,{keyPath:'id'});
      const imports=db.objectStoreNames.contains('imports')?r.transaction.objectStore('imports'):db.createObjectStore('imports',{keyPath:['token','id']});
      if(!imports.indexNames.contains('token'))imports.createIndex('token','token');
    };
    r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};
    r.onerror=()=>reject(r.error||Error('번역 캐시를 열 수 없습니다.'));
    r.onblocked=()=>reject(Error('다른 캐시 연결을 닫고 다시 시도하세요.'));
  });
  const get=(db,id)=>transaction(db,'translations','readonly',(tx,set)=>{const r=tx.objectStore('translations').get(id);r.onsuccess=()=>set(r.result);});
  // Hash outside transactions; atomically merge and checkpoint bounded cursor batches.
  async function migrate(db){
    let state=await transaction(db,META,'readonly',(tx,set)=>{const r=tx.objectStore(META).get(MIGRATION);r.onsuccess=()=>set(r.result);});
    if(state?.done)return false;
    let cursor=state?.cursor??null;
    for(;;){
      const batch=await transaction(db,'translations','readonly',(tx,set)=>{
        const rows=[];let bytes=0,last=cursor,done=false;
        const r=tx.objectStore('translations').openCursor(cursor===null?undefined:range().lowerBound(cursor,true));
        r.onsuccess=()=>{const c=r.result;if(!c){done=true;return;}last=c.primaryKey;rows.push(c.value);bytes+=byteSize(c.value);if(rows.length<BATCH&&bytes<1048576)c.continue();};
        set(()=>({rows,cursor:last,done}));
      });
      const converted=[];
      for(const raw of batch.rows){
        if(!isModernEntry(raw))continue;
        try{const entries=await validatePortableEntries([portableEntry(raw)]);converted.push({entry:entries[0],oldId:raw.id});}catch{/* Preserve unverifiable rows. */}
      }
      await transaction(db,['translations',META],'readwrite',(tx)=>{
        const store=tx.objectStore('translations');
        let i=0;const next=()=>{if(i>=converted.length)return;const {entry,oldId}=converted[i++],r=store.get(entry.id);r.onsuccess=()=>{const w=store.put(indexedCacheEntry(preferredEntry(r.result,entry)));if(oldId!==entry.id)store.delete(oldId);w.onsuccess=next;};};next();
        tx.objectStore(META).put({id:MIGRATION,cursor:batch.cursor,done:batch.done});
      });
      cursor=batch.cursor;if(batch.done)return true;
    }
  }
  async function ensureCount(db,reset=false){
    return transaction(db,['translations',META],'readwrite',(tx)=>{
      const meta=tx.objectStore(META),r=meta.get(COUNTER);r.onsuccess=()=>{
        if(!reset&&Number.isSafeInteger(r.result?.count)&&r.result.count>=0)return;
        const n=tx.objectStore('translations').count();n.onsuccess=()=>meta.put({id:COUNTER,count:n.result});
      };
    });
  }
  const ready=opened.then(async db=>{const migrated=await migrate(db);await ensureCount(db,migrated);return db;});
  const database=async()=>{if(closed)throw Error('캐시 연결이 닫혔습니다.');return ready;};
  async function apply(entries,{clear=false,keepExisting=false}={}){
    const db=await database();
    return transaction(db,['translations',META],'readwrite',(tx,set)=>{
      const store=tx.objectStore('translations');let imported=0,skipped=0,added=0;
      if(clear)store.clear();
      let i=0;const next=()=>{if(i>=entries.length){adjustCount(tx,added,{reset:clear});return;}const entry=entries[i++],r=store.get(entry.id);
        r.onsuccess=()=>{const old=r.result;
          if(keepExisting&&useful(old)&&!(entry.manual===true&&old.manual!==true&&useful(entry))){skipped++;next();return;}
          const chosen=preferredEntry(old,entry);if(chosen===old){skipped++;next();return;}
          const w=store.put(indexedCacheEntry(chosen));w.onsuccess=()=>{imported++;if(!old)added++;next();};
        };
      };next();set(()=>({imported,skipped}));
    });
  }
  async function count(){const db=await database();return transaction(db,META,'readonly',(tx,set,fail)=>{const r=tx.objectStore(META).get(COUNTER);r.onsuccess=()=>{if(!Number.isSafeInteger(r.result?.count)||r.result.count<0){fail(Error('캐시 개수 메타데이터가 올바르지 않습니다.'));return;}set(r.result.count);};});}
  async function lookup(item,settings){
    const id=await cacheId(settings.target,item.source),db=await database();let record=await get(db,id);
    if(useful(record)&&record.source===item.source&&record.target===settings.target)return record;
    // Canonical hits above remain valid after a legitimate fresh put/manual/import.
    const deleted=await transaction(db,META,'readonly',(tx,set)=>{const r=tx.objectStore(META).get(DELETED+id);r.onsuccess=()=>set(!!r.result);});
    if(deleted)return null;
    const context=item.context||'',oldId=await hashKey(legacyCacheIdentity(settings,item.source,context)),old=await get(db,oldId);
    if(!old||unchangedJapanese(item.source,old.text,settings.target))return null;
    try{
      const time=Number.isSafeInteger(old.time)&&old.time>=0?old.time:Date.now();
      const entry=await makeCacheEntry({source:item.source,context,target:settings.target,text:old.text,createdAt:time,updatedAt:time});
      record=await transaction(db,['translations',META],'readwrite',(tx,set)=>{
        const store=tx.objectStore('translations'),r=store.get(id);
        r.onsuccess=()=>{const current=r.result,marker=tx.objectStore(META).get(DELETED+id);
          // Deletion may commit after the initial lookup but before this promotion.
          marker.onsuccess=()=>{if(marker.result){set(current);return;}const check=store.get(oldId);
            check.onsuccess=()=>{if(!check.result){set(current);return;}const chosen=indexedCacheEntry(preferredEntry(current,entry));store.put(chosen);store.delete(oldId);if(current)adjustCount(tx,-1);set(chosen);};
          };
        };
      });
      return useful(record)&&record.source===item.source&&record.target===settings.target?record:null;
    }catch{return null;}
  }
  async function exportPage({cursor=null,limit=250,maxBytes=1048576}={}){
    if(cursor!==null&&(typeof cursor!=='string'||!/^v3:[a-f0-9]{64}$/.test(cursor)))throw Error('캐시 내보내기 커서가 올바르지 않습니다.');
    if(!Number.isSafeInteger(limit)||limit<1||limit>10000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024)throw Error('내보내기 페이지 크기가 올바르지 않습니다.');
    const db=await database();return transaction(db,'translations','readonly',(tx,set,fail)=>{
      const entries=[];let bytes=0,last=cursor,done=false;
      const r=tx.objectStore('translations').openCursor(range().bound(cursor||'v3:','v3:\uffff',cursor!==null,false));
      r.onsuccess=()=>{try{const c=r.result;if(!c){done=true;return;}const e=c.value;
        if(!isModernEntry(e)){last=c.primaryKey;c.continue();return;}
        const row=portableEntry(e),size=byteSize(row)+1;
        if(entries.length>=limit||bytes+size>maxBytes){if(!entries.length)throw Error('캐시 한 항목이 maxBytes보다 큽니다. 페이지 바이트 한도를 늘리세요.');return;}
        entries.push(row);bytes+=size;last=c.primaryKey;c.continue();
      }catch(e){fail(e);}};
      set(()=>({entries,cursor:done?null:last,done}));
    });
  }
  return {
    lookup,count,exportPage,
    // Trusted extension backend only; never forward this handle to message clients.
    _database:database,
    async put(items,settings){for(let i=0;i<items.length;i+=32){const entries=await Promise.all(items.slice(i,i+32).map(x=>makeCacheEntry({source:x.source,context:x.context||'',target:settings.target,text:x.text})));await apply(entries);}},
    async clear(){const db=await database();return transaction(db,['translations',META],'readwrite',tx=>{tx.objectStore('translations').clear();adjustCount(tx,0,{reset:true});});},
    async export(){
      const entries=[];let cursor=null,bytes=512;
      do{const p=await exportPage({cursor});for(const e of p.entries){bytes+=byteSize(e)+1;if(bytes>CACHE_MAX_FILE_BYTES)throw Error('32MiB를 초과하는 캐시는 exportPage() 페이지 내보내기를 사용하세요.');entries.push(e);}cursor=p.cursor;if(p.done)break;}while(cursor);
      const result=buildExport(entries);result.legacySkipped=Math.max(0,(await count())-entries.length);return result;
    },
    async importBatch(entries,{keepExisting=true}={}){
      if(!Array.isArray(entries)||entries.length>1000)throw Error('한 번에 최대 1,000개씩 importBatch()를 호출하세요.');
      let bytes=0;for(const e of entries){checkPortableShape(e);bytes+=byteSize(e)+1;if(bytes>8*1024*1024)throw Error('불러오기 배치는 8MiB 이하여야 합니다.');}
      const valid=await validatePortableEntries(entries);const result=await apply(valid,{keepExisting});return {...result,skipped:result.skipped+entries.length-valid.length};
    },
    async import(data,mode='merge'){
      if(!['merge','replace'].includes(mode))throw Error('지원하지 않는 캐시 불러오기 방식입니다.');
      const entries=await validateImport(data);const result=await apply(entries,{clear:mode==='replace',keepExisting:mode==='merge'});
      return {...result,skipped:result.skipped+data.entries.length-entries.length,cacheCount:await count()};
    },
    async warm(target){
      const db=await database();return transaction(db,'translations','readonly',(tx,set,fail)=>{
        // Chrome 116-compatible ascending getAll(count), not modern direction options.
        // Reverse saved time plus id provides stable pagination even for tied timestamps.
        const index=tx.objectStore('translations').index('targetRecent'),upper=[target,Number.MAX_SAFE_INTEGER,'\uffff'];
        const entries=[];let bytes=0,visited=0,scannedBytes=0,hasMore=false;
        const next=(after=null)=>{
          const wanted=Math.min(32,2000-visited);
          if(wanted<1||scannedBytes>=2*1024*1024){hasMore=true;return;}
          const bounds=range().bound(after||[target,0,''],upper,after!==null,false),r=index.getAll(bounds,wanted);
          r.onsuccess=()=>{try{
            const rows=r.result;if(!rows.length)return;
            for(const e of rows){
              if(visited>=2000||scannedBytes>=2*1024*1024){hasMore=true;return;}
              visited++;scannedBytes+=byteSize(e);
              if(!useful(e)||!e.id.startsWith('v3:'))continue;
              const item={source:e.source,context:e.context,target:e.target,text:e.text},size=byteSize(item);
              if(bytes+size>2*1024*1024){hasMore=true;return;}
              entries.push(item);bytes+=size;
            }
            if(rows.length<wanted)return;
            const last=rows[rows.length-1];next([last.target,last.reverseTime,last.id]);
          }catch(e){fail(e);}};
        };next();set(()=>({entries,remaining:null,hasMore,bytes}));
      });
    },
    async deleteOldest(amount){
      if(!Number.isSafeInteger(amount)||amount<1)throw Error('삭제 개수는 1 이상의 안전한 정수여야 합니다.');
      const db=await database();return transaction(db,['translations',META],'readwrite',(tx,set)=>{
        const store=tx.objectStore('translations');let deleted=0,cacheCount=0;
        const finish=()=>adjustCount(tx,-deleted,{onValue:n=>{cacheCount=n;}});
        const index=store.index('time');
        const next=()=>{
          const wanted=Math.min(1000,amount-deleted);if(wanted<1){finish();return;}
          const r=index.getAllKeys(undefined,wanted);r.onsuccess=()=>{
            const keys=r.result;for(const key of keys)store.delete(key);deleted+=keys.length;
            // Deletes are queued before the next key batch in this same transaction.
            if(keys.length<wanted||deleted>=amount)finish();else next();
          };
        };next();
        set(()=>({deleted,cacheCount}));
      });
    },
    async close(){closed=true;const db=await ready;db.close();},
    async destroy(){closed=true;const db=await ready;db.close();return new Promise((resolve,reject)=>{const r=idb.deleteDatabase(databaseName);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error||Error('캐시 데이터베이스 삭제 실패'));r.onblocked=()=>reject(Error('캐시 연결이 열려 있어 삭제할 수 없습니다.'));});}
  };
}
