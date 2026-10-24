#!/usr/bin/env node
// Stage a release from reviewed source files and integrity-checked archives only.
// Never runs npm, package lifecycle scripts, installers, OAuth, or inference.
import {readFile, writeFile, mkdir, copyFile, readdir, lstat, mkdtemp, rm, utimes} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {stripTypeScriptTypes} from 'node:module';
import {dirname, join, resolve, relative, isAbsolute, parse} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(root, 'chatgpt-helper');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/build-helper.mjs [--out <directory>] [--tag vVERSION] [--offline]\nRequires Node >=22.13; emits Windows x64 payload (Node itself is not bundled).');
  process.exit(0);
}
let out = join(root, 'dist');
let tag;
let offline = false;
for (let i=0; i<args.length; i++) {
  if (args[i] === '--offline') offline = true;
  else if (args[i] === '--tag' && args[i+1]) tag=args[++i];
  else if (args[i] === '--out' && args[i+1] && !args[i+1].startsWith('--')) out = resolve(args[++i]);
  else throw Error('Unknown or incomplete argument: '+args[i]);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw Error('Build requires Node >=22.13.');
const sdkName = 'openai-sign-in-with-chatgpt-devkit-0a36fef';
const runtimeNames = ['jose','openai','proper-lockfile','graceful-fs','retry','signal-exit'];
const sourceFiles = [
  'host.cjs','protocol.cjs','service.mjs','README.md',
  'windows/common.ps1','windows/install.ps1','windows/uninstall.ps1','windows/dpapi.cjs','windows/README.md',
  'windows/vendor/PINNED-KOFFI.json','windows/vendor/npm-metadata.json','windows/vendor/LICENSE-KOFFI.txt',
  'sdk/PINNED-SOURCE.json','sdk/README.md'
];
let safetyRoot = root;
while (relative(safetyRoot,out).startsWith('..') || isAbsolute(relative(safetyRoot,out))) safetyRoot = dirname(safetyRoot);
const digest = (bytes, algorithm='sha256', encoding='hex') => createHash(algorithm).update(bytes).digest(encoding);
async function exists(p) { try { await lstat(p); return true; } catch(e) { if(e.code === 'ENOENT') return false; throw e; } }
async function noLinks(p) {
  let cursor = resolve(p);
  for (;;) {
    if (await exists(cursor) && (await lstat(cursor)).isSymbolicLink()) throw Error('Symlink/reparse path rejected: '+cursor);
    const parent = dirname(cursor); if(cursor === safetyRoot || parent === cursor) break; cursor = parent;
  }
}
async function checkedFile(p) {
  await noLinks(p);
  if (!(await lstat(p)).isFile()) throw Error('Expected regular file: '+p);
  return readFile(p);
}
async function put(p, bytes) { await mkdir(dirname(p),{recursive:true}); await writeFile(p,bytes); }
async function copyTree(from,to) {
  const st=await lstat(from);
  if(st.isDirectory()) { await mkdir(to,{recursive:true}); for(const n of await readdir(from)) await copyTree(join(from,n),join(to,n)); }
  else if(st.isFile()) { await mkdir(dirname(to),{recursive:true}); await copyFile(from,to); }
  else throw Error('Non-regular generated payload');
}
async function acquire(local, url, integrity) {
  let bytes;
  if (await exists(local)) bytes = await checkedFile(local);
  else {
    if (offline) throw Error('Offline archive missing: '+local);
    const u = new URL(url);
    if (u.protocol !== 'https:' || !['api.github.com','registry.npmjs.org'].includes(u.hostname)) throw Error('Unapproved archive origin');
    const response = await fetch(u, {signal:AbortSignal.timeout(120000)});
    if (!response.ok) throw Error('Archive download failed ('+response.status+'): '+url);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const [algorithm, expected] = integrity.split(/-(.*)/s);
  const actual = digest(bytes,algorithm,algorithm==='sha256'?'hex':'base64');
  if (actual !== expected) throw Error('Archive integrity mismatch: '+local);
  return bytes;
}
// Strict extraction for the two pinned Koffi packages: regular files/directories
// only; no links, traversal, drive paths, Windows alternate streams or devices.
async function unpack(bytes, dest, archiveRoot='package') {
  const tar = gunzipSync(bytes, {maxOutputLength:64*1024*1024});
  const seen = new Set(); let pax;
  for (let offset=0; offset+512<=tar.length;) {
    const h=tar.subarray(offset,offset+512); if(h.every(b=>b===0)) break;
    const field=(a,b)=>h.subarray(a,b).toString().replace(/\0.*$/s,'');
    const sum=parseInt(field(148,156).trim(),8);
    if(!Number.isSafeInteger(sum) || [...h].reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0)!==sum) throw Error('Invalid tar checksum');
    const size=parseInt(field(124,136).trim()||'0',8), type=field(156,157);
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length) throw Error('Invalid tar size');
    let name=field(0,100), prefix=field(345,500); if(prefix) name=prefix+'/'+name;
    const body=tar.subarray(offset+512,offset+512+size); offset+=512+Math.ceil(size/512)*512;
    if(type==='g') {
      if(/(?:^|\n)\d+ (?:path|linkpath|size)=/.test(body.toString())) throw Error('Unsupported global PAX path');
      continue;
    }
    if(type==='x') {
      pax={}; let pos=0;
      while(pos<body.length) {
        const space=body.indexOf(32,pos), len=Number(body.subarray(pos,space).toString());
        if(space<pos || !Number.isSafeInteger(len)||len<=0||pos+len>body.length) throw Error('Invalid PAX record');
        const record=body.subarray(space+1,pos+len-1).toString(), eq=record.indexOf('=');
        if(eq<1) throw Error('Invalid PAX key'); pax[record.slice(0,eq)]=record.slice(eq+1); pos+=len;
      }
      continue;
    }
    if(pax?.linkpath || pax?.size) throw Error('Unsupported PAX metadata');
    name=pax?.path||name; pax=undefined;
    const parts=name.replace(/\/$/,'').split('/');
    if(parts.shift()!==archiveRoot||parts.some(p=>!p||p==='.'||p==='..'||/[\\:\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) throw Error('Unsafe tar path: '+name);
    if(!parts.length) continue;
    const key=parts.join('/').toLowerCase(); if(seen.has(key)) throw Error('Duplicate tar path'); seen.add(key);
    const target=join(dest,...parts);
    if(type==='5') await mkdir(target,{recursive:true});
    else if(type===''||type==='0') await put(target,body);
    else throw Error('Unsupported tar entry type: '+type);
  }
}
async function treeFiles(dir, prefix='') {
  const result=[];
  for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
    const name=prefix?prefix+'/'+e.name:e.name, full=join(dir,e.name);
    if(e.isSymbolicLink()) throw Error('Unexpected output symlink');
    if(e.isDirectory()) result.push(...await treeFiles(full,name));
    else if(e.isFile()) result.push(name); else throw Error('Unexpected non-regular file');
  }
  return result;
}
await noLinks(out);
const rel=relative(helper,out);
if(!rel || (!rel.startsWith('..') && !isAbsolute(rel)) || out===root || out===parse(out).root) throw Error('Output must not overlap helper source or repository root.');
const version=JSON.parse(await checkedFile(join(root,'manifest.json'))).version;
if(!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid manifest version');
if(tag !== undefined && tag !== 'v'+version) throw Error('Release tag/version mismatch');
await mkdir(out,{recursive:true});
const zipPath=join(out,'crave-ai-translator-'+version+'-helper-windows.zip');
if(await exists(zipPath)) throw Error('Release ZIP already exists; never overwritten.');
const work=await mkdtemp(join(out,'.helper-build-'));
const stage=join(work,'payload'), build=join(work,'build'), buildSdk=join(build,'sdk');
try {
  await mkdir(stage,{recursive:true});
  for(const name of sourceFiles) await put(join(stage,name),await checkedFile(join(helper,name)));
  const pin=JSON.parse(await readFile(join(stage,'sdk/PINNED-SOURCE.json'),'utf8'));
  if(pin.commit!=='0a36fefeb913055c8c7a1a29b63d82b96b2e841a'||pin.sourceSHA256!=='dbe3d701810ae17a85b0d1b78f8c93975dacbcedb27d7df35c0af78b8e78d5ad') throw Error('Unsupported SDK pin');
  if(pin.packages.map(p=>p.name).join(',')!==runtimeNames.join(',')) throw Error('Unexpected SDK dependency closure');
  const archives=[];
  const sourceURL=`https://api.github.com/repos/openai/sign-in-with-chatgpt-devkit/tarball/${pin.commit}`;
  const sourceBytes=await acquire(join(helper,'sdk/upstream.tar.gz'),sourceURL,'sha256-'+pin.sourceSHA256);
  await put(join(buildSdk,'upstream.tar.gz'),sourceBytes);
  archives.push({url:sourceURL,sha256:digest(sourceBytes)});
  for(const p of pin.packages) {
    const bytes=await acquire(join(helper,'sdk/downloads',p.name+'.tgz'),p.url,p.integrity);
    await put(join(buildSdk,'downloads',p.name+'.tgz'),bytes); archives.push({url:p.url,sha256:digest(bytes)});
  }
  const expanded=join(buildSdk,sdkName), sdkDest=join(stage,'sdk',sdkName);
  await unpack(sourceBytes,expanded,sdkName);
  const lock=JSON.parse(await readFile(join(expanded,'package-lock.json'),'utf8'));
  for(const p of pin.packages) {
    const spec=lock.packages['node_modules/'+p.name];
    if(spec.version!==p.version||spec.resolved!==p.url||spec.integrity!==p.integrity) throw Error('Upstream lock mismatch');
    await unpack(await readFile(join(buildSdk,'downloads',p.name+'.tgz')),join(expanded,'node_modules',p.name));
  }
  const dist=join(expanded,'packages/local/dist'); await mkdir(dist,{recursive:true});
  for(const n of await readdir(join(expanded,'packages/local/src'))) if(n.endsWith('.ts')) {
    const source=await readFile(join(expanded,'packages/local/src',n),'utf8');
    await put(join(dist,n.replace(/\.ts$/,'.js')),stripTypeScriptTypes(source,{mode:'strip'}));
  }
  for(const n of ['LICENSE','THIRD_PARTY_NOTICES.md','docs/dependency-inventory.json']) await put(join(dist,n),await readFile(join(expanded,n)));
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','README.md','packages/local/package.json','packages/local/LICENSE','packages/local/dist',...runtimeNames.map(n=>'node_modules/'+n)]) {
    const from=join(expanded,name), to=join(sdkDest,name); await mkdir(dirname(to),{recursive:true}); await copyTree(from,to);
  }
  const koffi=JSON.parse(await readFile(join(stage,'windows/vendor/PINNED-KOFFI.json'),'utf8'));
  if(koffi.platform!=='win32'||koffi.arch!=='x64'||koffi.packages.length!==2) throw Error('Unsupported native pin');
  for(const [i,p] of koffi.packages.entries()) {
    if(p.version!=='3.3.4'||p.name!==['koffi','@koromix/koffi-win32-x64'][i]) throw Error('Unexpected native dependency');
    const bytes=await acquire(join(helper,'windows/vendor',i===0?'koffi.tgz':'koffi-win32-x64.tgz'),p.url,p.sha512);
    await unpack(bytes,join(stage,'windows/vendor/koffi',...(i===0?[]:['node_modules/@koromix/koffi-win32-x64'])));
    archives.push({url:p.url,sha256:digest(bytes)});
  }
  // Verify the full reconstructed native tree, including preserved license files.
  const nativeFiles=(await treeFiles(join(stage,'windows/vendor'))).filter(n=>n.startsWith('koffi/')||n==='LICENSE-KOFFI.txt');
  const expected=koffi.files.map(f=>f.path.replaceAll('\\','/')).sort();
  if(JSON.stringify(nativeFiles.sort())!==JSON.stringify(expected)) throw Error('Native payload inventory differs from pin');
  for(const f of koffi.files) {
    const bytes=await readFile(join(stage,'windows/vendor',...f.path.split('\\')));
    if(bytes.length!==f.bytes||digest(bytes)!==f.sha256) throw Error('Native file provenance mismatch: '+f.path);
  }
  await put(join(stage,'BUILD-INFO.json'),JSON.stringify({format:1,target:'win32-x64',nodeBuildVersion:process.versions.node,nodeBundled:false,sdkCommit:pin.commit,archives},null,2)+'\n');
  const files=await treeFiles(stage);
  const sums=[]; for(const f of files) sums.push(digest(await readFile(join(stage,f)))+'  '+f);
  await put(join(stage,'SHA256SUMS.txt'),sums.join('\n')+'\n');
  const epoch=new Date('2000-01-01T00:00:00Z');
  for(const f of await treeFiles(stage)) await utimes(join(stage,f),epoch,epoch);
  async function normalizeDirs(dir) { for(const e of await readdir(dir,{withFileTypes:true})) if(e.isDirectory()) await normalizeDirs(join(dir,e.name)); await utimes(dir,epoch,epoch); }
  await normalizeDirs(stage);
  const zipFiles=await treeFiles(stage);
  async function makeZip(files) {
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(data) {let crc=0xffffffff;for(const b of data)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
const local=[],central=[];let offset=0;
for(const file of files) {
 const full=join(stage,file);
 if (!(await lstat(full)).isFile()) throw Error('Expected regular allowlisted file: '+file);
 const data=await readFile(full),name=Buffer.from(file,'utf8'),crc=crc32(data);
 if (data.length>0xffffffff || offset>0xffffffff) throw Error('ZIP64 not supported');
 const header=Buffer.alloc(30);
 header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
 header.writeUInt16LE(0x21,12); // DOS date: 1980-01-01; time is midnight.
 header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
 local.push(header,name,data);
 const entry=Buffer.alloc(46);
 entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);
 entry.writeUInt16LE(0x21,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);
 entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(0x20,38);entry.writeUInt32LE(offset,42);
 central.push(entry,name);offset+=header.length+name.length+data.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);
end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...local,directory,end]);

return zip;
}
  const zip=await makeZip(zipFiles);
  await writeFile(zipPath,zip,{flag:'wx'});
  console.log(JSON.stringify({output:zipPath,files:zipFiles.length,sha256:digest(zip),target:'win32-x64',installed:false},null,2));
} finally { await rm(work,{recursive:true,force:true}); }
