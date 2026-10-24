'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'dpapi.cjs'),'utf8');
let serial=1n, mode='ok', localFrees=0, frees=0, calls=0;
const memory=new Map(), loaded=[];
function alloc(type,length){const p=serial++;memory.set(p,new ArrayBuffer(length));return p;}
function zeroed(p){assert(new Uint8Array(memory.get(p)).every(x=>x===0),'native allocation must be zeroed before free');}
function crypt(data,description,entropy,reserved,prompt,flags,out){
 calls++;assert.equal(description,null);assert.equal(reserved,null);assert.equal(prompt,null);assert.equal(flags,1);
 assert.equal(Buffer.from(memory.get(entropy.pbData)).toString(),'com.crave_ai_translator.chatgpt:oauth-state:v1');
 const input=Buffer.from(memory.get(data.pbData));out.cbData=input.length;out.pbData=alloc('',input.length);
 new Uint8Array(memory.get(out.pbData)).set(input.map(x=>x^0x5a));
 return mode==='fail'?0:1;
}
const koffi={version:'3.3.4',alloc,view(p,len){const b=memory.get(p);assert(b&&len===b.byteLength);return b;},free(p){zeroed(p);memory.delete(p);frees++;},struct(){},load(file){loaded.push(file);return {func(signature){if(signature.includes('LocalFree'))return p=>{zeroed(p);memory.delete(p);localFrees++;return null;};return crypt;}};}};
const m={exports:{}};vm.runInNewContext(source,{Buffer,Uint8Array,module:m,exports:m.exports,__dirname,process:{platform:'win32',arch:'x64',env:{SystemRoot:'C:\\Windows'}},require(name){if(name==='node:path')return path;if(name==='./vendor/koffi/index.cjs')return koffi;throw Error('Unexpected runtime dependency '+name);}});
(async()=>{
 const s=Buffer.from('synthetic-only'),p=m.exports.protectSync(s);assert.deepEqual(m.exports.unprotectSync(p),s);
 assert.deepEqual(await m.exports.unprotect(await m.exports.protect(s)),s);
 assert.equal(s.toString(),'synthetic-only');
 assert.deepEqual(loaded,['C:\\Windows\\System32\\Crypt32.dll','C:\\Windows\\System32\\Kernel32.dll']);
 assert.equal(localFrees,4);assert.equal(frees,8);assert.equal(memory.size,0);
 mode='fail';assert.throws(()=>m.exports.protectSync(s),/no plaintext fallback/);await assert.rejects(()=>m.exports.protect(s),/no plaintext fallback/);
 assert.equal(memory.size,0);assert.equal(localFrees,6);assert.equal(frees,12);
 const before=calls;assert.throws(()=>m.exports.protectSync(Buffer.alloc(0)));assert.throws(()=>m.exports.protectSync(Buffer.alloc(1024*1024)));assert.throws(()=>m.exports.unprotectSync(s));assert.equal(calls,before);
 assert(!source.includes('child_process'));assert(!source.includes('ExecutionPolicy'));assert(!source.includes('powershell.exe'));
 console.log('PASS: native mocks sync/async, CurrentUser UI_FORBIDDEN, absolute DLLs, entropy, zero/free on success/failure, bounds and no interpreter.');
})().catch(e=>{console.error('FAIL: '+e.message);process.exitCode=1;});
