'use strict';
// Offline mocks only. No native picker, account, inference or user cache.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..');
const context=vm.createContext({console,TextEncoder,TextDecoder,URLSearchParams,crypto:require('node:crypto').webcrypto});
const modules=new Map();
function load(spec,ref){const name=ref?path.posix.join(path.posix.dirname(ref.identifier),spec):spec;if(modules.has(name))return modules.get(name);const m=new vm.SourceTextModule(fs.readFileSync(path.join(root,name),'utf8'),{context,identifier:name});modules.set(name,m);return m;}
const ui=load('distribution-ui.mjs');await ui.link(load);await ui.evaluate();
const create=ui.namespace.createDistributionUI,createFiles=modules.get('distribution-files.mjs').namespace.createDistributionFileStore,cache=modules.get('cache.mjs').namespace;
const intent='12345678-1234-4234-8234-123456789abc',selectionId='12345678-1234-4234-8234-123456789abd';
const row={...cache.portableEntry(await cache.makeCacheEntry({source:'星の勇者',text:'별의 용사',target:'한국어',context:'synthetic',createdAt:1,updatedAt:2})),manual:false};
const session={id:'dist:'+intent,status:'ready',count:1,fileName:'<img src=x onerror=alert(1)>.ndjson',selectionId,target:'한국어',startedAt:1};
function fixture(options={}){
 const nodes=new Map(),calls=[],events=[],writes=[],storage=new Map(),deleted=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,dataset:{},addEventListener(type,fn){this[type]=fn;}});return nodes.get(id)};
 const writer={async write(s){events.push('write');if(options.writeError)throw Object.assign(Error('disk'),{name:options.writeError});writes.push(s)},async close(){events.push('close');if(options.closeError)throw Error('close')},async abort(){events.push('abort')}};
 const handle={kind:'file',name:session.fileName,async queryPermission(){events.push('query');return options.permission||'granted'},requestPermission(){events.push('request');return Promise.resolve(options.denied?'denied':'granted')},async createWritable(o){events.push('create');assert.equal(o.keepExistingData,false);return writer}};
 if(!options.missing)storage.set(selectionId,handle);
 const files={async put(h){events.push('put');if(options.quota)throw Object.assign(Error('quota'),{name:'QuotaExceededError'});storage.set(selectionId,h);return selectionId},async get(id){events.push('get');return storage.get(id)},async delete(id){events.push('delete');deleted.push(id);storage.delete(id)}};
 const win={location:{search:'?intent='+intent},showSaveFilePicker(o){assert.equal(o.types[0].accept['application/x-ndjson'][0],'.ndjson');events.push('picker');return options.cancel?Promise.reject(Object.assign(Error('cancel'),{name:'AbortError'})):Promise.resolve(handle)}};if(options.unsupported)delete win.showSaveFilePicker;
 const runtime={async sendMessage(m){events.push(m.type);calls.push(m);if(options.reply)return options.reply(m);switch(m.type){
 case 'DISTRIBUTION_WINDOW_GET':return {ok:true,action:options.start?'start':'finish',session};
 case 'DISTRIBUTION_FREEZE':return {ok:true,status:'ready',session:{...session,...options.session},count:options.session?.count??1};
 case 'DISTRIBUTION_START':return options.startFailed?{ok:false}:{ok:true,session:{...session,status:'recording'}};
 case 'DISTRIBUTION_RESELECT':return {ok:true,session};
 case 'DISTRIBUTION_PAGE':return {ok:true,entries:options.entries||[row],done:true,cursor:null};
 case 'DISTRIBUTION_SAVED':return {ok:!options.ackFailed};
 default:throw Error('Unexpected message '+m.type);
 }}};
 const app=create({win,doc:{getElementById:node},runtime,files});
 return {app,node,events,calls,writes,deleted,storage,options,handle,click(trusted=true){return node('primary').click({isTrusted:trusted})}};
}
let tests=0;async function test(name,fn){await fn();console.log('PASS distribution UI: '+name);tests++;}
await test('Start picker synchronous trusted-only; zero writes; handles never sent',async()=>{
 const f=fixture({start:true});await f.app.initialize();await f.click(false);assert(!f.events.includes('picker'));const p=f.click();assert.equal(f.events.at(-1),'picker');await p;
 assert(!f.events.includes('create'));assert(f.node('status').textContent.includes('창을 닫아도'));assert.equal(f.node('fileName').textContent,session.fileName);
 const m=f.calls.at(-1);assert.deepEqual(Object.keys(m).sort(),['fileName','intent','selectionId','type']);assert.equal(m.selectionId,selectionId);assert.equal(m.type,'DISTRIBUTION_START');assert(!JSON.stringify(f.calls).includes('createWritable'));
});
await test('failed Start cleans selection; cancellation and quota retry safely',async()=>{
 for(const opts of [{startFailed:true},{cancel:true},{quota:true}]){const f=fixture({start:true,...opts});await f.app.initialize();await f.click();assert(!f.events.includes('write'));assert.equal(f.node('primary').disabled,false);if(opts.startFailed)assert.deepEqual(f.deleted,[selectionId]);if(opts.cancel){assert.equal(f.calls.length,1);assert(f.node('status').textContent.includes('취소'));}if(opts.quota)assert(f.node('status').textContent.includes('공간'));}
});
await test('no picker support never downloads or starts',async()=>{const f=fixture({start:true,unsupported:true});await f.app.initialize();assert(f.node('primary').disabled);assert(f.node('status').textContent.includes('지원하지'));assert.equal(f.calls.length,1)});
await test('Finish freezes before handle; granted autosave; NDJSON preserves metadata; close before ack',async()=>{
 const f=fixture();await f.app.initialize();assert(f.events.indexOf('DISTRIBUTION_FREEZE')<f.events.indexOf('get'));assert(f.events.indexOf('close')<f.events.indexOf('DISTRIBUTION_SAVED'));assert(!f.events.includes('request'));
 const lines=f.writes.join('').trim().split('\n').map(JSON.parse);assert.equal(lines[0].identity,'source-v3');assert.equal(lines[0].appVersion,'0.3.5');assert.deepEqual(lines[1],row);assert.deepEqual(lines[2],{end:true,count:1});assert.deepEqual(f.deleted,[selectionId]);assert.equal(f.node('primary').textContent,'저장 완료');
});
await test('permission request synchronous trusted-only; denial preserves ready',async()=>{
 const f=fixture({permission:'prompt',denied:true});await f.app.initialize();assert(!f.events.includes('create'));await f.click(false);assert(!f.events.includes('request'));const p=f.click();assert.equal(f.events.at(-1),'request');await p;assert(!f.events.includes('create'));assert.equal(f.deleted.length,0);assert(f.node('status').textContent.includes('보존'));
 f.options.denied=false;await f.click();assert(f.events.includes('close'));
});
await test('missing handle repicks explicitly, reselect before writer',async()=>{const f=fixture({missing:true});await f.app.initialize();assert(!f.events.includes('picker'));const p=f.click();assert.equal(f.events.at(-1),'picker');await p;assert(f.events.indexOf('DISTRIBUTION_RESELECT')<f.events.indexOf('create'));assert.equal(f.calls.find(x=>x.type==='DISTRIBUTION_RESELECT').id,session.id)});
await test('write/close/schema/hash/count/duplicate/page limits abort and never ack/delete',async()=>{
 for(const opts of [{writeError:'QuotaExceededError'},{closeError:true},{entries:[{...row,apiKey:'not_allowed'}]},{entries:[{...row,id:'v3:'+'0'.repeat(64)}]},{session:{count:2}},{entries:[row,row]},{entries:Array(251).fill(row)}]){const f=fixture(opts);await f.app.initialize();assert(f.events.includes('abort'));assert(!f.events.includes('DISTRIBUTION_SAVED'));assert.equal(f.deleted.length,0);assert.equal(f.node('primary').disabled,false);}
});
await test('ack failure warns file exists; ack retry without rewrite',async()=>{const f=fixture({ackFailed:true});await f.app.initialize();assert(f.node('status').textContent.includes('파일이 이미'));assert.equal(f.deleted.length,0);assert.equal(f.events.filter(x=>x==='create').length,1);f.options.ackFailed=false;await f.click();assert.equal(f.events.filter(x=>x==='create').length,1);assert.deepEqual(f.deleted,[selectionId]);assert.equal(f.node('primary').textContent,'저장 완료')});
await test('multiple pages preserve order and metadata; exact opaque cursor',async()=>{
 const second={...cache.portableEntry(await cache.makeCacheEntry({source:'月の勇者',text:'달의 용사',target:'한국어',context:'two',createdAt:5,updatedAt:7})),manual:true};let n=0;
 const f=fixture({reply:m=>{if(m.type==='DISTRIBUTION_WINDOW_GET')return {ok:true,action:'finish',session};if(m.type==='DISTRIBUTION_FREEZE')return {ok:true,status:'ready',session:{...session,count:2}};if(m.type==='DISTRIBUTION_PAGE'){n++;assert.equal(m.cursor,n===1?null:'opaque');return {ok:true,entries:[n===1?row:second],cursor:n===1?'opaque':null,done:n===2};}if(m.type==='DISTRIBUTION_SAVED')return {ok:true};throw Error(m.type)}});await f.app.initialize();assert.deepEqual(f.writes.slice(1,3).map(JSON.parse),[row,second]);assert.equal(n,2);
});
await test('1MiB page byte cap aborts before any entry write',async()=>{
 const entries=[];for(let i=0;i<16;i++)entries.push(cache.portableEntry(await cache.makeCacheEntry({source:'勇'.repeat(8191)+String.fromCodePoint(0x4e00+i),text:'용'.repeat(24000),target:'한국어',createdAt:1,updatedAt:2})));
 const f=fixture({entries,session:{count:16}});await f.app.initialize();assert(f.events.includes('abort'));assert.equal(f.writes.length,1);assert(!f.events.includes('DISTRIBUTION_SAVED'));assert.equal(f.deleted.length,0);
});
await test('empty frozen session writes header/footer and acknowledges only after close',async()=>{const f=fixture({entries:[],session:{count:0}});await f.app.initialize();assert.equal(f.writes.length,2);assert.deepEqual(JSON.parse(f.writes[1]),{end:true,count:0});assert(f.events.indexOf('close')<f.events.indexOf('DISTRIBUTION_SAVED'))});
await test('non-progress page cursor aborts bounded stream',async()=>{let n=0;const f=fixture({reply:m=>{if(m.type==='DISTRIBUTION_WINDOW_GET')return {ok:true,action:'finish',session};if(m.type==='DISTRIBUTION_FREEZE')return {ok:true,status:'ready',session:{...session,count:2}};if(m.type==='DISTRIBUTION_PAGE')return {ok:true,entries:++n===1?[row]:[],cursor:'again',done:false};throw Error(m.type)}});await f.app.initialize();assert.equal(n,2);assert(f.events.includes('abort'));assert(!f.events.includes('DISTRIBUTION_SAVED'))});
await test('partial recording requires a separate trusted approval before native file writes',async()=>{const f=fixture({session:{errorCode:'STORAGE'}});await f.app.initialize();assert(!f.events.includes('create'));assert.equal(f.node('primary').textContent,'수집된 항목만 Finish');await f.click(false);assert(!f.events.includes('create'));await f.click();assert(f.events.includes('close'));assert(f.events.includes('DISTRIBUTION_SAVED'));});
await test('private IDB survives instances and deletes only selected reference',async()=>{
 const databases=new Map();const idb={open(name){const request={};queueMicrotask(()=>{let db=databases.get(name);if(!db){const rows=new Map();db={rows,createObjectStore(n){assert.equal(n,'handles')},close(){},transaction(n){assert.equal(n,'handles');const tx={objectStore(){const req=fn=>{const r={};queueMicrotask(()=>{try{r.result=fn();r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());}catch(e){tx.error=e;tx.onabort?.()}});return r};return {put:(v,k)=>req(()=>{rows.set(k,v);return k}),get:k=>req(()=>rows.get(k)),delete:k=>req(()=>rows.delete(k))}}};return tx}};databases.set(name,db);request.result=db;request.onupgradeneeded?.();}request.result=db;request.onsuccess?.()});return request}};
 const handle={kind:'file',name:'synthetic.ndjson',createWritable(){throw Error('not called')}};let i=0;const store=createFiles(idb,()=>i++===0?selectionId:intent);assert.equal(await store.put(handle),selectionId);await store.put(handle);await store.close();const again=createFiles(idb);assert.equal(await again.get(selectionId),handle);await again.delete(selectionId);assert.equal(await again.get(selectionId),undefined);assert.equal(await again.get(intent),handle);assert.deepEqual([...databases.keys()],['crave-ai-distribution-files']);await again.close();
});
await test('CSP-compatible accessible private UI, no cache writes',async()=>{
 const html=fs.readFileSync(path.join(root,'distribution.html'),'utf8'),source=fs.readFileSync(path.join(root,'distribution-ui.mjs'),'utf8');assert(html.includes('role="status"'));assert(html.includes('사용자 이름'));assert(html.includes('src="distribution-ui.mjs"'));assert(!/<script[^>]*>\s*[^<\s]/.test(html));assert(!/innerHTML|chrome\.storage|fetch\(|createObjectURL|downloads\.|owner:|tabId:|CACHE_(PUT|IMPORT|CLEAR)/.test(source));
});
console.log('Distribution UI: '+tests+' synthetic tests passed. No native picker, account, inference or personal cache used.');
})().catch(e=>{console.error(e);process.exitCode=1});
