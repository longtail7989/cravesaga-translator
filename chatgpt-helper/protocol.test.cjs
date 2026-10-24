'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FrameDecoder, encodeFrame, validateRequest, safeError, MAX_FRAME_BYTES } = require('./protocol.cjs');
const { runHost, acquireLock, validateOrigin, parseArgs } = require('./host.cjs');
const ORIGIN = 'chrome-extension://mfoolamgailfmmpddefkpnbfiecleefi/';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitFor(predicate) { for (let i=0;i<200;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,5)); } assert.fail('timed out waiting for fake host'); }
function frameReader(stream) {
  const messages = [], errors = [];
  const decoder = new FrameDecoder(m=>messages.push(m), e=>errors.push(e));
  stream.on('data',chunk=>decoder.push(chunk));
  return { messages, errors };
}
function fakeService(overrides = {}) {
  return { status: async()=>({ loggedIn:true, selectedProfileId:'p1', profiles:[{id:'p1',name:'Test',token:'secret'}], accessToken:'secret' }), startLogin: async()=>{}, cancelLogin: async()=>{}, selectProfile: async()=>{}, logout: async()=>{}, models: async()=>[{id:'m',name:'Model',token:'secret'}], translate: async({user})=>'translated:'+user, ...overrides };
}
async function harness(service = fakeService(), extra = {}) {
  const input = new PassThrough(), output = new PassThrough(), reader = frameReader(output);
  let factoryCalls = 0, releases = 0;
  const host = await runHost({ input, output, origin:ORIGIN, storageDirectory:path.resolve('fake-private-root'), acquireLock:async()=>async()=>{releases++;}, createService:async()=>{factoryCalls++;return service;}, protect:async b=>b, unprotect:async b=>b, ...extra });
  return { ...reader, input, output, host, send:(id,method,params)=>input.write(encodeFrame({id,method,...(params?{params}:{})})), get factoryCalls(){return factoryCalls;}, get releases(){return releases;} };
}
test('uint32LE UTF8 frames decode every possible byte boundary and multiple frames',()=>{
  const values = [{id:'한글',method:'STATUS'},{id:'2',method:'TRANSLATE',params:{model:'m',system:'',user:'日本語'}}];
  const bytes = Buffer.concat(values.map(v=>encodeFrame(v)));
  assert.equal(bytes.readUInt32LE(0),Buffer.byteLength(JSON.stringify(values[0])));
  for (let split=0;split<=bytes.length;split++) {
    const got=[]; const decoder=new FrameDecoder(m=>got.push(m),()=>assert.fail('valid frames'));
    decoder.push(bytes.subarray(0,split));decoder.push(bytes.subarray(split));decoder.end(); assert.deepEqual(got,values);
  }
  const got=[]; const decoder=new FrameDecoder(m=>got.push(m),()=>assert.fail('valid frames'));
  for (const byte of bytes) decoder.push(Buffer.from([byte])); decoder.end(); assert.deepEqual(got,values);
});
test('strict incoming limits, JSON, UTF8 and truncated EOF fail once',()=>{
  for (const bytes of [Buffer.from([0,0,0,0]),Buffer.from([1,0,16,0]),Buffer.from([255,255,255,255]),Buffer.from([1,0,0,0,255]),Buffer.from([1,0,0,0,123]),Buffer.from([2,0,0,0,123]),Buffer.from([1,0])]) {
    let errors=0; const decoder=new FrameDecoder(()=>assert.fail('must not decode'),()=>errors++);
    decoder.push(bytes);decoder.end();decoder.end();decoder.push(bytes);assert.equal(errors,1);
  }
});
test('outgoing limit counts UTF8 bytes',()=>{
  assert.throws(()=>encodeFrame('한'.repeat(MAX_FRAME_BYTES)),{code:'RESPONSE_TOO_LARGE'});
  assert.equal(encodeFrame('a'.repeat(MAX_FRAME_BYTES-2)).length,MAX_FRAME_BYTES+4);
});
test('request validation exposes no executable/path/endpoint commands',()=>{
  for (const value of [{id:'x',method:'EXEC',params:{command:'calc'}},{id:'x',method:'STATUS',params:{endpoint:'http://evil'}},{id:'x',method:'TRANSLATE',params:{model:'m',system:'',user:'x',file:'x'}},{id:'x',method:'CANCEL',params:{id:'target'}},{id:[],method:'STATUS'},{id:'x',method:'STATUS',params:[]},{id:'x',method:'SELECT_PROFILE',params:{id:1}}]) assert.throws(()=>validateRequest(value),{code:'INVALID_REQUEST'});
});
test('origin comparison is exact and launcher arguments are constrained',()=>{
  assert.equal(validateOrigin(ORIGIN),true);assert.equal(validateOrigin(ORIGIN.slice(0,-1)),true);
  for (const origin of [ORIGIN+'evil','https://mfoolamgailfmmpddefkpnbfiecleefi/',ORIGIN.toUpperCase(),'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']) assert.equal(validateOrigin(origin),false);
  const dir=path.resolve('state'); assert.equal(parseArgs([ORIGIN,'--parent-window=123','--storage-dir',dir]).storageDirectory,dir); assert.equal(parseArgs(['--storage-dir',dir,ORIGIN]).origin,ORIGIN);
  assert.throws(()=>parseArgs([ORIGIN,'--storage-dir','relative']));assert.throws(()=>parseArgs([ORIGIN,'--storage-dir',dir,'--exec','evil']));
});
test('sanitized errors contain enums and no raw messages or tokens',()=>{
  assert.deepEqual(safeError({code:'NETWORK_ERROR',message:'secret'}),{code:'NETWORK_ERROR',retryable:true});
  assert.deepEqual(safeError({code:'secret-token',message:'raw stderr'}),{code:'INTERNAL_ERROR',retryable:false});
  assert.deepEqual(safeError({code:'sign_in_required'}),{code:'AUTH_REQUIRED',retryable:false});
  assert.deepEqual(safeError({code:'service_busy'}),{code:'BUSY',retryable:true});
});
test('invalid origin and occupied lock reject before service creation and close input',async()=>{
  const bad=await harness(fakeService(),{origin:'https://evil.invalid/'});assert.equal(bad.factoryCalls,0);assert.equal(bad.messages[0].error.code,'FORBIDDEN');assert.equal(bad.input.destroyed,true);
  const busy=await harness(fakeService(),{acquireLock:async()=>{throw Object.assign(new Error('secret'),{code:'BUSY'});}});assert.equal(busy.factoryCalls,0);assert.equal(busy.messages[0].error.code,'BUSY');assert.equal(busy.input.destroyed,true);
});
test('status/models whitelist metadata and dynamic service initializes once',async()=>{
  const h=await harness(); h.send('1','STATUS');h.send('2','MODELS');
  await waitFor(()=>h.messages.length===2); assert.equal(h.factoryCalls,1);
  assert.equal(JSON.stringify(h.messages).includes('secret'),false);
  assert.deepEqual(h.messages.find(m=>m.id==='2').result,[{id:'m',name:'Model'}]);await h.host.shutdown(); assert.equal(h.releases,1);
});
test('LOGIN_START responds before OAuth and port stays live for STATUS',async()=>{
  let resolveLogin, cancelled=0;
  const h=await harness(fakeService({startLogin:()=>new Promise(r=>{resolveLogin=r;}),cancelLogin:async()=>{cancelled++;resolveLogin?.();}}));
  h.send('l','LOGIN_START',{newProfile:true});await waitFor(()=>h.messages.length===1);
  assert.deepEqual(h.messages[0].result,{pending:true});h.send('s','STATUS');await waitFor(()=>h.messages.length===2);
  assert.equal(h.messages[1].result.loginPending,true);h.send('l2','LOGIN_START');await waitFor(()=>h.messages.length===3);assert.equal(h.messages[2].error.code,'BUSY');
  await h.host.shutdown();assert.equal(cancelled,1);
});
test('translation concurrency is one, total pending is eight, FIFO queue',async()=>{
  let active=0,max=0;const finishes=[];
  const h=await harness(fakeService({translate:({user},signal)=>new Promise((resolve,reject)=>{ active++;max=Math.max(active,max); const finish=()=>{active--;resolve(user);}; finishes.push(finish); signal.addEventListener('abort',()=>{active--;reject(Object.assign(new Error(),{name:'AbortError'}));},{once:true}); })}));
  for(let i=0;i<9;i++)h.send('t'+i,'TRANSLATE',{model:'m',system:'',user:String(i)});
  await waitFor(()=>finishes.length===1&&h.messages.length===1);assert.equal(h.messages[0].error.code,'BUSY');
  for(let i=0;i<8;i++){ await waitFor(()=>finishes.length===i+1);finishes[i](); }
  await waitFor(()=>h.messages.length===9);assert.equal(max,1);assert.deepEqual(h.messages.filter(m=>m.ok).map(m=>m.result),['0','1','2','3','4','5','6','7']);await h.host.shutdown();
});
test('CANCEL queued and active translations uses AbortController',async()=>{
  let started=0;
  const h=await harness(fakeService({translate:(_p,signal)=>new Promise((_r,reject)=>{started++;signal.addEventListener('abort',()=>reject(Object.assign(new Error('token secret'),{name:'AbortError'})),{once:true});})}));
  h.send('a','TRANSLATE',{model:'m',system:'',user:'a'});h.send('b','TRANSLATE',{model:'m',system:'',user:'b'});await waitFor(()=>started===1);
  h.send('cb','CANCEL',{targetId:'b'});h.send('ca','CANCEL',{targetId:'a'});await waitFor(()=>h.messages.length===4);
  assert.equal(started,1);assert.equal(h.messages.find(m=>m.id==='a').error.code,'CANCELLED');assert.equal(h.messages.find(m=>m.id==='b').error.code,'CANCELLED');await h.host.shutdown();
});
test('disconnect cancels OAuth, active work and queued work, releases lock after cleanup',async()=>{
  let resolveLogin,aborted=false,closed=false,started=false;
  const h=await harness(fakeService({ startLogin:()=>new Promise(r=>{resolveLogin=r;}),cancelLogin:async()=>resolveLogin?.(),close:async()=>{closed=true;},translate:(_p,signal)=>new Promise((_r,reject)=>{started=true;signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(new Error(),{name:'AbortError'}));},{once:true});}) }));
  h.send('a','TRANSLATE',{model:'m',system:'',user:'a'});await waitFor(()=>started);h.send('l','LOGIN_START');await waitFor(()=>h.messages.some(m=>m.id==='l'));await tick();h.input.end();await h.host.shutdown();assert.equal(aborted,true);assert.equal(closed,true);assert.equal(h.releases,1);
});
test('unknown service error and oversized response are sanitized',async()=>{
  const h=await harness(fakeService({translate:async({user})=>{if(user==='fail')throw new Error('secret stderr');return '한'.repeat(MAX_FRAME_BYTES);}}));
  h.send('a','TRANSLATE',{model:'m',system:'',user:'fail'});h.send('b','TRANSLATE',{model:'m',system:'',user:'big'});await waitFor(()=>h.messages.length===2);
  assert.equal(h.messages[0].error.code,'INTERNAL_ERROR');assert.equal(h.messages[1].error.code,'RESPONSE_TOO_LARGE');assert.equal(JSON.stringify(h.messages).includes('secret'),false);await h.host.shutdown();
});
for (const method of ['SELECT_PROFILE','LOGOUT','LOGIN_START']) {
  test(method+' fences queued account-A translations even when aborted T1 settles after mutation',async()=>{
    const first = deferred(), mutation = deferred();
    let account = 'A', mutationEntered = false;
    const calls = [];
    const change = async()=>{ mutationEntered=true; await mutation.promise; account=method==='LOGOUT'?'logged-out':'B'; };
    const h = await harness(fakeService({
      status:async()=>({activeProfileId:account,loginPending:method==='LOGIN_START'&&mutationEntered}),
      selectProfile:change, logout:change, startLogin:change,
      translate:({user},signal)=>{calls.push({user,account,signal});return user==='T1'?first.promise:Promise.resolve(account+':'+user);}
    }));
    try {
      h.send('t1','TRANSLATE',{model:'m',system:'',user:'T1'});await waitFor(()=>calls.length===1);
      h.send('t2','TRANSLATE',{model:'m',system:'',user:'T2'});
      h.send('mutation',method,method==='SELECT_PROFILE'?{id:'B'}:method==='LOGIN_START'?{newProfile:true}:undefined);
      h.send('during','TRANSLATE',{model:'m',system:'',user:'during'});
      h.send('status','STATUS');
      await waitFor(()=>mutationEntered&&h.messages.some(m=>m.id==='during')&&h.messages.some(m=>m.id==='status'));
      assert.equal(calls[0].signal.aborted,true);
      assert.equal(h.messages.find(m=>m.id==='t2').error.code,'CANCELLED');
      assert.equal(h.messages.find(m=>m.id==='during').error.code,'BUSY');
      assert.equal(h.messages.find(m=>m.id==='status').ok,true);
      if(method==='LOGIN_START') assert.deepEqual(h.messages.find(m=>m.id==='mutation').result,{pending:true});
      else assert.equal(h.messages.some(m=>m.id==='mutation'),false);
      mutation.resolve();await waitFor(()=>account!=='A');await tick();
      h.send('fresh','TRANSLATE',{model:'m',system:'',user:'fresh'});
      first.resolve('stale A result');await waitFor(()=>h.messages.some(m=>m.id==='fresh'));
      assert.equal(h.messages.find(m=>m.id==='t1').error.code,'CANCELLED');
      assert.deepEqual(calls.map(c=>[c.user,c.account]),[['T1','A'],['fresh',account]]);
      assert.equal(h.messages.find(m=>m.id==='fresh').result,account+':fresh');
    } finally { mutation.resolve();first.resolve('cleanup');await h.host.shutdown(); }
  });
}
test('identity boundary is synchronous before service initialization first await',async()=>{
  const initialization=deferred();const calls=[];
  const svc=fakeService({translate:async({user})=>{calls.push(user);return user;}});
  const h=await harness(svc,{createService:()=>initialization.promise});
  try {
    h.input.write(Buffer.concat([
      encodeFrame({id:'old',method:'TRANSLATE',params:{model:'m',system:'',user:'old'}}),
      encodeFrame({id:'switch',method:'SELECT_PROFILE',params:{id:'B'}}),
      encodeFrame({id:'during-init',method:'TRANSLATE',params:{model:'m',system:'',user:'during-init'}})
    ]));
    await waitFor(()=>h.messages.some(m=>m.id==='during-init'));
    assert.equal(h.messages.find(m=>m.id==='during-init').error.code,'BUSY');
    initialization.resolve(svc);await waitFor(()=>h.messages.some(m=>m.id==='switch')&&h.messages.some(m=>m.id==='old'));
    assert.equal(h.messages.find(m=>m.id==='old').error.code,'CANCELLED');assert.deepEqual(calls,[]);
  } finally { initialization.resolve(svc);await h.host.shutdown(); }
});
test('lock is exclusive, conservative on stale PID and own-token cleanup',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'crave-native-'));await fs.chmod(root,0o700);
  try {
    const release=await acquireLock(root);await assert.rejects(acquireLock(root),{code:'BUSY'});await release();
    await fs.writeFile(path.join(root,'native-host.lock'),JSON.stringify({pid:99999999,token:'stale'}));await assert.rejects(acquireLock(root),{code:'BUSY'});
    await fs.unlink(path.join(root,'native-host.lock'));const release2=await acquireLock(root);await fs.writeFile(path.join(root,'native-host.lock'),JSON.stringify({pid:process.pid,token:'different'}));await release2();assert.equal((await fs.stat(path.join(root,'native-host.lock'))).isFile(),true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('real Node child byte-stream framing with fake service, no account/network/DPAPI',async()=>{
  const script = `const {runHost}=require(${JSON.stringify(path.join(__dirname,'host.cjs'))});runHost({input:process.stdin,output:process.stdout,origin:${JSON.stringify(ORIGIN)},storageDirectory:${JSON.stringify(path.resolve('fake'))},acquireLock:async()=>async()=>{},protect:async b=>b,unprotect:async b=>b,createService:async()=>({status:async()=>({loggedIn:true}),cancelLogin:async()=>{},translate:async({user})=>'한글:'+user})});`;
  const child=spawn(process.execPath,['-e',script],{stdio:['pipe','pipe','pipe']});const reader=frameReader(child.stdout);let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code));});
  try {
    const bytes=Buffer.concat([encodeFrame({id:'a',method:'STATUS'}),encodeFrame({id:'b',method:'TRANSLATE',params:{model:'m',system:'',user:'日本語'}})]);
    for(let i=0;i<bytes.length;i+=3)child.stdin.write(bytes.subarray(i,i+3));await waitFor(()=>reader.messages.length===2);child.stdin.end();assert.equal(await exited,0);assert.equal(stderr,'');assert.deepEqual(reader.errors,[]);assert.equal(reader.messages.find(m=>m.id==='b').result,'한글:日本語');
  }finally{child.kill();}
});
