// Pure cache-format tests: no browser, provider, production cache or credentials.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..');
const coreUrl='data:text/javascript;base64,'+fs.readFileSync(path.join(root,'core.mjs')).toString('base64');
const reliabilityUrl='data:text/javascript;base64,'+fs.readFileSync(path.join(root,'reliability.mjs')).toString('base64');
const source=fs.readFileSync(path.join(root,'cache.mjs'),'utf8').replace("from './core.mjs'","from '"+coreUrl+"'").replace("from './reliability.mjs'","from '"+reliabilityUrl+"'");
const C=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const entry=await C.makeCacheEntry({source:'攻撃力が10%上昇する。',context:'Skill',target:'한국어',text:'공격력이 10% 상승합니다.',createdAt:100,updatedAt:200});
const file=C.buildExport([entry]).data;
if(process.env.CACHE_FIXTURE)fs.writeFileSync(process.env.CACHE_FIXTURE,JSON.stringify(file,null,2));
await test('source-only v3 hash ignores context/provider/model/endpoint/Label IDs',async()=>{
  assert.match(entry.id,/^v3:[a-f0-9]{64}$/);
  assert.equal(await C.cacheId(entry.target,entry.source,'Story'),entry.id);
  assert.equal((await C.makeCacheEntry({...entry,context:'Label 999',provider:'other',model:'other',endpoint:'https://invalid'})).id,entry.id);
});
await test('target and every exact source code unit remain distinct',async()=>{
  assert.notEqual(await C.cacheId('English',entry.source),entry.id);
  for(const value of [entry.source+' ',entry.source+'\n',entry.source.replace('10','１０'),entry.source.replace('10','20')])assert.notEqual(await C.cacheId(entry.target,value),entry.id);
  assert.notEqual(await C.cacheId('ko','é'),await C.cacheId('ko','e\u0301'));
});
await test('portable v3 file excludes credentials endpoints and internal time',()=>{
  const built=C.buildExport([{...entry,apiKey:'NEVER_EXPORT',endpoint:'https://private.invalid',bridgeToken:'NEVER_EXPORT'}]);
  const text=JSON.stringify(built.data);assert(!text.includes('NEVER_EXPORT'));assert(!text.includes('private.invalid'));assert(!Object.hasOwn(built.data.entries[0],'time'));assert.equal(built.data.version,3);
});
await test('round trip preserves original metadata and saved timestamps',async()=>{const [row]=await C.validateImport(JSON.parse(JSON.stringify(file)));assert.deepEqual(row,entry);});
await test('wrong canonical hash is rejected',async()=>{const d=structuredClone(file);d.entries[0].id='v3:'+'0'.repeat(64);await assert.rejects(()=>C.validateImport(d),/고유키/);});
await test('numbers tags variables and exact newline validations retained',()=>{for(const pair of [['10%上昇','20% 증가'],['<b>攻撃</b>','공격'],['{value}上昇','증가'],['攻撃\n防御','공격 방어'],['攻撃\r\n防御','공격\n방어'],['攻撃','공격 99']])assert.throws(()=>C.validateTextPair(...pair));});
await test('old context-hash validated BEFORE canonical conversion',async()=>{
  const old={...C.portableEntry(entry),id:await C.cacheIdV2(entry.target,entry.source,entry.context)};
  const [row]=await C.validateImport({...file,version:1,entries:[old]});assert.equal(row.id,entry.id);assert.equal(row.context,'Skill');
  await assert.rejects(()=>C.validateImport({...file,version:1,entries:[{...old,context:'Story'}]}),/고유키/);
  const [v2]=await C.validateImport({...file,version:2,entries:[old]});assert.equal(v2.id,entry.id);
});
await test('duplicate old contexts merge newest valid deterministically',async()=>{
  const older={...C.portableEntry(entry),id:await C.cacheIdV2(entry.target,entry.source,'Skill')};
  const newer={...older,context:'Story',text:'공격력이 10% 증가합니다.',updatedAt:300,id:await C.cacheIdV2(entry.target,entry.source,'Story')};
  const a=await C.validateImport({...file,version:1,entries:[older,newer]}),b=await C.validateImport({...file,version:1,entries:[newer,older]});assert.deepEqual(a,b);assert.equal(a.length,1);assert.equal(a[0].text,newer.text);
});
await test('unchanged Japanese cannot displace valid older Korean translation',async()=>{
  const unchanged=await C.makeCacheEntry({...entry,text:entry.source,updatedAt:999});assert.equal(C.preferredEntry(entry,unchanged),entry);assert.equal(C.preferredEntry(unchanged,entry),entry);
});
await test('same-time conflicting contexts have deterministic tie break',async()=>{const b=await C.makeCacheEntry({...entry,context:'Story',text:'공격력이 10% 증가합니다.'});assert.deepEqual(C.preferredEntry(entry,b),C.preferredEntry(b,entry));});
await test('unknown fields and missing metadata fail closed',async()=>{
  let d=structuredClone(file);d.entries[0].apiKey='NOT_A_CREDENTIAL';await assert.rejects(()=>C.validateImport(d));
  for(const field of ['exportedAt','appVersion']){d=structuredClone(file);delete d[field];await assert.rejects(()=>C.validateImport(d));}
  for(const field of ['id','source','context','target','text','createdAt','updatedAt']){d=structuredClone(file);delete d.entries[0][field];await assert.rejects(()=>C.validateImport(d));}
});
await test('bad format version timestamps and preserved opaque legacy behavior',async()=>{
  await assert.rejects(()=>C.validateImport({...file,version:999}));await assert.rejects(()=>C.validateImport({...file,format:'unknown'}));
  await assert.rejects(()=>C.makeCacheEntry({...entry,createdAt:201,updatedAt:200}));
  const result=C.buildExport([entry,{id:'a'.repeat(64),text:'옛 번역',time:1}]);assert.equal(result.exported,1);assert.equal(result.legacySkipped,1);
});
await test('no obsolete 20000 entry cap and no automatic store byte cap',async()=>{assert.equal(C.CACHE_MAX_ENTRIES,0);assert.equal(C.CACHE_MAX_STORE_BYTES,0);const d={...file,entries:Array(20001).fill(C.portableEntry(entry))};assert.equal((await C.validateImport(d)).length,1);});
await test('legacy export fails closed at 32MiB with paged API guidance',()=>{const long={...entry,source:'攻'.repeat(8192),text:'한'.repeat(8192)};assert.throws(()=>C.buildExport(Array(1000).fill(long)),/exportPage/);});
await test('empty file remains valid for explicit replace',async()=>assert.equal((await C.validateImport(C.buildExport([]).data)).length,0));
await test('hot paths use bounded native batches without full scans or automatic trim',()=>{const text=fs.readFileSync(path.join(root,'cache-store.mjs'),'utf8');assert(!/\.sort\s*\(|async function trim|\.getAll\(\)|\.getAllKeys\(\)/.test(text));assert(text.includes('index.getAll(bounds,wanted)'));assert(text.includes('Math.min(32,2000-visited)'));assert(text.includes('index.getAllKeys(undefined,wanted)'));assert(text.includes('Math.min(1000,amount-deleted)'));const warm=text.slice(text.indexOf('async warm(target)'),text.indexOf('async deleteOldest'));assert(!warm.includes('.count('));assert(!warm.includes('openCursor'));for(const api of ['exportPage','importBatch','deleteOldest','close','destroy'])assert(text.includes(api));});
await test('recent index fields are internal and normalized after deterministic merge',()=>{assert.equal(entry.reverseTime,Number.MAX_SAFE_INTEGER-entry.updatedAt);assert(!Object.hasOwn(C.portableEntry(entry),'reverseTime'));const old={...entry};delete old.reverseTime;const chosen=C.choosePreferredEntry(old,entry);assert.equal(chosen.reverseTime,Number.MAX_SAFE_INTEGER-entry.updatedAt);assert.equal(chosen.time,entry.updatedAt);});
await test('persisted count avoids native full-count work on normal reads and deletes',()=>{const text=fs.readFileSync(path.join(root,'cache-store.mjs'),'utf8');const count=text.slice(text.indexOf('async function count()'),text.indexOf('async function lookup'));assert(count.includes('get(COUNTER)'));assert(!count.includes('.count('));const del=text.slice(text.indexOf('async deleteOldest'),text.indexOf('async close()'));assert(!del.includes('.count('));assert(del.includes('adjustCount(tx,-deleted'));assert(text.includes("COUNTER='translation-count'"));assert(text.includes('await ensureCount(db,migrated)'));});
await test('manual flag strict optional and ordinary bytes unchanged',async()=>{
  assert(!Object.hasOwn(entry,'manual'));
  assert(!Object.hasOwn(await C.makeCacheEntry({...entry,manual:false}),'manual'));
  const manual=await C.makeCacheEntry({...entry,manual:true});
  assert.equal(manual.manual,true);assert.equal(C.portableEntry(manual).manual,true);
  const [round]=await C.validateImport({...file,entries:[C.portableEntry(manual)]});assert.equal(round.manual,true);
  for(const manual of [0,1,null,'true',{},[]]){
    await assert.rejects(()=>C.makeCacheEntry({...entry,manual}));
    await assert.rejects(()=>C.validateImport({...file,entries:[{...C.portableEntry(entry),manual}]}));
  }
});
await test('valid manual wins over newer automatic and can pin unchanged Japanese',async()=>{
  const pin=await C.makeCacheEntry({...entry,text:entry.source,manual:true,updatedAt:200});
  const newer=await C.makeCacheEntry({...entry,updatedAt:999});
  assert.equal(C.preferredEntry(pin,newer),pin);assert.equal(C.preferredEntry(newer,pin),pin);
  const broken={...pin,text:'BAD 99'};assert.equal(C.preferredEntry(broken,newer),newer);
});
console.log(passed+' cache-format tests passed. Native IndexedDB scale must be tested separately.');
})().catch(e=>{console.error(e);process.exitCode=1;});
