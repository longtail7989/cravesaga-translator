// Disk-backed recording only. Never opens, migrates or writes the personal cache.
import {checkPortableShape,validatePortableEntries,portableEntry,byteSize} from './cache.mjs';
export const DISTRIBUTION_MAX_ROWS=250;
export const DISTRIBUTION_MAX_BYTES=1024*1024;
const SESSIONS='sessions',META='meta',ENTRIES='entries',ACTIVE='active';
const range=()=>globalThis.IDBKeyRange;
export class DistributionStoreError extends Error {
  constructor(code,message,{cause,retryable=false}={}){super(message,{cause});this.name='DistributionStoreError';this.code=code;this.retryable=retryable;}
}
const error=(code,message,retryable=false)=>new DistributionStoreError(code,message,{retryable});
function typed(e){return e instanceof DistributionStoreError?e:new DistributionStoreError(e?.name==='QuotaExceededError'?'QUOTA':'STORAGE','Distribution storage operation failed; personal cache is unaffected.',{cause:e,retryable:true});}
function ownerValue(owner){
  if(!owner||!Number.isSafeInteger(owner.tabId)||owner.tabId<0||!Number.isSafeInteger(owner.frameId)||owner.frameId<0)throw error('INVALID_OWNER','Owner requires nonnegative integer tabId and frameId.');
  return {tabId:owner.tabId,frameId:owner.frameId};
}
function owns(session,owner){if(session.owner.tabId!==owner.tabId||session.owner.frameId!==owner.frameId)throw error('OWNER_MISMATCH','Recording belongs to another tab or frame.');}
function sessionId(id){if(typeof id!=='string'||!/^dist:[a-f0-9-]{36}$/.test(id))throw error('INVALID_ID','Invalid recording session id.');return id;}
function safe(session){
  if(!session)return {status:'idle',count:0,bytes:0};
  const {id,status,owner,target,fileName,count,bytes,createdAt,updatedAt,finishedAt,savedAt,discardedAt,cleanupComplete}=session;
  return {id,status,owner:{...owner},target,...(fileName===undefined?{}:{fileName}),count,bytes,createdAt,updatedAt,...(finishedAt===undefined?{}:{finishedAt}),...(savedAt===undefined?{}:{savedAt}),...(discardedAt===undefined?{}:{discardedAt}),...(cleanupComplete===undefined?{}:{cleanupComplete})};
}
function transact(db,names,mode,work){return new Promise((resolve,reject)=>{
  let tx,result,failure;
  try{tx=db.transaction(names,mode);}catch(e){reject(typed(e));return;}
  const fail=e=>{failure=typed(e);try{tx.abort();}catch{reject(failure);}};
  tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
  tx.onerror=event=>{failure??=typed(event?.target?.error||tx.error);};
  tx.onabort=()=>reject(failure||typed(tx.error));
  try{work(tx,value=>{result=value;},fail);}catch(e){fail(e);}
});}
function loaded(store,id,fail,fn){const request=store.get(id);request.onsuccess=()=>{try{if(!request.result)throw error('NOT_FOUND','Recording session was not found.');fn(request.result);}catch(e){fail(e);}};}
/** Limits apply to each operation/page, not the total disk-backed recording. */
export function createDistributionStore(idb=globalThis.indexedDB,{databaseName='crave-ai-distribution'}={}){
  if(typeof databaseName!=='string'||!databaseName||databaseName==='crave-ai-cache')throw error('INVALID_DATABASE','A separate distribution database is required.');
  let closed=false;
  const opened=new Promise((resolve,reject)=>{
    if(!idb?.open){reject(error('UNAVAILABLE','IndexedDB is unavailable.',true));return;}
    let request;try{request=idb.open(databaseName,1);}catch(e){reject(typed(e));return;}
    let blocked=false;
    request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore(SESSIONS,{keyPath:'id'});db.createObjectStore(META,{keyPath:'id'});const rows=db.createObjectStore(ENTRIES,{keyPath:['sessionId','id']});rows.createIndex('session','sessionId');};
    request.onsuccess=()=>{const db=request.result;if(blocked){db.close();return;}db.onversionchange=()=>{closed=true;db.close();};resolve(db);};
    request.onerror=()=>reject(typed(request.error));
    request.onblocked=()=>{blocked=true;reject(error('BLOCKED','Close other distribution database connections and retry.',true));};
  });
  opened.catch(()=>{});
  async function database(){if(closed)throw error('CLOSED','Distribution store is closed.');return opened;}
  async function status(owner){
    const expected=owner===undefined?undefined:ownerValue(owner),db=await database();
    return transact(db,[SESSIONS,META],'readonly',(tx,set,fail)=>{const r=tx.objectStore(META).get(ACTIVE);r.onsuccess=()=>{if(!r.result){set(safe(null));return;}loaded(tx.objectStore(SESSIONS),r.result.sessionId,fail,s=>{if(expected)owns(s,expected);set(safe(s));});};});
  }
  async function start({owner,target,fileName}={}){
    const expected=ownerValue(owner);
    if(typeof target!=='string'||!target.trim()||target!==target.trim()||target.length>64)throw error('INVALID_TARGET','Invalid recording target.');
    if(fileName!==undefined&&(typeof fileName!=='string'||!fileName||fileName.length>255||/[\\/\x00-\x1f\x7f]/.test(fileName)))throw error('INVALID_FILE_NAME','Use a filename, not a path.');
    const db=await database(),id='dist:'+globalThis.crypto.randomUUID(),now=Date.now();
    return transact(db,[SESSIONS,META],'readwrite',(tx,set,fail)=>{
      const sessions=tx.objectStore(SESSIONS),meta=tx.objectStore(META);
      const create=()=>{const s={id,status:'recording',owner:expected,target,...(fileName===undefined?{}:{fileName}),count:0,bytes:0,createdAt:now,updatedAt:now};sessions.put(s);meta.put({id:ACTIVE,sessionId:id});set(safe(s));};
      const r=meta.get(ACTIVE);r.onsuccess=()=>{if(!r.result){create();return;}loaded(sessions,r.result.sessionId,fail,s=>{if(['recording','ready'].includes(s.status))throw error('ACTIVE_SESSION','Finish/save or explicitly discard the existing recording.');create();});};
    });
  }
  async function append(owner,raws){
    const expected=ownerValue(owner);
    if(!Array.isArray(raws)||raws.length>DISTRIBUTION_MAX_ROWS)throw error('BATCH_LIMIT','Append accepts at most 250 rows.');
    let inputBytes=0;const copies=[];
    // Validate and bound before async hashing. Never serialize unknown fields.
    try{for(const raw of raws){checkPortableShape(raw);const row={...portableEntry(raw),...(Object.hasOwn(raw,'manual')?{manual:raw.manual}:{})};inputBytes+=byteSize(row)+1;if(inputBytes>DISTRIBUTION_MAX_BYTES)throw error('BATCH_LIMIT','Append accepts at most 1MiB of NDJSON rows.');copies.push(row);}}
    catch(e){throw e instanceof DistributionStoreError?e:new DistributionStoreError('INVALID_ENTRY','Invalid portable cache entry.',{cause:e});}
    const latest=new Map();
    try{for(const raw of copies){const [entry]=await validatePortableEntries([raw]);const row={...portableEntry(entry),...(Object.hasOwn(raw,'manual')?{manual:raw.manual}:{})};latest.set(row.id,row);}}
    catch(e){throw new DistributionStoreError('INVALID_ENTRY','Invalid cache schema, protected text, timestamp or source hash.',{cause:e});}
    const db=await database();
    return transact(db,[SESSIONS,META,ENTRIES],'readwrite',(tx,set,fail)=>{
      const sessions=tx.objectStore(SESSIONS),r=tx.objectStore(META).get(ACTIVE);
      r.onsuccess=()=>{if(!r.result){fail(error('NO_SESSION','No recording is active.'));return;}loaded(sessions,r.result.sessionId,fail,s=>{
        owns(s,expected);if(s.status!=='recording')throw error('FROZEN','Recording is frozen; no more entries can be appended.');
        const rows=[...latest.values()];if(rows.some(row=>row.target!==s.target))throw error('TARGET_MISMATCH','Entry target does not match this recording.');
        const store=tx.objectStore(ENTRIES);let i=0,added=0;
        const next=()=>{try{
          if(i===rows.length){s.updatedAt=Date.now();sessions.put(s);set({...safe(s),accepted:raws.length,upserted:rows.length,added});return;}
          const entry=rows[i++],key=[s.id,entry.id],q=store.get(key);
          q.onsuccess=()=>{try{const old=q.result;if(old&&(old.entry.source!==entry.source||old.entry.target!==entry.target))throw error('HASH_COLLISION','Exact source identity collision.');
            const bytes=byteSize(entry)+1;s.bytes+=bytes-(old?.bytes||0);if(!old){s.count++;added++;}store.put({sessionId:s.id,id:entry.id,entry,bytes});next();
          }catch(e){fail(e);}};
        }catch(e){fail(e);}};next();
      });};
    });
  }
  async function finish(owner,id){
    const expected=ownerValue(owner);sessionId(id);const db=await database();
    return transact(db,SESSIONS,'readwrite',(tx,set,fail)=>{const store=tx.objectStore(SESSIONS);loaded(store,id,fail,s=>{owns(s,expected);if(s.status==='ready'){set(safe(s));return;}if(s.status!=='recording')throw error('INVALID_STATE','Only a recording can be finished.');s.status='ready';s.finishedAt=s.updatedAt=Date.now();store.put(s);set(safe(s));});});
  }
  async function exportPage({id,cursor=null,limit=DISTRIBUTION_MAX_ROWS,maxBytes=DISTRIBUTION_MAX_BYTES}={}){
    sessionId(id);
    if(cursor!==null&&(typeof cursor!=='string'||!/^v3:[a-f0-9]{64}$/.test(cursor)))throw error('INVALID_CURSOR','Invalid distribution page cursor.');
    if(!Number.isSafeInteger(limit)||limit<1||limit>DISTRIBUTION_MAX_ROWS||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>DISTRIBUTION_MAX_BYTES)throw error('PAGE_LIMIT','Export pages require 1..250 rows and 1..1MiB bytes.');
    const db=await database();return transact(db,[SESSIONS,ENTRIES],'readonly',(tx,set,fail)=>{
      loaded(tx.objectStore(SESSIONS),id,fail,s=>{
        if(s.status!=='ready')throw error('INVALID_STATE','Finish the recording before exporting.');
        const entries=[];let bytes=0,last=cursor,done=false;
        const q=tx.objectStore(ENTRIES).openCursor(range().bound([id,cursor||''],[id,'\uffff'],cursor!==null,false));
        q.onsuccess=()=>{try{const c=q.result;if(!c){done=true;return;}const {entry}=c.value,size=byteSize(entry)+1;
          if(entries.length>=limit||bytes+size>maxBytes){if(!entries.length)throw error('ROW_TOO_LARGE','One row exceeds this page byte limit; retry with a larger limit.');return;}
          entries.push(entry);bytes+=size;last=entry.id;c.continue();
        }catch(e){fail(e);}};
        set(()=>({id,status:'ready',entries,bytes,count:s.count,cursor:done?null:last,done}));
      });
    });
  }
  // Terminal state is committed before indexed, bounded cleanup. Retry this same
  // operation after cleanup failure; it is idempotent, including after restart.
  async function terminal(owner,id,state){
    const expected=ownerValue(owner);sessionId(id);const db=await database();
    const metadata=await transact(db,SESSIONS,'readwrite',(tx,set,fail)=>{const store=tx.objectStore(SESSIONS);loaded(store,id,fail,s=>{
      owns(s,expected);
      if(s.status!==state){if(state==='saved'?s.status!=='ready':!['recording','ready'].includes(s.status))throw error('INVALID_STATE','Recording cannot enter that terminal state.');s.status=state;s.updatedAt=Date.now();if(state==='saved')s.savedAt=s.updatedAt;else s.discardedAt=s.updatedAt;s.cleanupComplete=false;store.put(s);}
      set(safe(s));
    });});
    if(metadata.cleanupComplete)return metadata;
    for(;;){const removed=await transact(db,ENTRIES,'readwrite',(tx,set)=>{const store=tx.objectStore(ENTRIES),r=store.index('session').getAllKeys(range().only(id),DISTRIBUTION_MAX_ROWS);r.onsuccess=()=>{for(const key of r.result)store.delete(key);set(r.result.length);};});if(removed<DISTRIBUTION_MAX_ROWS)break;}
    return transact(db,SESSIONS,'readwrite',(tx,set,fail)=>{const store=tx.objectStore(SESSIONS);loaded(store,id,fail,s=>{s.cleanupComplete=true;store.put(s);set(safe(s));});});
  }
  return {start,status,append,finish,exportPage,
    // Call saved only after the external destination's close() succeeds.
    saved:(owner,id)=>terminal(owner,id,'saved'),
    discard:(owner,id)=>terminal(owner,id,'discarded'),
    abort:(owner,id)=>terminal(owner,id,'aborted'),
    _database:database,
    async close(){closed=true;(await opened).close();},
    async destroy(){closed=true;(await opened).close();return new Promise((resolve,reject)=>{const r=idb.deleteDatabase(databaseName);r.onsuccess=()=>resolve();r.onerror=()=>reject(typed(r.error));r.onblocked=()=>reject(error('BLOCKED','Distribution database is still open.',true));});}
  };
}
