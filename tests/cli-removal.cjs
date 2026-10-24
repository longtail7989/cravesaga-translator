/* Offline legacy removal regression: isolated VM memory only. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..');
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const C=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'core.mjs')).toString('base64'));
const memory={},writes=[],listeners=[],installed=[];let networkCalls=0,nativeCalls=0,permissions=0;
const clone=v=>v===undefined?undefined:structuredClone(v);
const chrome={storage:{local:{setAccessLevel:async()=>{},get:async k=>({[k]:clone(memory[k])}),set:async v=>{writes.push(clone(v));Object.assign(memory,clone(v));}}},permissions:{contains:async()=>{permissions++;return true;}},tabs:{query:async()=>[],sendMessage:async()=>{}},runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:l=>listeners.push(l)},onInstalled:{addListener:l=>installed.push(l)}}};
const context=vm.createContext({chrome,crypto:require('node:crypto').webcrypto,URL,TextEncoder,TextDecoder,Uint8Array,setTimeout,clearTimeout,console});
const mocks={
 './cache-store.mjs':{createCacheStore:()=>({count:async()=>0,lookup:async()=>null,warm:async()=>({entries:[],remaining:0,bytes:0})})},
 './cache-transfer.mjs':{createCacheTransfer:()=>({cleanup:async()=>{}})},
 './cache-editor.mjs':{createCacheEditor:()=>({})},
 './distribution-broker.mjs':{createDistributionBroker:()=>({}),distributionErrorResponse:()=>({ok:false})},
 './network-client.mjs':{createNetworkClient:()=>({cancelAll:async()=>{},jsonFetch:async()=>{networkCalls++;throw Error('Unexpected network');}})},
 './chatgpt-client.mjs':{createChatGPTClient:()=>({cancelAll:async()=>{},status:async()=>{nativeCalls++;return {available:true,connected:true,planEnabled:true};},translate:async()=>{nativeCalls++;throw Error('Unexpected native');},models:async()=>{nativeCalls++;return [];}})}
};
const modules=new Map();function load(spec){if(modules.has(spec))return modules.get(spec);const mock=mocks[spec];const m=mock?new vm.SyntheticModule(Object.keys(mock),function(){for(const [k,v]of Object.entries(mock))this.setExport(k,v);},{context,identifier:spec}):new vm.SourceTextModule(fs.readFileSync(path.join(root,spec),'utf8'),{context,identifier:spec});modules.set(spec,m);return m;}
const bg=load('./background.mjs');await bg.link(load);await bg.evaluate();
const admin={id:'test',url:'chrome-extension://test/popup.html'},game={id:'test',url:'https://gg-client-r.crave-saga.net/client/1.1.122/index_dmm.html',tab:{id:1},frameId:8,documentId:'removed'};
const send=(m,s=admin)=>new Promise(resolve=>listeners[0](m,s,resolve));
for(const provider of ['codex','claude-code']){
 const stored={...C.DEFAULTS,provider,endpoint:'http://127.0.0.1:17864',model:'old-cli',apiKey:'REMOVED_API_SECRET',bridgeToken:'REMOVED_TOKEN_SECRET',enabled:true,consent:true,cacheOnly:true};memory.settings=stored;const before=JSON.stringify(memory),w=writes.length,p=permissions;
 await check(provider+' upgrade and read are paused, nonconsented and storage-preserving',async()=>{await installed[0]({reason:'update'});const r=await send({type:'GET_SETTINGS'});assert.equal(r.ok,true);assert.equal(r.settings.provider,'removed');assert.equal(r.settings.migrationRequired,'cli-provider-removed');assert.equal(r.settings.enabled,false);assert.equal(r.settings.consent,false);assert.equal(r.settings.cacheOnly,false);assert.equal(r.settings.apiKey,'');assert.equal(r.settings.model,'');assert(!('bridgeToken' in r.settings));assert(!JSON.stringify(r).includes('SECRET'));assert.equal(JSON.stringify(memory),before);assert.equal(writes.length,w);});
 await check(provider+' public config signals migration without legacy secrets',async()=>{const r=await send({type:'PUBLIC_CONFIG'},game);assert.equal(r.config.migrationRequired,'cli-provider-removed');assert.equal(r.config.configured,false);assert.equal(r.config.enabled,false);assert(!JSON.stringify(r).includes('SECRET'));assert(!('endpoint' in r.config));});
 await check(provider+' cannot translate, test, list models or re-enable through old settings',async()=>{for(const [m,s]of [[{type:'TRANSLATE',items:[{id:'x',source:'攻撃'}]},game],[{type:'TEST',settings:stored},admin],[{type:'LIST_MODELS',settings:stored},admin],[{type:'SET_ENABLED',enabled:true},admin]]){const r=await send(m,s);assert.equal(r.ok,false);assert(!JSON.stringify(r).includes('SECRET'));}assert.equal(networkCalls,0);assert.equal(nativeCalls,0);assert.equal(permissions,p);assert.equal(writes.length,w);assert.equal(JSON.stringify(memory),before);});
 await check(provider+' readiness and API builder reject raw legacy provider even cache-only',async()=>{assert.equal(C.isConfigured(stored),false);assert.throws(()=>C.providerRequest(stored,{system:'test',user:'test'}));const sanitized=C.sanitizeSettings(stored);assert.deepEqual(C.sanitizeSettings(sanitized),sanitized);});
}
for(const provider of ['openai','gemini','anthropic','custom','chatgpt']){
 await check(provider+' saved settings stay unchanged on update/read and explicit save strips removed/unknown tokens',async()=>{memory.settings={...C.DEFAULTS,provider,model:'test-model',apiKey:provider==='chatgpt'?'':'SUPPORTED_KEY',enabled:false,consent:true,endpoint:provider==='custom'?'http://localhost:1234/v1':C.DEFAULTS.endpoint};const before=JSON.stringify(memory),w=writes.length;await installed[0]({reason:'update'});const read=await send({type:'GET_SETTINGS'});assert.equal(read.settings.provider,provider);assert(!read.settings.migrationRequired);assert.equal(JSON.stringify(memory),before);assert.equal(writes.length,w);const r=await send({type:'SAVE_SETTINGS',settings:{...memory.settings,bridgeToken:'REMOVED_TOKEN_SECRET',accessToken:'UNKNOWN_TOKEN_SECRET',refreshToken:'UNKNOWN_TOKEN_SECRET'}});assert.equal(r.ok,true);assert(!JSON.stringify(r).includes('SECRET'));assert(!('bridgeToken' in memory.settings));assert(!('accessToken' in memory.settings));assert(!('refreshToken' in memory.settings));});
}
await check('backend export and transport omit removed CLI implementation',async()=>{assert.equal('isSubscriptionProvider' in C,false);assert.equal('bridgeToken' in C.DEFAULTS,false);for(const f of ['background.mjs','network-worker.js','network-client.mjs'])assert(!/subscriptionCall|bridgeHealth|bridgeToken|method === 'DELETE'/.test(fs.readFileSync(path.join(root,f),'utf8')));});
console.log(passed+' removal fail-safe tests passed; HTTP='+networkCalls+' native='+nativeCalls+'.');
})().catch(e=>{console.error(e);process.exitCode=1;});
