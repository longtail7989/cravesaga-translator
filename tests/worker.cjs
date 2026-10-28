// Service worker integration tests with in-memory Chrome/IDB and fake HTTP only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..'),memory={},cache=new Map(),listeners=[],installed=[];const sentMessages=[];let uiPagesOpened=0,activeTab=null,frameMock=null;let httpCalls=0,seenOptions,responseMode='normal',transformProviderText=null;let beforeRead=null,releaseFetch=null,translationReads=0;
// Deliberately bounded IDB model for worker routing regressions, not a native IDB authority.
// Real browser tests cover locking, lifetime, durability and engine-specific event ordering.
const databases=new Map(),MAX_ROWS=100000,MAX_REQUESTS=500000;
const copy=v=>v===undefined?undefined:structuredClone(v);
const keyOf=(v,p)=>Array.isArray(p)?p.map(k=>v[k]):v[p];
const encoded=k=>Array.isArray(k)?'array:'+JSON.stringify(k):k;
function compare(a,b){if(Array.isArray(a)||Array.isArray(b)){if(!Array.isArray(a))return -1;if(!Array.isArray(b))return 1;for(let i=0;i<Math.min(a.length,b.length);i++){const n=compare(a[i],b[i]);if(n)return n;}return a.length-b.length;}return a===b?0:a<b?-1:1;}
const IDBKeyRange={bound:(lower,upper,lowerOpen=false,upperOpen=false)=>({lower,upper,lowerOpen,upperOpen}),lowerBound:(lower,lowerOpen=false)=>({lower,lowerOpen}),only:key=>({lower:key,upper:key})};
const matches=(key,r)=>r==null||((r.lower===undefined||(r.lowerOpen?compare(key,r.lower)>0:compare(key,r.lower)>=0))&&(r.upper===undefined||(r.upperOpen?compare(key,r.upper)<0:compare(key,r.upper)<=0)));
function makeDatabase(name){
  const stores=new Map();let serial=[],running=false,version=0;
  const names=map=>({contains:n=>map.has(n),[Symbol.iterator]:()=>map.keys()});
  const db={get version(){return version;},objectStoreNames:names(stores),close(){},createObjectStore(n,{keyPath}={}){if(stores.has(n))throw Error('ConstraintError');stores.set(n,{rows:n==='translations'&&name==='crave-ai-cache'?cache:new Map(),keyPath,indexes:new Map()});return schema(n);},transaction(input,mode='readonly'){
    const requested=typeof input==='string'?[input]:Array.from(input);for(const n of requested)if(!stores.has(n))throw Error('NotFoundError: '+n);
    if(requested.includes('translations'))translationReads++;const write=mode==='readwrite',tx={error:null};let staged,queue=[],started=false,ended=false,aborted=false,steps=0,draining=false;
    const finish=()=>{if(ended)return;ended=true;if(write&&!aborted)for(const n of requested){const live=stores.get(n).rows;live.clear();for(const [k,v]of staged.get(n))live.set(k,v);}try{if(aborted)tx.onabort?.({target:tx});else tx.oncomplete?.({target:tx});}finally{running=false;pump();}};
    const drain=()=>{if(!started||draining||ended)return;draining=true;setTimeout(()=>{draining=false;if(aborted){finish();return;}const task=queue.shift();if(!task){finish();return;}try{if(++steps>MAX_REQUESTS)throw Error('IDB shim request bound exceeded');task();}catch(e){tx.error=e;aborted=true;tx.onerror?.({target:tx});}drain();},0);};
    function request(fn){if(ended||aborted)throw Error('TransactionInactiveError');const r={result:undefined,error:null};queue.push(()=>{try{r.result=copy(fn());r.onsuccess?.({target:r});}catch(e){r.error=e;r.onerror?.({target:r});throw e;}});drain();return r;}
    function view(n,indexName){const spec=stores.get(n);if(!requested.includes(n))throw Error('NotFoundError');const rows=()=>staged.get(n);
      const selected=(range,direction='next')=>{const out=[];for(const [pk,value]of rows()){const primaryKey=keyOf(value,spec.keyPath),key=indexName?keyOf(value,spec.indexes.get(indexName)):primaryKey;if(key===undefined||(Array.isArray(key)&&key.some(x=>x===undefined)))continue;if(matches(key,range))out.push({key,primaryKey,value});}out.sort((a,b)=>compare(a.key,b.key)||compare(a.primaryKey,b.primaryKey));if(direction.startsWith('prev'))out.reverse();return out;};
      const bounded=(range,count,keys)=>{if(count!==undefined&&(!Number.isInteger(count)||count<1))throw Error('DataError');const list=selected(range);if(count===undefined&&list.length>10000)throw Error('IDB shim unbounded read >10000');return list.slice(0,count??10000).map(x=>keys?x.primaryKey:x.value);};
      const cursor=(range,direction='next',keysOnly=false)=>{const r={result:undefined};let last=null;const enqueue=()=>{queue.push(()=>{const list=selected(range,direction),row=last===null?list[0]:list.find(x=>{const c=compare(x.key,last.key)||compare(x.primaryKey,last.primaryKey);return direction.startsWith('prev')?c<0:c>0;});if(!row){r.result=null;r.onsuccess?.({target:r});return;}last={key:copy(row.key),primaryKey:copy(row.primaryKey)};let continued=false;r.result={key:copy(row.key),primaryKey:copy(row.primaryKey),...(keysOnly?{}:{value:copy(row.value)}),continue(next){if(continued)throw Error('InvalidStateError');continued=true;if(next!==undefined)throw Error('Shim supports continue() without a key only');enqueue();},delete:()=>api.delete(row.primaryKey),update:value=>api.put(value)};r.onsuccess?.({target:r});});drain();};enqueue();return r;};
      const api={get:key=>request(()=>{if(n==='translations'&&beforeRead)beforeRead(key);return indexName?selected(IDBKeyRange.only(key))[0]?.value:rows().get(encoded(key));}),getAll:(range,count)=>request(()=>bounded(range,count,false)),getAllKeys:(range,count)=>request(()=>bounded(range,count,true)),count:range=>request(()=>selected(range).length),put:value=>request(()=>{if(!write)throw Error('ReadOnlyError');const k=keyOf(value,spec.keyPath);if(k===undefined)throw Error('DataError');if(rows().size>=MAX_ROWS&&!rows().has(encoded(k)))throw Error('IDB shim row bound exceeded');rows().set(encoded(k),copy(value));return k;}),delete:key=>request(()=>{if(!write)throw Error('ReadOnlyError');rows().delete(encoded(key));}),clear:()=>request(()=>{if(!write)throw Error('ReadOnlyError');rows().clear();}),index:index=>{if(!spec.indexes.has(index))throw Error('NotFoundError');return view(n,index);},indexNames:names(spec.indexes),openCursor:(range,direction)=>cursor(range,direction),openKeyCursor:(range,direction)=>cursor(range,direction,true)};return api;
    }
    tx.objectStore=n=>view(n);tx.abort=()=>{if(ended)throw Error('InvalidStateError');aborted=true;drain();};serial.push(()=>{staged=new Map(requested.map(n=>[n,new Map([...stores.get(n).rows].map(([k,v])=>[k,copy(v)]))]));started=true;drain();});pump();return tx;
  }};
  function schema(n){const s=stores.get(n);return {indexNames:names(s.indexes),createIndex(name,keyPath){s.indexes.set(name,keyPath);return {};}};}
  function pump(){if(running||!serial.length)return;running=true;setTimeout(serial.shift(),0);}
  return {db,stores,schema,setVersion:v=>{version=v;}};
}
const idb={open(name,version=1){const r={};setTimeout(()=>{try{let state=databases.get(name);if(!state){state=makeDatabase(name);databases.set(name,state);}r.result=state.db;if(version>state.db.version){const oldVersion=state.db.version;r.transaction={objectStore:n=>state.schema(n)};r.onupgradeneeded?.({oldVersion,newVersion:version,target:r});state.setVersion(version);}r.onsuccess?.({target:r});}catch(e){r.error=e;r.onerror?.({target:r});}},0);return r;},deleteDatabase(name){const r={};setTimeout(()=>{databases.delete(name);r.onsuccess?.({target:r});},0);return r;}};
// Trusted raw fixtures bypass CacheStore, so keep its maintained counter consistent.
function rawCacheSet(id,value){cache.set(id,copy(value));databases.get('crave-ai-cache').stores.get('cache-metadata').rows.set('translation-count',{id:'translation-count',count:cache.size});}
const chrome={storage:{local:{setAccessLevel:async()=>{},get:async key=>typeof key==='string'?{[key]:memory[key]}:{...memory},set:async value=>Object.assign(memory,value)}},permissions:{contains:async()=>true},tabs:{query:async()=>activeTab==null?[]:[{id:activeTab}],sendMessage:async(_id,m)=>{sentMessages.push({tabId:_id,message:copy(m)});if(m.type==='PUBLIC_CONFIG_CHANGED')return;if(!frameMock)throw Error('No receiver');return frameMock;}}, runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,openOptionsPage:async()=>{uiPagesOpened++;},onMessage:{addListener:l=>listeners.push(l)},onInstalled:{addListener:l=>installed.push(l)}}};
const fakeFetch=async(url,options)=>{httpCalls++;seenOptions=options;if(responseMode==='deferred')await new Promise(resolve=>{releaseFetch=resolve;});if(responseMode==='large')return new Response('x'.repeat(2000001),{status:200});const body=JSON.parse(options.body),user=JSON.parse(body.messages[1].content);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations:user.items.map(x=>({id:x.id,text:transformProviderText?transformProviderText(x):x.text.replace('攻撃力が','공격력이 ').replace('上昇する。',' 상승합니다.')}))})}}]}),{status:200,headers:{'Content-Type':'application/json'}});};
const context=vm.createContext({chrome,indexedDB:idb,IDBKeyRange,crypto:require('node:crypto').webcrypto,URL,TextEncoder,TextDecoder,Uint8Array,AbortController,setTimeout,clearTimeout,Response,fetch:fakeFetch,console});
const core=new vm.SourceTextModule(fs.readFileSync(path.join(root,'core.mjs'),'utf8'),{context});await core.link(()=>{});await core.evaluate();const modules=new Map([['./core.mjs',core]]);function loadModule(spec){if(modules.has(spec))return modules.get(spec);if(spec==='./network-client.mjs'){const mock=new vm.SyntheticModule(['createNetworkClient'],function(){this.setExport('createNetworkClient',()=>({cancelAll:async()=>{},jsonFetch:async(url,options={})=>{const r=await fakeFetch(url,{...options,credentials:'omit',redirect:'error'});const raw=await r.text();if(raw.length>2000000)throw Object.assign(Error('large'),{code:'RESPONSE_TOO_LARGE',retryable:false});return JSON.parse(raw);}}));},{context});modules.set(spec,mock);return mock;}const mod=new vm.SourceTextModule(fs.readFileSync(path.join(root,spec),'utf8'),{context});modules.set(spec,mod);return mod;}const bg=loadModule('./background.mjs');await bg.link(loadModule);await bg.evaluate();
const admin={id:'test',url:'chrome-extension://test/popup.html'},game={id:'test',url:'https://gg-client-r.crave-saga.net/client/1.1.122/index_dmm.html',tab:{id:1},frameId:8,documentId:'mock'};
const send=(message,sender=admin)=>new Promise(resolve=>listeners[0](message,sender,resolve));let tests=0;const check=(name,fn)=>{fn();tests++;console.log('PASS '+name);};
let httpBefore=httpCalls;let r=await send({type:'GET_SETTINGS'});check('fresh settings are paused without HTTP',()=>{assert.equal(r.ok,true);assert.equal(r.settings.enabled,false);assert.equal(httpCalls,0);});
r=await send({type:'GET_SETTINGS'},game);check('game frame cannot retrieve secrets',()=>{assert.equal(r.ok,false);assert(!r.settings);});
httpBefore=httpCalls;r=await send({type:'SAVE_SETTINGS',settings:{provider:'custom',endpoint:'http://127.0.0.1:1234/v1',model:'mock',apiKey:'FAKE_ONLY_TEST',enabled:true,consent:true}});check('trusted options save config',()=>assert.equal(r.ok,true));
httpBefore=httpCalls;r=await send({type:'PUBLIC_CONFIG'},game);check('page config excludes key and endpoint',()=>{assert.equal(r.config.configured,true);assert(!JSON.stringify(r).includes('FAKE_ONLY_TEST'));assert(!('endpoint'in r.config));});
httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'a',source:'攻撃力が10%上昇する。',context:'Skill'}]},game);check('worker protects restores and posts without cookies',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].text,'공격력이 10% 상승합니다.');assert.equal(httpCalls,httpBefore+1);assert.equal(seenOptions.credentials,'omit');assert.equal(seenOptions.redirect,'error');assert.equal(r.usage.requests,1);});
httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'b',source:'攻撃力が10%上昇する。',context:'Skill'}]},game);check('repeat source/context reuses cache without HTTP',()=>{assert.equal(r.results[0].cached,true);assert.equal(httpCalls,httpBefore);});
httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'c',source:'攻撃力が10%上昇する。',context:'Story'}]},game);check('same source across contexts reuses the source-only cache',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].cached,true);assert.equal(httpCalls,httpBefore);});
httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'d',source:'攻撃'}]},{...game,url:'https://attacker.example/'});check('unapproved URL cannot trigger paid call',()=>{assert.equal(r.ok,false);assert.equal(httpCalls,httpBefore);});
await send({type:'SET_ENABLED',enabled:false},game);httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'e',source:'防御'}]},game);check('paused config refuses requests',()=>{assert.equal(r.ok,false);assert.equal(httpCalls,httpBefore);});
await send({type:'SET_ENABLED',enabled:true});memory.settings.dailyRequestLimit=500;memory.usage.requests=500;httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'f',source:'防御'}]},game);check('daily request cap prevents additional billable calls',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].code,'QUOTA');assert.equal(httpCalls,httpBefore);});
memory.settings.dailyRequestLimit=0;memory.settings.dailyCharLimit=100000;memory.usage.requests=0;memory.usage.chars=100000;httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'g',source:'防御'}]},game);check('daily character cap prevents additional calls',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].code,'QUOTA');assert.equal(httpCalls,httpBefore);});
memory.settings.dailyCharLimit=0;memory.usage.chars=0;responseMode='large';httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'h',source:'治癒'}]},game);check('oversized provider response is rejected without caching',()=>{assert.equal(r.ok,true);assert(r.results[0].error.includes('크기 제한'));assert.equal(httpCalls,httpBefore+1);});
responseMode='normal';
httpBefore=httpCalls;let saved=await send({type:'SAVE_SETTINGS',settings:{provider:'custom',endpoint:'http://127.0.0.1:1234/v1',model:'different-model',enabled:true,consent:true}});httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'newmodel',source:'攻撃力が10%上昇する。',context:'Skill'}]},game);check('provider/model selection does not invalidate translated-source cache',()=>{assert.equal(saved.ok,true);assert.equal(r.results[0].cached,true);assert.equal(httpCalls,httpBefore);});
httpBefore=httpCalls;r=await send({type:'SAVE_SETTINGS',settings:{cacheOnly:true,enabled:true,consent:false,model:'',apiKey:''}});check('cache-only mode can be saved and enabled without credentials',()=>{assert.equal(r.ok,true);assert.equal(r.settings.cacheOnly,true);});
httpBefore=httpCalls;r=await send({type:'CACHE_LOOKUP',items:[{id:'local',source:'攻撃力が10%上昇する。',context:'Skill'}]},game);check('fast local lookup returns translation without LLM or quota use',()=>{assert.equal(r.results[0].text,'공격력이 10% 상승합니다.');assert.equal(httpCalls,httpBefore);});
httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'offline-miss',source:'未翻訳の文章'}]},game);check('cache-only misses never invoke any provider',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].missing,true);assert.equal(httpCalls,httpBefore);});
const legacyId=await core.namespace.hashKey(core.namespace.legacyCacheIdentity(memory.settings,'防御','Menu'));rawCacheSet(legacyId,{id:legacyId,text:'방어',time:Date.now()-1000});httpBefore=httpCalls;r=await send({type:'CACHE_LOOKUP',items:[{id:'legacy',source:'防御',context:'Menu'}]},game);check('v0.1 opaque hash cache is reused and promoted on matching sighting',()=>{assert.equal(r.results[0].text,'방어');assert(!cache.has(legacyId));assert([...cache.values()].some(x=>x.source==='防御'&&x.id.startsWith('v3:')));});
httpBefore=httpCalls;r=await send({type:'CACHE_WARM'},game);check('warm cache supplies only translation records without settings',()=>{assert(r.entries.length>=2);assert(!JSON.stringify(r).includes('FAKE_ONLY_TEST'));assert(!Object.hasOwn(r,'settings'));assert.equal(httpCalls,httpBefore);});
const exported=await send({type:'EXPORT_CACHE'});check('export contains original text and stable IDs but no credentials',()=>{assert.equal(exported.ok,true);assert.equal(exported.exported,2);assert.equal(exported.data.version,3);assert(exported.data.entries.every(x=>typeof x.context==='string'));assert(exported.data.entries.some(x=>x.context==='Skill'));assert(exported.data.entries.some(x=>x.context==='Menu'));assert(exported.data.entries.every(x=>x.source&&x.id.startsWith('v3:')));assert(!JSON.stringify(exported).includes('FAKE_ONLY_TEST'));});
r=await send({type:'EXPORT_CACHE'},game);check('game cannot export or import full private cache',()=>assert.equal(r.ok,false));
await send({type:'CLEAR_CACHE',confirmed:true});r=await send({type:'IMPORT_CACHE',data:exported.data,mode:'replace'});check('file round trip restores all entries after clear',()=>{assert.equal(r.ok,true);assert.equal(r.imported,2);assert.equal(r.cacheCount,2);});
const changed=structuredClone(exported.data);changed.entries=changed.entries.filter(x=>x.context==='Skill');changed.entries[0].text='공격력이 10% 증가합니다.';r=await send({type:'IMPORT_CACHE',data:changed,mode:'merge'});check('merge preserves existing translation and reports skipped conflict',()=>{assert.equal(r.ok,true);assert.equal(r.imported,0);assert.equal(r.skipped,1);});
const bad=structuredClone(changed);bad.entries[0].text='공격력이 99% 증가합니다.';r=await send({type:'IMPORT_CACHE',data:bad,mode:'replace'});check('translation content differences import unchanged with warnings',()=>{assert.equal(r.ok,true);assert.equal(r.imported,1);assert.equal(r.validationWarnings,1);assert.equal(cache.get(bad.entries[0].id).text,bad.entries[0].text);});
r=await send({type:'IMPORT_CACHE',data:changed,mode:'replace'});check('explicit replace atomically installs selected file only',()=>{assert.equal(r.ok,true);assert.equal(r.cacheCount,1);});
const restartHttpBefore=httpCalls;const bgRestart=new vm.SourceTextModule(fs.readFileSync(path.join(root,'background.mjs'),'utf8'),{context});await bgRestart.link(loadModule);await bgRestart.evaluate();r=await new Promise(resolve=>listeners[1]({type:'CACHE_LOOKUP',items:[{id:'restart',source:'攻撃力が10%上昇する。',context:'Skill'}]},game,resolve));check('new service worker reuses persistent imported cache without AI',()=>{assert.equal(r.results[0].text,'공격력이 10% 증가합니다.');assert.equal(httpCalls,restartHttpBefore);});
const cm=modules.get('./cache.mjs').namespace;const newest=await cm.makeCacheEntry({source:'再検査',context:'Menu',target:'한국어',text:'재검사 (최신)'});const raceLegacy=await core.namespace.hashKey(core.namespace.legacyCacheIdentity(memory.settings,'再検査','Menu'));rawCacheSet(raceLegacy,{id:raceLegacy,text:'재검사 (이전)',time:Date.now()-1000});beforeRead=id=>{if(id===raceLegacy){rawCacheSet(newest.id,newest);beforeRead=null;}};httpBefore=httpCalls;r=await send({type:'CACHE_LOOKUP',items:[{id:'race',source:'再検査',context:'Menu'}]},game);check('legacy promotion cannot overwrite a newer canonical cache entry',()=>{assert.equal(r.results[0].text,'재검사 (최신)');assert.equal(cache.get(newest.id).text,'재검사 (최신)');assert(!cache.has(raceLegacy));});
r=await send({type:'GET_ACTIVE_STATUS'},game);check('game frame cannot request popup active-tab operations',()=>assert.equal(r.ok,false));
r=await send({type:'GET_ACTIVE_STATUS'});check('popup handles missing active game tab without navigation',()=>{assert.equal(r.ok,true);assert.equal(r.found,false);assert.equal(uiPagesOpened,0);});
activeTab=99;frameMock={ok:true,status:{ready:true,translated:3,stopped:false},notice:'',cacheHits:4,queued:0};r=await send({type:'GET_ACTIVE_STATUS'});check('popup can read nonsecret game status',()=>{assert.equal(r.found,true);assert.equal(r.status.translated,3);assert.equal(r.cacheHits,4);assert(!r.settings);});
r=await send({type:'OPEN_READER'});check('removed reader command is rejected without navigation',()=>{assert.equal(r.ok,false);assert.equal(uiPagesOpened,0);});
frameMock=null;r=await send({type:'GET_ACTIVE_STATUS'});check('popup status handles missing game receiver safely',()=>{assert.equal(r.ok,true);assert.equal(r.found,false);});
r=await send({type:'OPEN_OPTIONS'},game);check('legacy in-game settings request does not open a full page',()=>{assert.equal(r.ok,false);assert.equal(uiPagesOpened,0);});
const savedSettings=memory.settings;delete memory.settings;await installed[0]();check('fresh install initializes paused settings without automatic options tab',()=>{assert.equal(memory.settings.enabled,false);assert.equal(uiPagesOpened,0);});memory.settings=savedSettings;
const regressionGame={...game,documentId:'reliability-regression'};
r=await send({type:'GET_SETTINGS'},{...admin,tab:{id:99}});check('trusted popup opened as a tab can load settings without broadening game access',()=>assert.equal(r.ok,true));
await send({type:'SAVE_SETTINGS',settings:{provider:'custom',endpoint:'http://127.0.0.1:1234/v1',model:'mock',enabled:true,consent:true,requestTimeoutSeconds:180,dailyCharLimit:0,dailyRequestLimit:0}});memory.usage.chars=10000000;memory.usage.requests=100000;httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'unlimited',source:'攻撃力が20%上昇する。',context:'Skill'}]},regressionGame);check('zero daily limits continue beyond the old mandatory quotas',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].text,'공격력이 20% 상승합니다.');});
const unchanged=await cm.makeCacheEntry({source:'未翻訳の原文',context:'Menu',target:'한국어',text:'未翻訳の原文'});rawCacheSet(unchanged.id,unchanged);httpBefore=httpCalls;r=await send({type:'TRANSLATE',items:[{id:'unchanged',source:'未翻訳の原文',context:'Menu'}]},regressionGame);check('unchanged Japanese cache is bypassed and unchanged model output is flagged',()=>{assert.equal(r.results[0].code,'UNTRANSLATED');assert.equal(r.results[0].retryable,true);});
responseMode='deferred';const deferred=send({type:'TRANSLATE',items:[{id:'deferred',source:'攻撃力が30%上昇する。',context:'Skill'}]},regressionGame);for(let i=0;i<100&&!releaseFetch;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseFetch,'function');await send({type:'SET_ENABLED',enabled:false});await send({type:'SET_ENABLED',enabled:true});responseMode='normal';releaseFetch();r=await deferred;check('pause then resume invalidates old in-flight writes before caching',()=>{assert.equal(r.results[0].code,'CANCELLED');assert(![...cache.values()].some(x=>x.source==='攻撃力が30%上昇する。'));});
activeTab=99;frameMock={ok:true,status:{ready:true}};r=await send({type:'RETRY_FAILED'});const retryOk=r.ok;frameMock=null;r=await send({type:'RETRY_FAILED'});check('manual retry routes to an existing game and fails safely without one',()=>{assert.equal(retryOk,true);assert.equal(r.ok,false);});

// Exercise new admin-only routes against the real CacheStore/CacheTransfer modules.
const routeHttpBefore=httpCalls,routeRevision=memory.configRevision,routeCount=cache.size;
for(const type of ['DELETE_OLDEST','EXPORT_START','EXPORT_PAGE','EXPORT_END','IMPORT_START','IMPORT_BATCH','IMPORT_COMMIT','IMPORT_ABORT','IMPORT_CACHE']){
  r=await send({type,count:1,mode:'replace',entries:[]},game);
  check(type+' is private to extension admin pages',()=>{assert.equal(r.ok,false);assert.equal(cache.size,routeCount);assert.equal(memory.configRevision,routeRevision);assert.equal(httpCalls,routeHttpBefore);});
}
for(const count of [0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1,null]){
  r=await send({type:'DELETE_OLDEST',count});
  check('DELETE_OLDEST rejects invalid count '+JSON.stringify(count),()=>{assert.equal(r.ok,false);assert.equal(cache.size,routeCount);assert.equal(memory.configRevision,routeRevision);});
}
const streamStart=await send({type:'EXPORT_START'});
const streamPage=await send({type:'EXPORT_PAGE',token:streamStart.token,cursor:null});
check('stream export uses the current source-v3 file header and real bounded store cursor',()=>{assert.equal(streamStart.ok,true);assert.equal(streamStart.header.version,3);assert.equal(streamStart.header.identity,'source-v3');assert.equal(streamPage.ok,true);assert.equal(streamPage.done,true);assert(streamPage.entries.every(x=>x.id.startsWith('v3:')));assert(!JSON.stringify(streamPage).includes('FAKE_ONLY_TEST'));});
r=await send({type:'EXPORT_END',token:streamStart.token});check('stream export end purges its private metadata',()=>assert.equal(r.ok,true));
const duplicateFile=structuredClone(exported.data),duplicateBase=duplicateFile.entries.find(x=>x.context==='Skill');
const duplicateOld={...duplicateBase,context:'Story',id:await cm.cacheIdV2(duplicateBase.target,duplicateBase.source,'Story')};
duplicateFile.entries.push(duplicateOld);
r=await send({type:'IMPORT_CACHE',data:duplicateFile,mode:'replace'});
check('portable file imports deduplicate verified old context IDs into one exact source entry',()=>{assert.equal(r.ok,true);assert.equal(r.imported,2);assert.equal(r.skipped,1);assert.equal(r.cacheCount,2);assert.equal([...cache.values()].filter(x=>x.source===duplicateBase.source).length,1);assert([...cache.values()].every(x=>x.id.startsWith('v3:')));});
const staged=await send({type:'IMPORT_START',mode:'replace'});
r=await send({type:'IMPORT_BATCH',token:staged.token,entries:exported.data.entries});
check('stream import stages validated compound keys without touching live translations',()=>{assert.equal(r.ok,true);assert.equal(r.uniqueStaged,2);assert.equal(cache.size,2);});
const beforeBadCommit=JSON.stringify([...cache]),badCommitRevision=memory.configRevision;
r=await send({type:'IMPORT_COMMIT',token:staged.token,header:streamStart.header,expectedCount:3});
check('stream import count mismatch preserves live data and config revision',()=>{assert.equal(r.ok,false);assert.equal(JSON.stringify([...cache]),beforeBadCommit);assert.equal(memory.configRevision,badCommitRevision);});
r=await send({type:'IMPORT_ABORT',token:staged.token});
check('stream import abort purges compound staging keys without deleting live data',()=>{assert.equal(r.ok,true);assert.equal(JSON.stringify([...cache]),beforeBadCommit);const rows=databases.get('crave-ai-cache').stores.get('imports').rows;assert(![...rows.values()].some(x=>x.token===staged.token));});
const oldest=await cm.makeCacheEntry({source:'古い項目',context:'Menu',target:'한국어',text:'오래된 항목',createdAt:1,updatedAt:1});
const retained=await cm.makeCacheEntry({source:'残す項目',context:'Story',target:'한국어',text:'남길 항목',createdAt:2,updatedAt:2});
rawCacheSet(oldest.id,oldest);rawCacheSet(retained.id,retained);
const deleteCountBefore=cache.size,deleteRevision=memory.configRevision,deleteSettings=JSON.stringify(memory.settings);
r=await send({type:'DELETE_OLDEST',count:1});
check('admin DELETE_OLDEST deletes exactly the oldest row and updates maintained count without config invalidation',()=>{assert.equal(r.ok,true);assert.equal(r.deleted,1);assert.equal(r.cacheCount,deleteCountBefore-1);assert.equal(cache.size,deleteCountBefore-1);assert(!cache.has(oldest.id));assert(cache.has(retained.id));assert.equal(databases.get('crave-ai-cache').stores.get('cache-metadata').rows.get('translation-count').count,cache.size);assert.equal(memory.configRevision,deleteRevision);assert.equal(JSON.stringify(memory.settings),deleteSettings);assert.equal(httpCalls,routeHttpBefore);});

const successfulStage=await send({type:'IMPORT_START',mode:'replace'});
await send({type:'IMPORT_BATCH',token:successfulStage.token,entries:exported.data.entries});
const successRevision=memory.configRevision;
r=await send({type:'IMPORT_COMMIT',token:successfulStage.token,header:streamStart.header,expectedCount:exported.data.entries.length});
check('valid streamed replacement commits with canonical IDs, maintained counter and config invalidation',()=>{assert.equal(r.ok,true);assert.equal(r.imported,2);assert.equal(r.cacheCount,2);assert.equal(cache.size,2);assert.notEqual(memory.configRevision,successRevision);assert([...cache.values()].every(x=>x.id.startsWith('v3:')&&Number.isSafeInteger(x.reverseTime)));assert.equal(databases.get('crave-ai-cache').stores.get('cache-metadata').rows.get('translation-count').count,2);assert.equal(httpCalls,routeHttpBefore);});
// Independent pre-v4 database crosses migration's 64-row cursor checkpoint.
const migrationName='worker-migration-regression',migrationState=makeDatabase(migrationName);
databases.set(migrationName,migrationState);migrationState.setVersion(1);
migrationState.db.createObjectStore('translations',{keyPath:'id'});
const migrationRows=[];
for(let i=0;i<66;i++){
  const source='移行項目'+i,entry=await cm.makeCacheEntry({source,context:'Menu',target:'한국어',text:'이전 항목'+i,createdAt:10,updatedAt:10});
  entry.id=await cm.cacheIdV2(entry.target,source,entry.context);migrationRows.push(entry);
}
for(const [contextName,time,text]of [['Skill',11,'오래된 번역'],['Story',12,'최신 번역']]){
  const entry=await cm.makeCacheEntry({source:'重複原文',context:contextName,target:'한국어',text,createdAt:time,updatedAt:time});
  entry.id=await cm.cacheIdV2(entry.target,entry.source,entry.context);migrationRows.push(entry);
}
await new Promise((resolve,reject)=>{const tx=migrationState.db.transaction('translations','readwrite');tx.oncomplete=resolve;tx.onerror=tx.onabort=reject;for(const row of migrationRows)tx.objectStore('translations').put(row);});
const migratedStore=modules.get('./cache-store.mjs').namespace.createCacheStore(idb,{databaseName:migrationName});
const migratedCount=await migratedStore.count(),migrationLookup=await migratedStore.lookup({source:'重複原文',context:'Other'},memory.settings);
check('bounded migration preserves count and deduplicates legacy context identities',()=>{assert.equal(migratedCount,67);assert.equal(migrationLookup.text,'최신 번역');assert([...migrationState.stores.get('translations').rows.keys()].every(x=>x.startsWith('v3:')));assert.equal(migrationState.stores.get('cache-metadata').rows.get('translation-count').count,67);});
await migratedStore.destroy();
check('test IDB database deletion is scoped and leaves worker cache intact',()=>{assert(!databases.has(migrationName));assert.equal(cache.size,2);});

// Manual cache editor regressions: fake provider, real editor/store/router only.
const editStore=modules.get('./cache-store.mjs').namespace.createCacheStore(idb);
const editBase=[...cache.values()].find(x=>x.source==='攻撃力が10%上昇する。');
const editSnapshot=JSON.stringify([...cache]),editRevision=memory.configRevision,editSettings=JSON.stringify(memory.settings),editHttp=httpCalls;
for(const type of ['CACHE_SEARCH','CACHE_GET','CACHE_EDIT_SAVE']){
  r=await send({type,id:editBase.id,query:editBase.source,source:editBase.source,target:editBase.target,text:'공격력이 10% 수동 상승합니다.',expectedUpdatedAt:editBase.updatedAt,expectedText:editBase.text},game);
  check(type+' denies game callers without leaking records or changing state',()=>{assert.equal(r.ok,false);assert(!r.entry);assert(!r.results);assert.equal(JSON.stringify([...cache]),editSnapshot);assert.equal(memory.configRevision,editRevision);assert.equal(httpCalls,editHttp);});
}
r=await send({type:'CACHE_SEARCH',mode:'exact',query:editBase.source,target:editBase.target});
check('admin exact source search returns a safe preview and source identity',()=>{assert.equal(r.ok,true);assert.equal(r.results.length,1);assert.equal(r.results[0].id,editBase.id);assert.equal(r.results[0].sourcePreview,editBase.source);assert.equal(r.results[0].textPreview,editBase.text);assert(!Object.hasOwn(r.results[0],'source'));assert(!Object.hasOwn(r.results[0],'text'));assert(!JSON.stringify(r).includes('FAKE_ONLY_TEST'));});
for(const query of ['攻撃力','공격력이']){
  r=await send({type:'CACHE_SEARCH',mode:'contains',query});
  check('admin contains search finds '+query+' in original or translation',()=>{assert.equal(r.ok,true);assert(r.results.some(x=>x.id===editBase.id));assert(r.results.every(x=>x.sourcePreview.length<=180&&x.textPreview.length<=300));});
}
r=await send({type:'CACHE_SEARCH',mode:'exact',query:editBase.source,target:'English'});
check('exact search respects target language',()=>{assert.equal(r.ok,true);assert.equal(r.results.length,0);});
r=await send({type:'CACHE_SEARCH',query:'',limit:1});const firstEditPage=r;
r=await send({type:'CACHE_SEARCH',query:'',limit:1,cursor:firstEditPage.cursor});
check('bounded editor search resumes after the last returned primary key',()=>{assert.equal(firstEditPage.ok,true);assert.equal(firstEditPage.results.length,1);assert.equal(firstEditPage.done,false);assert.equal(r.ok,true);assert.equal(r.results.length,1);assert.notEqual(r.results[0].id,firstEditPage.results[0].id);assert(firstEditPage.scanned<=512&&r.scanned<=512);});
const missingEditId=await cm.cacheId('한국어','存在しない編集項目');
r=await send({type:'CACHE_GET',id:missingEditId});
check('admin missing entry returns success without an entry or role leak',()=>{assert.equal(r.ok,true);assert(!Object.hasOwn(r,'entry'));assert(!Object.hasOwn(r,'version'));assert(!r.settings);});
const loadedEdit=await send({type:'CACHE_GET',id:editBase.id});
check('admin get returns original text and optimistic version without index internals',()=>{assert.equal(loadedEdit.ok,true);assert.equal(loadedEdit.entry.source,editBase.source);assert.equal(loadedEdit.version.updatedAt,editBase.updatedAt);assert.equal(loadedEdit.version.text,editBase.text);assert(!Object.hasOwn(loadedEdit.entry,'reverseTime'));});
const editCount=cache.size,editUsage=JSON.stringify(memory.usage),editMessagesStart=sentMessages.length;
const saveEdit={type:'CACHE_EDIT_SAVE',id:editBase.id,source:editBase.source,target:editBase.target,text:'공격력이 10% 수동 상승합니다.',expectedUpdatedAt:editBase.updatedAt,expectedText:editBase.text,context:'caller cannot replace persisted context'};
const manualEdit=await send(saveEdit);
check('manual save preserves source target context and count without settings revision or provider usage',()=>{assert.equal(manualEdit.ok,true);assert.equal(manualEdit.entry.manual,true);assert.equal(manualEdit.entry.source,editBase.source);assert.equal(manualEdit.entry.target,editBase.target);assert.equal(manualEdit.entry.context,editBase.context);assert.equal(manualEdit.entry.createdAt,editBase.createdAt);assert(manualEdit.entry.updatedAt>editBase.updatedAt);assert.equal(manualEdit.cacheCount,editCount);assert.equal(cache.size,editCount);assert.equal(databases.get('crave-ai-cache').stores.get('cache-metadata').rows.get('translation-count').count,editCount);assert.equal(memory.configRevision,editRevision);assert.equal(JSON.stringify(memory.settings),editSettings);assert.equal(JSON.stringify(memory.usage),editUsage);assert.equal(httpCalls,editHttp);});
check('manual update broadcast carries only the private cache patch without settings or export metadata',()=>{const messages=sentMessages.slice(editMessagesStart);assert.equal(messages.length,1);assert.equal(messages[0].message.type,'CACHE_ENTRY_UPDATED');assert.deepEqual(Object.keys(messages[0].message.entry).sort(),['manual','source','target','text','updatedAt']);assert.equal(messages[0].message.entry.text,manualEdit.entry.text);assert(!JSON.stringify(messages).includes('FAKE_ONLY_TEST'));});
const manualSnapshot=JSON.stringify(cache.get(editBase.id));
for(const patch of [{expectedUpdatedAt:editBase.updatedAt,expectedText:manualEdit.entry.text},{expectedUpdatedAt:manualEdit.entry.updatedAt,expectedText:editBase.text},{source:'別の原文10%'},{target:'English'}]){
  r=await send({...saveEdit,expectedUpdatedAt:manualEdit.entry.updatedAt,expectedText:manualEdit.entry.text,...patch});
  check('optimistic or immutable-field conflict '+JSON.stringify(patch)+' keeps manual record',()=>{assert.equal(r.ok,false);assert.equal(r.code,'CONFLICT');assert.equal(JSON.stringify(cache.get(editBase.id)),manualSnapshot);assert.equal(cache.size,editCount);});
}
for(const text of ['공격력이 99% 상승합니다.','<b>공격력이 10% 상승합니다.</b>']){
  r=await send({...saveEdit,text,expectedUpdatedAt:manualEdit.entry.updatedAt,expectedText:manualEdit.entry.text});
  check('manual edit rejects altered protected numbers or tags '+text,()=>{assert.equal(r.ok,false);assert.equal(JSON.stringify(cache.get(editBase.id)),manualSnapshot);});
}
await editStore.put([{source:editBase.source,context:'late provider',text:'공격력이 10% 자동 상승합니다.'}],memory.settings);
check('automatic cache put cannot overwrite a persisted manual correction',()=>{assert.equal(JSON.stringify(cache.get(editBase.id)),manualSnapshot);assert.equal(awaitCount(),editCount);});
function awaitCount(){return databases.get('crave-ai-cache').stores.get('cache-metadata').rows.get('translation-count').count;}
const manualExport=await send({type:'EXPORT_CACHE'});
check('v3 export preserves manual true and imports versions 1 2 and 3',()=>{assert.equal(manualExport.data.version,3);assert.equal(manualExport.data.entries.find(x=>x.id===editBase.id).manual,true);});
for(const version of [1,2,3]){
  const portable=await cm.validateImport({...manualExport.data,version});
  check('portable reader accepts version '+version+' with manual metadata',()=>assert.equal(portable.find(x=>x.id===editBase.id).manual,true));
}
r=await send({type:'CACHE_EDIT_SAVE',source:'新規編集項目',target:'한국어',text:'신규 편집 항목'});
check('missing entry cannot be created accidentally',()=>{assert.equal(r.ok,false);assert.equal(cache.size,editCount);});
const createdEdit=await send({type:'CACHE_EDIT_SAVE',source:'新規編集項目',target:'한국어',text:'신규 편집 항목',create:true});
check('explicit bounded manual create adds exactly one canonical row',()=>{assert.equal(createdEdit.ok,true);assert.equal(createdEdit.entry.manual,true);assert(createdEdit.entry.id.startsWith('v3:'));assert.equal(createdEdit.cacheCount,editCount+1);assert.equal(awaitCount(),editCount+1);assert.equal(memory.configRevision,editRevision);assert.equal(httpCalls,editHttp);});
r=await send({type:'CACHE_EDIT_SAVE',source:'長'.repeat(8193),target:'한국어',text:'긴 문구',create:true});
check('manual create rejects oversized source without adding a row',()=>{assert.equal(r.ok,false);assert.equal(cache.size,editCount+1);});
// Seed an unusable automatic row so translation starts HTTP but editor can CAS an existing row.
const inflightSource='攻撃力が45%上昇する。';
const inflightSeed=await cm.makeCacheEntry({source:inflightSource,target:'한국어',context:'Skill',text:inflightSource});rawCacheSet(inflightSeed.id,inflightSeed);
responseMode='deferred';releaseFetch=null;const raceHttp=httpCalls,raceRevision=memory.configRevision,raceSettings=JSON.stringify(memory.settings);
const inflightRequest=send({type:'TRANSLATE',items:[{id:'manual-race-owner',source:inflightSource,context:'Skill'}]},{...game,documentId:'manual-race-owner'});
for(let i=0;i<200&&!releaseFetch;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseFetch,'function');
const raceUsage=JSON.stringify(memory.usage),raceCount=cache.size;
const joinedRequest=send({type:'TRANSLATE',items:[{id:'manual-race-joined',source:inflightSource,context:'Story'}]},{...game,documentId:'manual-race-joined'});
// Ordered router lock ensures the joined job has been registered before saving.
await send({type:'GET_SETTINGS'});await new Promise(resolve=>setTimeout(resolve,50));
const raceSave=await send({type:'CACHE_EDIT_SAVE',id:inflightSeed.id,source:inflightSource,target:inflightSeed.target,text:'공격력이 45% 수동 상승합니다.',expectedUpdatedAt:inflightSeed.updatedAt,expectedText:inflightSeed.text});
let joinTimer;const beforeRelease=await Promise.race([joinedRequest,new Promise(resolve=>{joinTimer=setTimeout(()=>resolve(null),500);})]);clearTimeout(joinTimer);
responseMode='normal';releaseFetch();const [raceOwner,raceJoined]=await Promise.all([inflightRequest,joinedRequest]);
check('manual save settles shared pending source job before deferred HTTP completes',()=>{assert.equal(raceSave.ok,true);assert(beforeRelease,'joined request must settle while provider remains blocked');assert.equal(beforeRelease.results[0].manual,true);assert.equal(beforeRelease.results[0].shared,true);assert.equal(beforeRelease.results[0].text,raceSave.entry.text);});
check('late model result preserves manual cache and owner/joined responses without extra HTTP or usage',()=>{for(const reply of [raceOwner,raceJoined]){assert.equal(reply.ok,true);assert.equal(reply.results[0].text,raceSave.entry.text);assert.equal(reply.results[0].manual,true);assert.equal(reply.results[0].cached,true);}assert.equal(cache.get(inflightSeed.id).text,raceSave.entry.text);assert.equal(cache.get(inflightSeed.id).manual,true);assert.equal(cache.size,raceCount);assert.equal(awaitCount(),raceCount);assert.equal(httpCalls,raceHttp+1);assert.equal(JSON.stringify(memory.usage),raceUsage);assert.equal(memory.configRevision,raceRevision);assert.equal(JSON.stringify(memory.settings),raceSettings);});
httpBefore=httpCalls;r=await send({type:'CACHE_LOOKUP',items:[{id:'manual-race-after',source:inflightSource}]},game);
check('post-race cache lookup returns only the saved manual translation without HTTP',()=>{assert.equal(r.results[0].text,raceSave.entry.text);assert.equal(r.results[0].cached,true);assert.equal(httpCalls,httpBefore);});



// Single-entry deletion: privileged CAS, narrow patch, and pending-provider cancellation.
const deleteReq=e=>({type:'CACHE_ENTRY_DELETE',id:e.id,source:e.source,target:e.target,expectedUpdatedAt:e.updatedAt,expectedText:e.text});
const deleteFixture=await cm.makeCacheEntry({source:'削除対象',target:'한국어',text:'삭제 대상',context:'private context'});
const deleteSibling=await cm.makeCacheEntry({source:'削除対象',target:'English',text:'delete target',context:'other target'});
rawCacheSet(deleteFixture.id,deleteFixture);rawCacheSet(deleteSibling.id,deleteSibling);
const deleteLegacy={id:'delete-legacy-opaque',text:'legacy unrelated',time:1};rawCacheSet(deleteLegacy.id,deleteLegacy);
const deleteBefore=JSON.stringify([...cache]),singleCount=cache.size,singleSettings=JSON.stringify(memory.settings),singleUsage=JSON.stringify(memory.usage),singleRevision=memory.configRevision,singleHTTP=httpCalls,singleMessages=sentMessages.length;
for(const sender of [game,{...admin,url:'chrome-extension://test/content.html'},{...admin,url:'https://attacker.example/popup.html'},{...admin,id:'other'}]){
  r=await send(deleteReq(deleteFixture),sender);check('single deletion rejects non-admin '+sender.url+sender.id,()=>{assert.equal(r.ok,false);assert(!r.source);assert.equal(JSON.stringify([...cache]),deleteBefore);});
}
for(const patch of [{expectedUpdatedAt:deleteFixture.updatedAt+1},{expectedText:'stale'},{source:'別の原文'},{target:'English'}]){
  r=await send({...deleteReq(deleteFixture),...patch});check('single deletion CAS/identity guard '+JSON.stringify(patch),()=>{assert.equal(r.ok,false);assert.equal(r.code,'CONFLICT');assert.equal(JSON.stringify([...cache]),deleteBefore);assert.equal(sentMessages.length,singleMessages);});
}
r=await send({...deleteReq(deleteFixture),id:'v2:'+'0'.repeat(64)});check('single deletion rejects legacy identifiers',()=>{assert.equal(r.ok,false);assert.equal(r.code,'BAD_REQUEST');assert.equal(JSON.stringify([...cache]),deleteBefore);});
r=await send(deleteReq(deleteFixture));
check('admin single deletion deletes one exact canonical row and count without settings usage or HTTP',()=>{assert.equal(r.ok,true);assert.equal(r.deleted,1);assert.equal(r.cacheCount,singleCount-1);assert.equal(cache.size,singleCount-1);assert.equal(awaitCount(),singleCount-1);assert(!cache.has(deleteFixture.id));assert.equal(JSON.stringify(cache.get(deleteSibling.id)),JSON.stringify(deleteSibling));assert.deepEqual(cache.get(deleteLegacy.id),deleteLegacy);assert.equal(JSON.stringify(memory.settings),singleSettings);assert.equal(JSON.stringify(memory.usage),singleUsage);assert.equal(memory.configRevision,singleRevision);assert.equal(httpCalls,singleHTTP);});
check('single deletion broadcasts only source and target identity patch',()=>{const messages=sentMessages.slice(singleMessages);assert.equal(messages.length,1);assert.deepEqual(messages[0].message,{type:'CACHE_ENTRY_DELETED',entry:{source:deleteFixture.source,target:deleteFixture.target}});});
r=await send(deleteReq(deleteFixture));check('already deleted row fails safely without another decrement or patch',()=>{assert.equal(r.ok,false);assert.equal(r.code,'CONFLICT');assert.equal(awaitCount(),singleCount-1);assert.equal(sentMessages.length,singleMessages+1);});
const lateDeleteSource='攻撃力が76%上昇する。',lateKeepSource='攻撃力が77%上昇する。';
const lateDeleteSeed=await cm.makeCacheEntry({source:lateDeleteSource,target:'한국어',text:lateDeleteSource});rawCacheSet(lateDeleteSeed.id,lateDeleteSeed);
responseMode='deferred';releaseFetch=null;const lateHTTP=httpCalls;
const lateOwner=send({type:'TRANSLATE',items:[{id:'delete-owner',source:lateDeleteSource},{id:'keep-owner',source:lateKeepSource}]},{...game,documentId:'delete-owner'});
for(let i=0;i<200&&!releaseFetch;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseFetch,'function');
const lateUsage=JSON.stringify(memory.usage),lateSettings=JSON.stringify(memory.settings),lateRevision=memory.configRevision,lateCount=cache.size;
const lateJoined=send({type:'TRANSLATE',items:[{id:'delete-joined',source:lateDeleteSource}]},{...game,documentId:'delete-joined'});
await new Promise(resolve=>setTimeout(resolve,100));
const lateDeleteResult=await send(deleteReq(lateDeleteSeed));
let deleteTimer;const deletedBeforeRelease=await Promise.race([lateJoined,new Promise(resolve=>{deleteTimer=setTimeout(()=>resolve(null),1000);})]);clearTimeout(deleteTimer);
responseMode='normal';releaseFetch();const [deletedOwnerReply,deletedJoinedReply]=await Promise.all([lateOwner,lateJoined]);
check('single deletion cancels matching shared job before deferred API completes',()=>{assert.equal(lateDeleteResult.ok,true);assert.equal(lateDeleteResult.cacheCount,lateCount-1);assert(deletedBeforeRelease);assert.equal(deletedBeforeRelease.results[0].code,'CANCELLED');assert.equal(deletedBeforeRelease.results[0].shared,true);});
check('late provider response cannot recreate deleted row but preserves unrelated batch write',()=>{assert.equal(deletedOwnerReply.results.find(x=>x.id==='delete-owner').code,'CANCELLED');assert.equal(deletedJoinedReply.results[0].code,'CANCELLED');assert.equal(deletedOwnerReply.results.find(x=>x.id==='keep-owner').text,'공격력이 77% 상승합니다.');assert(!cache.has(lateDeleteSeed.id));assert([...cache.values()].some(x=>x.source===lateKeepSource));assert.equal(cache.size,lateCount);assert.equal(awaitCount(),lateCount);assert.equal(httpCalls,lateHTTP+1);assert.equal(JSON.stringify(memory.usage),lateUsage);assert.equal(JSON.stringify(memory.settings),lateSettings);assert.equal(memory.configRevision,lateRevision);});


// A matching old v0.1 opaque row must not resurrect a deliberately removed source.
const tombSource='旧キャッシュ復活防止',tombContext='Menu';
const tombCanonical=await cm.makeCacheEntry({source:tombSource,target:memory.settings.target,context:tombContext,text:'이전 캐시 부활 방지'});
const tombLegacyId=await core.namespace.hashKey(core.namespace.legacyCacheIdentity(memory.settings,tombSource,tombContext));
const tombLegacy={id:tombLegacyId,text:'이전 캐시 부활 방지',time:1};rawCacheSet(tombCanonical.id,tombCanonical);rawCacheSet(tombLegacyId,tombLegacy);
const tombMeta=databases.get('crave-ai-cache').stores.get('cache-metadata').rows,tombKey='deleted-source:'+tombCanonical.id;
const tombCount=cache.size,tombHTTP=httpCalls,tombUsage=JSON.stringify(memory.usage),tombSettings=JSON.stringify(memory.settings),tombRevision=memory.configRevision;
r=await send({...deleteReq(tombCanonical),expectedText:'stale'});
check('failed single deletion never writes source tombstone',()=>{assert.equal(r.ok,false);assert.equal(r.code,'CONFLICT');assert(!tombMeta.has(tombKey));assert.equal(awaitCount(),tombCount);});
r=await send(deleteReq(tombCanonical));
check('canonical deletion atomically records hashed metadata marker without removing matching opaque row',()=>{assert.equal(r.ok,true);assert.equal(r.cacheCount,tombCount-1);assert.deepEqual(tombMeta.get(tombKey),{id:tombKey,deleted:true});assert.deepEqual(cache.get(tombLegacyId),tombLegacy);assert(!cache.has(tombCanonical.id));assert.equal(awaitCount(),tombCount-1);});
r=await send({type:'CACHE_LOOKUP',items:[{id:'tomb-missing',source:tombSource,context:tombContext}]},game);
check('matching opaque legacy row cannot resurrect deleted canonical through lookup',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].missing,true);assert(!cache.has(tombCanonical.id));assert.deepEqual(cache.get(tombLegacyId),tombLegacy);assert.equal(awaitCount(),tombCount-1);assert.equal(httpCalls,tombHTTP);assert.equal(JSON.stringify(memory.usage),tombUsage);assert.equal(JSON.stringify(memory.settings),tombSettings);assert.equal(memory.configRevision,tombRevision);});
const restartedTomb=await new Promise(resolve=>listeners[1]({type:'CACHE_LOOKUP',items:[{id:'tomb-restarted',source:tombSource,context:tombContext}]},game,resolve));
check('another worker connection honors durable source tombstone',()=>{assert.equal(restartedTomb.results[0].missing,true);assert(!cache.has(tombCanonical.id));assert.deepEqual(cache.get(tombLegacyId),tombLegacy);});
const compatibleSource='削除していない旧原文',compatibleContext='Menu';
const compatibleLegacyId=await core.namespace.hashKey(core.namespace.legacyCacheIdentity(memory.settings,compatibleSource,compatibleContext));
rawCacheSet(compatibleLegacyId,{id:compatibleLegacyId,text:'삭제하지 않은 이전 원문',time:2});const compatibleCount=cache.size;
r=await send({type:'CACHE_LOOKUP',items:[{id:'legacy-compatible',source:compatibleSource,context:compatibleContext}]},game);
check('unrelated legacy sources still promote normally despite deletion tombstones',()=>{assert.equal(r.results[0].text,'삭제하지 않은 이전 원문');assert(!cache.has(compatibleLegacyId));assert([...cache.values()].some(e=>e.source===compatibleSource));assert.deepEqual(cache.get(tombLegacyId),tombLegacy);assert.equal(awaitCount(),compatibleCount);assert.equal(httpCalls,tombHTTP);});
const tombFresh=await send({type:'CACHE_EDIT_SAVE',source:tombSource,target:tombCanonical.target,text:'새 수동 번역',create:true});
r=await send({type:'CACHE_LOOKUP',items:[{id:'tomb-fresh',source:tombSource,context:tombContext}]},game);
check('fresh canonical translation wins over tombstone and old opaque fallback',()=>{assert.equal(tombFresh.ok,true);assert.equal(r.results[0].text,'새 수동 번역');assert.equal(r.results[0].cached,true);assert(tombMeta.has(tombKey));assert.deepEqual(cache.get(tombLegacyId),tombLegacy);assert.equal(awaitCount(),compatibleCount+1);assert.equal(httpCalls,tombHTTP);assert.equal(JSON.stringify(memory.usage),tombUsage);assert.equal(JSON.stringify(memory.settings),tombSettings);assert.equal(memory.configRevision,tombRevision);});

// A committed explicit import invalidates deferred provider writes before they can revive old content.
for(const importRoute of ['legacy','stream']){
 const lateSource=importRoute==='legacy'?'攻撃力が78%上昇する。':'攻撃力が79%上昇する。';
 const lateEntry=await cm.makeCacheEntry({source:lateSource,target:memory.settings.target,text:lateSource});rawCacheSet(lateEntry.id,lateEntry);
 responseMode='deferred';releaseFetch=null;
 const pendingImportReply=send({type:'TRANSLATE',items:[{id:'late-import',source:lateSource}]},{...game,documentId:'late-import-'+importRoute});
 for(let i=0;i<200&&!releaseFetch;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseFetch,'function');
 const fileEntry=await cm.makeCacheEntry({source:lateSource,target:memory.settings.target,text:lateSource.replace('攻撃力が','파일 공격력이 ').replace('上昇する。',' 증가합니다.')});
 let importReply;
 if(importRoute==='legacy')importReply=await send({type:'IMPORT_CACHE',mode:'merge',conflictPolicy:'use-incoming',data:cm.buildExport([fileEntry]).data});
 else{const start=await send({type:'IMPORT_START',mode:'merge',conflictPolicy:'use-incoming'});await send({type:'IMPORT_BATCH',token:start.token,entries:[cm.portableEntry(fileEntry)]});importReply=await send({type:'IMPORT_COMMIT',token:start.token,header:streamStart.header,expectedCount:1});}
 responseMode='normal';releaseFetch();const lateReply=await pendingImportReply;
 check(importRoute+' explicit import prevents deferred auto result from reviving overwritten content',()=>{assert.equal(importReply.ok,true);assert.equal(lateReply.results[0].code,'CANCELLED');assert.equal(cache.get(fileEntry.id).text,fileEntry.text);assert.equal(cache.get(fileEntry.id).manual,undefined);assert.equal(awaitCount(),cache.size);});
}

const policySuite={exports:{}};
// Compile from the configured root too, for restricted runners where require's ancestor realpath is denied.
new Function('module','exports','require',fs.readFileSync(path.join(root,'tests/merge-policy.cjs'),'utf8'))(policySuite,policySuite.exports,require);
tests+=await policySuite.exports({send,cm,cache,rawCacheSet,databases,memory,httpCount:()=>httpCalls,header:streamStart.header,assert});
const offSuite={exports:{}};
new Function('module','exports','require',fs.readFileSync(path.join(root,'tests/cache-off.cjs'),'utf8'))(offSuite,offSuite.exports,require);
tests+=await offSuite.exports({send,cm,cache,rawCacheSet,databases,memory,httpCount:()=>httpCalls,assert,game,admin,setResponseMode:mode=>{responseMode=mode;if(mode==='deferred')releaseFetch=null;},waitDeferred:async()=>{for(let i=0;i<200&&!releaseFetch;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseFetch,'function');},releaseDeferred:()=>releaseFetch(),readCount:()=>translationReads});
await send({type:'SAVE_SETTINGS',settings:{provider:'custom',endpoint:'http://127.0.0.1:1234/v1',model:'mock',enabled:true,consent:true,playerName:'',displayName:'표시 이름',requestTimeoutSeconds:180}});
const nicknameGame={...game,documentId:'nickname-backport'},canonicalName='{USER}攻撃力が61%上昇する。';
httpBefore=httpCalls;
r=await send({type:'TRANSLATE',items:[{id:'name-a',source:'レオン攻撃力が61%上昇する。',templates:[canonicalName]},{id:'name-b',source:'アキラ攻撃力が61%上昇する。',templates:[canonicalName]}]},nicknameGame);
check('one AI request stores a shared nickname template for two current names',()=>{assert.equal(r.results.length,2);assert(r.results.every(row=>row.text==='{USER}공격력이 61% 상승합니다.'&&row.cacheSource===canonicalName));assert.equal(httpCalls,httpBefore+1);assert.equal([...cache.values()].filter(row=>row.source===canonicalName).length,1);assert(![...cache.values()].some(row=>row.source==='レオン攻撃力が61%上昇する。'));});
const sentNameItem=JSON.parse(JSON.parse(seenOptions.body).messages[1].content).items[0];
check('provider input contains only protected name placeholders, not the original nickname',()=>{assert(!JSON.stringify(sentNameItem).includes('レオン'));assert(!JSON.stringify(sentNameItem).includes('アキラ'));});
httpBefore=httpCalls;
r=await send({type:'CACHE_LOOKUP',items:[{id:'name-c',source:'タロウ攻撃力が61%上昇する。',templates:[canonicalName]}]},nicknameGame);
check('a different player reuses the stored shared template without AI',()=>{assert.equal(r.results[0].text,'{USER}공격력이 61% 상승합니다.');assert.equal(r.results[0].cacheSource,canonicalName);assert.equal(httpCalls,httpBefore);});
const literalName=await cm.makeCacheEntry({source:'アキラ攻撃力が61%上昇する。',target:'한국어',text:'아키라 전용 61% 번역',manual:true});rawCacheSet(literalName.id,literalName);
r=await send({type:'TRANSLATE',items:[{id:'name-exact',source:literalName.source,templates:[canonicalName]}]},nicknameGame);
check('an exact literal cache still wins over a shared name template',()=>{assert.equal(r.results[0].text,literalName.text);assert.equal(r.results[0].cacheSource,literalName.source);assert.equal(httpCalls,httpBefore);});
const awaitNameId=await cm.cacheId('한국어',canonicalName);
await send({type:'SET_CACHE_ENABLED',cacheEnabled:false});httpBefore=httpCalls;
r=await send({type:'TRANSLATE',items:[{id:'name-off',source:literalName.source,templates:[canonicalName]}]},nicknameGame);
check('cache Off replaces the old literal override with the new canonical AI result',()=>{assert.equal(httpCalls,httpBefore+1);assert.equal(r.results[0].text,'{USER}공격력이 61% 상승합니다.');assert(!cache.has(literalName.id));assert.equal(cache.get(awaitNameId).manual,undefined);});
await send({type:'SET_CACHE_ENABLED',cacheEnabled:true});httpBefore=httpCalls;
r=await send({type:'CACHE_LOOKUP',items:[{id:'name-on-again',source:literalName.source,templates:[canonicalName]}]},nicknameGame);
check('returning to cache On uses the newly generated shared result, not the removed override',()=>{assert.equal(r.results[0].cacheSource,canonicalName);assert.equal(r.results[0].text,'{USER}공격력이 61% 상승합니다.');assert.equal(httpCalls,httpBefore);});
const identityId=await cm.cacheId('한국어','{USER}'),identityUsage=JSON.stringify(memory.usage);
assert(!cache.has(identityId));
const identityLimits={requests:memory.settings.dailyRequestLimit,chars:memory.settings.dailyCharLimit};
memory.settings.dailyRequestLimit=1;memory.settings.dailyCharLimit=1;
r=await send({type:'TRANSLATE',items:[{id:'name-alone',source:'한글이름',templates:['{USER}']}]},nicknameGame);
check('absent standalone USER is durable before settling even with exhausted provider quota',()=>{assert.equal(r.results[0].text,'{USER}');assert.equal(r.results[0].cacheSource,'{USER}');assert.equal(r.results[0].cacheSaved,true);assert.equal(r.cacheSaved,true);assert.equal(cache.get(identityId).text,'{USER}');assert.equal(httpCalls,httpBefore);assert.equal(JSON.stringify(memory.usage),identityUsage);});
memory.settings.dailyRequestLimit=identityLimits.requests;memory.settings.dailyCharLimit=identityLimits.chars;
const recordingStore=modules.get('./distribution-store.mjs').namespace.createDistributionStore();
const identityOwner={tabId:game.tab.id,frameId:game.frameId};
const identitySession=await recordingStore.start({owner:identityOwner,target:'한국어',fileName:'synthetic-identity.ndjson'});
const identityCapture=await send({type:'DISTRIBUTION_CAPTURE',id:identitySession.id,items:[{source:r.results[0].cacheSource,text:r.results[0].text,target:'한국어'}]},nicknameGame);
check('real recorder broker accepts newly generated USER against durable canonical cache',()=>{assert.equal(identityCapture.ok,true);assert.equal(identityCapture.accepted,1);assert.equal(identityCapture.skipped,0);assert.equal(identityCapture.session.count,1);assert(!identityCapture.session.errorCode);assert.equal(httpCalls,httpBefore);assert.equal(JSON.stringify(memory.usage),identityUsage);});
await recordingStore.finish(identityOwner,identitySession.id);
const identityRecording=await recordingStore.exportPage({id:identitySession.id});
check('recorded USER exports the validated canonical identity rather than the literal player name',()=>{assert.equal(identityRecording.entries.length,1);assert.equal(identityRecording.entries[0].source,'{USER}');assert.equal(identityRecording.entries[0].text,'{USER}');assert.equal(identityRecording.entries[0].id,identityId);});
await recordingStore.discard(identityOwner,identitySession.id);
const identityLiteral=await cm.makeCacheEntry({source:'한글이름',target:'한국어',text:'개인 이름',manual:true});rawCacheSet(identityLiteral.id,identityLiteral);
r=await send({type:'TRANSLATE',items:[{id:'identity-literal',source:'한글이름',templates:['{USER}']}]},nicknameGame);
check('standalone name still prefers its exact manual literal in cache On',()=>{assert.equal(r.results[0].text,identityLiteral.text);assert.equal(r.results[0].cacheSource,identityLiteral.source);});
await send({type:'SET_CACHE_ENABLED',cacheEnabled:false});
r=await send({type:'TRANSLATE',items:[{id:'identity-off',source:'한글이름',templates:['{USER}']}]},nicknameGame);
check('cache Off durably replaces standalone literal with canonical identity without charging usage',()=>{assert.equal(r.results[0].text,'{USER}');assert.equal(r.results[0].cacheSaved,true);assert(!cache.has(identityLiteral.id));assert.equal(cache.get(identityId).text,'{USER}');assert.equal(httpCalls,httpBefore);assert.equal(JSON.stringify(memory.usage),identityUsage);});
await send({type:'SET_CACHE_ENABLED',cacheEnabled:true});
const identityRestart=await new Promise(resolve=>listeners[1]({type:'TRANSLATE',items:[{id:'identity-restart',source:'한글이름',templates:['{USER}']}]},{...nicknameGame,documentId:'identity-restart'},resolve));
check('returning On and another worker reuse the durable canonical identity',()=>{assert.equal(identityRestart.results[0].cached,true);assert.equal(identityRestart.results[0].cacheSource,'{USER}');assert.equal(identityRestart.results[0].text,'{USER}');assert.equal(httpCalls,httpBefore);assert.equal(JSON.stringify(memory.usage),identityUsage);});
await send({type:'SET_CACHE_ENABLED',cacheEnabled:false});
const validationGame={...game,documentId:'recorder-portable-validation'};
for(const [name,source,invalidOutput] of [
  ['added line ending','攻撃力が71%上昇する。',text=>text+'\n'],
  ['changed numeric sign','攻撃力が72%上昇する。',text=>text.replace('공격력이 ','공격력이 -')],
  ['merged protected numbers','攻撃力が73と74上昇する。',text=>text.replace('と','')]
]){
  const previous=await cm.makeCacheEntry({source,target:'한국어',text:source.replace('攻撃力が','공격력이 ').replace('上昇する。',' 이전 상승합니다.'),manual:true});
  rawCacheSet(previous.id,previous);const snapshot=JSON.stringify(cache.get(previous.id));
  transformProviderText=item=>invalidOutput(item.text.replace('攻撃力が','공격력이 ').replace('上昇する。',' 상승합니다.'));
  try{r=await send({type:'TRANSLATE',items:[{id:'invalid-portable',source}]},validationGame);}finally{transformProviderText=null;}
  check('Off rejects '+name+' before display or durable replacement',()=>{assert.equal(r.ok,true);assert.equal(r.results[0].code,'VALIDATION');assert.equal(r.results[0].retryable,true);assert.equal(r.results[0].text,undefined);assert.equal(JSON.stringify(cache.get(previous.id)),snapshot);});
  r=await send({type:'TRANSLATE',items:[{id:'valid-portable',source}]},validationGame);
  const generated=r.results[0],session=await recordingStore.start({owner:identityOwner,target:'한국어',fileName:'synthetic-protected.ndjson'});
  const capture=await send({type:'DISTRIBUTION_CAPTURE',id:session.id,items:[{source:generated.cacheSource,text:generated.text,target:'한국어'}]},validationGame);
  check('valid retry after '+name+' is durable and accepted by strict recorder',()=>{assert.equal(generated.cacheSaved,true);assert.equal(cache.get(previous.id).text,generated.text);assert.equal(capture.ok,true);assert.equal(capture.accepted,1);assert.equal(capture.skipped,0);assert.equal(capture.session.errorCode,undefined);});
  await recordingStore.discard(identityOwner,session.id);
}
const changingGame={...game,documentId:'recorder-changing-output'},changingSource='{USER}<b>攻撃力が75%</b>\n上昇する。';
const changingRequest=(id,name)=>({type:'TRANSLATE',items:[{id,source:changingSource.replace('{USER}',name),templates:[changingSource],context:'AdvText'}]});
let wording=' 상승합니다.';
transformProviderText=item=>item.text.replace('攻撃力が','공격력이 ').replace('上昇する。',wording);
responseMode='deferred';releaseFetch=null;httpBefore=httpCalls;
const changingOwner=send(changingRequest('changing-owner','レオン'),changingGame);
for(let i=0;i<200&&!releaseFetch;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseFetch,'function');
const changingJoin=send(changingRequest('changing-join','アキラ'),changingGame);
await new Promise(resolve=>setTimeout(resolve,50));responseMode='normal';releaseFetch();
const changingFirst=await changingOwner,changingJoined=await changingJoin,firstTranslation=changingFirst.results[0];
check('overlapping Off literal labels share one durable protected canonical result',()=>{assert.equal(httpCalls,httpBefore+1);assert.equal(changingJoined.results[0].shared,true);assert.equal(changingJoined.results[0].text,firstTranslation.text);assert.equal(firstTranslation.cacheSource,changingSource);assert.equal(firstTranslation.cacheSaved,true);});
const changingSession=await recordingStore.start({owner:identityOwner,target:'한국어',fileName:'synthetic-changing.ndjson'});
const changingCapture=value=>send({type:'DISTRIBUTION_CAPTURE',id:changingSession.id,items:[{source:value.cacheSource,text:value.text,target:'한국어'}]},changingGame);
const firstCapture=await changingCapture(firstTranslation);
wording=' 증가합니다.';
let changingSecond;
try{changingSecond=await send(changingRequest('changing-repeat','タロウ'),changingGame);}finally{transformProviderText=null;}
const secondTranslation=changingSecond.results[0],secondCapture=await changingCapture(secondTranslation);
check('repeated Off canonical source accepts varying valid AI and records its newly durable text',()=>{assert.equal(httpCalls,httpBefore+2);assert.notEqual(secondTranslation.text,firstTranslation.text);assert.equal(secondTranslation.cacheSaved,true);assert.equal(firstCapture.accepted,1);assert.equal(secondCapture.accepted,1);assert.equal(secondCapture.skipped,0);assert.equal(secondCapture.session.count,1);assert.equal(secondCapture.session.errorCode,undefined);});
const staleCapture=await changingCapture(firstTranslation);
check('late old display cannot silently replace a newer durable canonical translation',()=>{assert.equal(staleCapture.accepted,0);assert.equal(staleCapture.skipped,1);assert.equal(staleCapture.skipReasons.TEXT_CHANGED,1);assert.equal(staleCapture.session.errorCode,'TEXT_CHANGED');assert.equal(staleCapture.session.warning,'PARTIAL_RECORDING');});
await recordingStore.finish(identityOwner,changingSession.id);
const changingExport=await recordingStore.exportPage({id:changingSession.id});
check('a rejected late capture preserves the most recently recorded protected wording',()=>{assert.equal(changingExport.entries.length,1);assert.equal(changingExport.entries[0].text,secondTranslation.text);});
await recordingStore.discard(identityOwner,changingSession.id);
const beforeResetSettings=JSON.stringify(memory.settings),beforeResetSize=cache.size;
for(const confirmed of [undefined,false,'true']){r=await send({type:'CLEAR_CACHE',...(confirmed===undefined?{}:{confirmed})});assert.equal(r.ok,false);}
r=await send({type:'CLEAR_CACHE',confirmed:true},nicknameGame);
check('reset requires explicit trusted confirmation and leaves data untouched otherwise',()=>{assert.equal(r.ok,false);assert.equal(cache.size,beforeResetSize);assert.equal(JSON.stringify(memory.settings),beforeResetSettings);});
responseMode='deferred';releaseFetch=null;
const beforeResetPending=send({type:'TRANSLATE',items:[{id:'name-before-reset',source:'攻撃力が62%上昇する。'},{id:'identity-before-reset',source:'새이름',templates:['{USER}']}]},nicknameGame);
for(let i=0;i<200&&!releaseFetch;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseFetch,'function');
const usageAtReset=JSON.stringify(memory.usage);
r=await send({type:'CLEAR_CACHE',confirmed:true});responseMode='normal';releaseFetch();const afterResetPending=await beforeResetPending;
check('reset preserves settings and usage while stale AI and identity cannot refill the cleared cache',()=>{assert.equal(r.ok,true);assert.equal(r.cacheCount,0);assert.equal(cache.size,0);assert.equal(JSON.stringify(memory.settings),beforeResetSettings);assert.equal(JSON.stringify(memory.usage),usageAtReset);assert(afterResetPending.results.every(row=>row.code==='CANCELLED'));});
console.log(`\n${tests} worker integration tests passed with fake HTTP only.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
