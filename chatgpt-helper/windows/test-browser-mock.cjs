'use strict';
// No browser is actually opened; no OAuth or credential data is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'dpapi.cjs'),'utf8');
let result=33n,calls=0;const loaded=[];
const koffi={version:'3.3.4',struct(){},load(file){loaded.push(file);return {func(signature){if(signature.includes('ShellExecuteW'))return (...args)=>{calls++;assert.deepEqual(args,[null,'open','https://auth.openai.com/authorize?synthetic=true',null,null,1]);return result;};return ()=>{throw Error('Unexpected DPAPI call');};}};}};
const m={exports:{}};vm.runInNewContext(source,{Buffer,Uint8Array,URL,module:m,exports:m.exports,__dirname,process:{platform:'win32',arch:'x64',env:{SystemRoot:'C:\\Windows'}},require(name){if(name==='node:path')return path;if(name==='./vendor/koffi/index.cjs')return koffi;throw Error('Unexpected dependency');}});
(async()=>{
 for(const bad of ['http://auth.openai.com/','https://auth.openai.com.evil.invalid/','https://evil.invalid/','https://user@auth.openai.com/','https://auth.openai.com:444/','javascript:void(0)','https://auth.openai.com/\r\n',null])await assert.rejects(()=>m.exports.openBrowser(bad),/URL rejected/);
 assert.equal(calls,0);assert.equal(loaded.length,0);
 await m.exports.openBrowser('https://auth.openai.com/authorize?synthetic=true');assert.equal(calls,1);
 assert(loaded.includes('C:\\Windows\\System32\\Shell32.dll'));
 result=31n;await assert.rejects(()=>m.exports.openBrowser('https://auth.openai.com/authorize?synthetic=true'),/could not open/);assert.equal(calls,2);
 console.log('PASS: native browser mock HTTPS allowlist, no URL logging, absolute Shell32 and API errors.');
})().catch(e=>{console.error('FAIL: '+e.message);process.exitCode=1;});
