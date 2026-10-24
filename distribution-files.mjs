// Native handles stay in this extension origin's private database, never runtime messages.
export const DISTRIBUTION_FILES_DATABASE='crave-ai-distribution-files';
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
export function createDistributionFileStore(idb=globalThis.indexedDB,randomUUID=()=>globalThis.crypto.randomUUID()){
  let opened;
  function database(){return opened??=(new Promise((resolve,reject)=>{
    if(!idb?.open){reject(Error('FILE_STORAGE_UNAVAILABLE'));return;}
    const request=idb.open(DISTRIBUTION_FILES_DATABASE,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('handles');
    let blocked=false;
    request.onerror=()=>reject(Error('FILE_STORAGE_FAILED'));
    request.onblocked=()=>{blocked=true;reject(Error('FILE_STORAGE_BLOCKED'));};
    request.onsuccess=()=>{const db=request.result;if(blocked){db.close();return;}db.onversionchange=()=>db.close();resolve(db);};
  }));}
  async function transaction(mode,operation){const db=await database();return new Promise((resolve,reject)=>{
    let tx,result;try{tx=db.transaction('handles',mode);const request=operation(tx.objectStore('handles'));request.onsuccess=()=>{result=request.result;};}catch(e){reject(e);return;}
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||Error('FILE_STORAGE_FAILED'));tx.onerror=()=>{};
  });}
  return {
    async put(handle){if(handle?.kind!=='file'||typeof handle.name!=='string'||!handle.name||typeof handle.createWritable!=='function')throw Error('INVALID_FILE_HANDLE');const id=randomUUID();if(!validId(id))throw Error('INVALID_SELECTION');await transaction('readwrite',s=>s.put(handle,id));return id;},
    async get(id){if(!validId(id))return undefined;return transaction('readonly',s=>s.get(id));},
    async delete(id){if(validId(id))await transaction('readwrite',s=>s.delete(id));},
    async close(){if(opened)(await opened).close();}
  };
}
