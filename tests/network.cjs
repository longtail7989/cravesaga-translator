'use strict';
// Run: node tests/network.cjs. Pure VM mocks, no browser/provider requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const root = path.resolve(process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..'));
const source = name => fs.readFileSync(path.join(root,name),'utf8');
let tests = 0;
async function test(name,fn) { await fn(); tests++; console.log('ok - ' + name); }
const flush = () => new Promise(r => setImmediate(r));
function workerHarness(fetchImpl = async () => new Response('{"ok":true}')) {
  let now = 1000000, count = 0;
  const timers = new Map(), output = [];
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({URL,TextEncoder,TextDecoder,Uint8Array,AbortController,Date:Clock,
    fetch:fetchImpl,self:{postMessage:m => output.push(m)},
    setTimeout:(fn,ms) => {const id = ++count; timers.set(id,{fn,ms}); return id;},
    clearTimeout:id => timers.delete(id),setInterval:() => 0});
  vm.runInContext(source('network-worker.js'),context);
  function send(type,id = 'a'.repeat(32),request) {
    context.self.onmessage({data:{requestId:String(++count),type,jobId:id,request}});
    return output.pop().result;
  }
  const request = extra => ({url:'https://example.invalid/v1/models?key=fake',method:'GET',headers:{},timeoutMs:30000,deadlineAt:now+30000,...extra});
  return {send,request,timers,advance:ms => {now += ms;},deadline:() => {for(const {fn} of [...timers.values()]) fn();}};
}
function clientHarness(chromeApi) {
  const context = vm.createContext({URL,Headers,TextEncoder,AbortController,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,Date});
  vm.runInContext(source('network-client.mjs').replace('export function createNetworkClient','function createNetworkClient')+'\nglobalThis.makeClient = createNetworkClient;',context);
  return context.makeClient(chromeApi);
}
function bridge(worker) {
  let exists = false, creations = 0;
  const messages = [];
  return {messages,get creations(){return creations;},offscreen:{
    hasDocument:async () => exists,
    createDocument:async params => {assert.equal(params.reasons[0],'WORKERS'); creations++; await flush(); exists = true;}
  },runtime:{sendMessage:async m => {messages.push(m);assert.equal(m.target,'network-offscreen');return worker.send(m.type,m.jobId,m.request);}}};
}
(async () => {
  await test('worker preserves JSON and forces fetch safety flags',async () => {
    let options;
    const h = workerHarness(async (url,o) => {options=o; assert.match(url,/\?key=fake/); return new Response('{"answer":[1,true,null]}');});
    assert.equal(h.send('NET_START',undefined,h.request({method:'POST',headers:{Authorization:'Bearer test-only'},body:'{"text":"mock"}'})).status,'pending');
    await flush();
    const r = h.send('NET_POLL'); assert.equal(r.status,'done'); assert.equal(r.data.answer[0],1);
    assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error'); assert.equal(options.headers.authorization,'Bearer test-only'); assert.equal(options.cache,'no-store');
  });
  await test('rejects unsafe URLs, methods, headers and oversized input',async () => {
    let calls=0; const h=workerHarness(async () => {calls++; return new Response('{}');});
    const invalid = [{url:'https://example.invalid/#secret'},{url:'https://u:p@example.invalid/'},{url:'http://example.invalid/'},{url:'file:///etc/passwd'},{method:'DELETE'},{headers:{Cookie:'x'}},{headers:{'X-API-Key':'x\r\ny'}},{method:'POST',body:'not-json'},{method:'POST',body:JSON.stringify('x'.repeat(1024*1024))},{timeoutMs:Infinity}];
    for(const extra of invalid) assert.equal(h.send('NET_START',undefined,h.request(extra)).error.code,'INVALID_REQUEST');
    assert.equal(calls,0);
    for(const host of ['localhost','127.0.0.1','[::1]']) {const id = (calls+1).toString(16).padStart(32,'0'); assert.equal(h.send('NET_START',id,h.request({url:'http://'+host+':3000/health'})).status,'pending');}
  });
  await test('deadline and cancellation abort fetch signals',async () => {
    let signal; const h=workerHarness(async (_url,o) => {signal=o.signal; return new Promise((_r,reject) => signal.addEventListener('abort',() => reject(new Error('secret-do-not-echo'))));});
    h.send('NET_START',undefined,h.request()); h.deadline(); await flush();
    assert.equal(signal.aborted,true); assert.equal(h.send('NET_POLL').error.code,'TIMEOUT');
    const id='b'.repeat(32); h.send('NET_START',id,h.request()); h.send('NET_CANCEL_ALL'); await flush(); assert.equal(h.send('NET_POLL',id).error.code,'CANCELLED');
  });
  await test('sanitizes network/HTTP errors and parses Retry-After',async () => {
    const n=workerHarness(async () => {throw Error('API-KEY-SECRET');}); n.send('NET_START',undefined,n.request()); await flush(); assert.equal(n.send('NET_POLL').error.code,'NETWORK'); assert.doesNotMatch(JSON.stringify(n.send('NET_POLL')),/API-KEY/);
    const h=workerHarness(async () => new Response('UPSTREAM-SECRET',{status:429,headers:{'retry-after':'3'}})); h.send('NET_START',undefined,h.request()); await flush();
    const e=h.send('NET_POLL').error; assert.equal(e.code,'HTTP429'); assert.equal(e.httpStatus,429); assert.equal(e.retryAfterMs,3000); assert.doesNotMatch(JSON.stringify(e),/SECRET/);
  });
  await test('caps advertised/streaming bodies at 2 MB and rejects malformed JSON',async () => {
    for(const response of [() => new Response('{}',{headers:{'content-length':String(2000001)}}),() => new Response(new Uint8Array(2000001))]) {
      const h=workerHarness(async () => response()); h.send('NET_START',undefined,h.request()); await flush(); assert.equal(h.send('NET_POLL').error.code,'RESPONSE_TOO_LARGE');
    }
    const h=workerHarness(async () => new Response('not JSON SECRET')); h.send('NET_START',undefined,h.request()); await flush(); assert.equal(h.send('NET_POLL').error.code,'INVALID_RESPONSE');
  });
  await test('bounded capacity, idempotent START, done eviction, TTL and forget',async () => {
    let calls=0; const h=workerHarness(async () => {calls++; return new Promise(()=>{});});
    for(let i=0;i<4;i++) h.send('NET_START',String(i).padStart(32,'0'),h.request());
    h.send('NET_START','0'.repeat(32),h.request()); assert.equal(calls,4);
    assert.equal(h.send('NET_START','f'.repeat(32),h.request()).error.code,'BUSY'); h.send('NET_CANCEL_ALL');
    const done=workerHarness();
    for(let i=0;i<34;i++) {done.send('NET_START',i.toString(16).padStart(32,'0'),done.request()); await flush();}
    assert.equal(done.send('NET_POLL','0'.repeat(32)).error.code,'NOT_FOUND');
    const last=(33).toString(16).padStart(32,'0'); assert.equal(done.send('NET_POLL',last).status,'done'); done.send('NET_FORGET',last); assert.equal(done.send('NET_POLL',last).error.code,'NOT_FOUND');
    done.advance(300001); assert.equal(done.send('NET_POLL',(32).toString(16).padStart(32,'0')).error.code,'NOT_FOUND');
  });
  await test('client deduplicates document creation and cleans consumed jobs',async () => {
    const h=workerHarness(), api=bridge(h), a=clientHarness(api);
    const results=await Promise.all([a.jsonFetch('https://example.invalid/'),a.jsonFetch('https://example.invalid/')]);
    assert.equal(results[0].ok,true); assert.equal(api.creations,1); assert.ok(api.messages.some(m => m.type==='NET_FORGET'));
    const starts=api.messages.filter(m => m.type==='NET_START'); assert.match(starts[0].jobId,/^[0-9a-f]{32}$/); assert.notEqual(starts[0].jobId,starts[1].jobId); assert.equal(starts[0].request.timeoutMs,180000);
  });
  await test('client error metadata, retry policy and timeout clamp',async () => {
    for(const [code,status,retry] of [['HTTP400',400,false],['HTTP401',401,false],['HTTP403',403,false],['HTTP404',404,false],['HTTP408',408,true],['HTTP425',425,true],['HTTP429',429,true],['HTTP503',503,true],['TIMEOUT',undefined,true],['NETWORK',undefined,true],['INVALID_RESPONSE',undefined,true],['RESPONSE_TOO_LARGE',undefined,false],['CANCELLED',undefined,false]]) {
      let timeout; const api={offscreen:{hasDocument:async()=>true,createDocument:async()=>{}},runtime:{sendMessage:async m => {timeout=m.request?.timeoutMs ?? timeout; return {status:'error',error:{code,httpStatus:status,retryAfterMs:500,message:'DO NOT ECHO'}};}}};
      const client=clientHarness(api);
      await assert.rejects(client.jsonFetch('https://example.invalid/',{},999999),e => {assert.equal(e.code,code);assert.equal(e.retryable,retry);assert.equal(e.httpStatus,status);assert.equal(e.retryAfterMs,500);assert.doesNotMatch(e.message,/DO NOT ECHO/);return true;}); assert.equal(timeout,240000);
    }
  });
  await test('client cancellation, minimum timeout and bounded context retries',async () => {
    const h=workerHarness(async () => new Promise(()=>{})),api=bridge(h),client=clientHarness(api);
    const pending=client.jsonFetch('https://example.invalid/',{},1); const rejected=assert.rejects(pending,e => e.code==='CANCELLED' && !e.retryable);
    await flush(); await flush(); await client.cancelAll(); await rejected;
    assert.equal(api.messages.find(m=>m.type==='NET_START').request.timeoutMs,1000);
    let sends=0; const broken={offscreen:{hasDocument:async()=>true,createDocument:async()=>{}},runtime:{sendMessage:async()=>{sends++;return undefined;}}};
    await assert.rejects(clientHarness(broken).jsonFetch('https://example.invalid/'),e => e.code==='CONTEXT_LOST'); assert.ok(sends<=4);
  });
  await test('removed CLI DELETE is rejected locally and remotely before any fetch',async()=>{
    const id='a'.repeat(32);let calls=0;const h=workerHarness(async()=>{calls++;return new Response('{"ok":true}');});
    const api=bridge(h),c=clientHarness(api);
    for(const url of ['https://example.invalid/jobs/'+id,'http://127.0.0.1:17864/jobs/'+id,'http://localhost:17864/jobs/'+id,'http://[::1]:17864/jobs/'+id,'http://127.0.0.1:17864/health','http://127.0.0.1:17864/jobs/not-an-id','http://127.0.0.1:17864/jobs/'+id+'?x=1']){
      assert.equal(h.send('NET_START',undefined,h.request({url,method:'DELETE'})).error.code,'INVALID_REQUEST');
      await assert.rejects(c.jsonFetch(url,{method:'DELETE'},10000),e=>e.code==='INVALID_REQUEST');
    }
    assert.equal(calls,0);assert.equal(api.messages.filter(m=>m.type==='NET_START').length,0);
  });
  await test('short transport deadlines do not change the 180 second provider default',async()=>{const h=workerHarness(),api=bridge(h),c=clientHarness(api);await c.jsonFetch('http://127.0.0.1:17864/health',{},10000);await c.jsonFetch('https://example.invalid/');const starts=api.messages.filter(m=>m.type==='NET_START');assert.equal(starts[0].request.timeoutMs,10000);assert.equal(starts[1].request.timeoutMs,180000);});
  await test('offscreen sender guard and bundled classic Worker',async () => {
    let listener,created=0,last;
    class FakeWorker {constructor(url){assert.equal(url,'chrome-extension://test/network-worker.js');created++;} postMessage(m){last=m;this.onmessage({data:{requestId:m.requestId,result:{status:'pending'}}});} terminate(){}}
    const ctx=vm.createContext({Worker:FakeWorker,setTimeout,clearTimeout,chrome:{runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:fn=>listener=fn}}}});
    vm.runInContext(source('offscreen.js'),ctx);
    const m={target:'network-offscreen',type:'NET_START',jobId:'a'.repeat(32)};let reply;
    assert.equal(listener(m,{id:'other'},()=>{throw Error('not allowed');}),false);
    assert.equal(listener(m,{id:'test',tab:{id:1}},()=>{throw Error('not allowed');}),false);assert.equal(created,0);
    assert.equal(listener(m,{id:'test'},r=>reply=r),true);assert.equal(created,1);assert.equal(reply.status,'pending');assert.equal(last.type,'NET_START');
    assert.equal(listener({target:'other'},{id:'test'},()=>{}),false);
  });
  console.log('\n' + tests + ' mocked network tests passed. No live provider calls.');
})().catch(e => {console.error(e);process.exitCode=1;});
