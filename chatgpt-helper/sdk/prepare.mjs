// Reproducible local build. No npm install, lifecycle scripts, global changes,
// OAuth or inference. Node >=22.13 (built-in TypeScript erasure) required.
import {readFile,writeFile,mkdir,readdir,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=dirname(fileURLToPath(import.meta.url));
const commit='0a36fefeb913055c8c7a1a29b63d82b96b2e841a';
const upstream=join(root,'openai-sign-in-with-chatgpt-devkit-0a36fef');
const sourceURL=`https://api.github.com/repos/openai/sign-in-with-chatgpt-devkit/tarball/${commit}`;
async function extract(bytes,dest,strip=0){const tar=gunzipSync(bytes);let paxPath;for(let offset=0;offset+512<=tar.length;){const header=tar.subarray(offset,offset+512);if(header.every(b=>b===0))break;const field=(a,b)=>header.subarray(a,b).toString().replace(/\0.*$/s,'');let name=field(0,100);const prefix=field(345,500);if(prefix)name=prefix+'/'+name;const size=parseInt(field(124,136).trim()||'0',8);if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw Error('Invalid tar');const type=field(156,157);const body=tar.subarray(offset+512,offset+512+size);offset+=512+Math.ceil(size/512)*512;if(type==='x'){const match=body.toString().match(/\d+ path=([^\n]+)\n/);paxPath=match?.[1];continue;}if(paxPath){name=paxPath;paxPath=undefined;}const parts=name.split('/').filter(Boolean).slice(strip);if(!parts.length)continue;if(parts.some(p=>p==='..'||p==='.'||p.includes(':')||p.includes('\\'))||name.startsWith('/'))throw Error('Unsafe tar path');const file=join(dest,...parts);if(type==='5'){await mkdir(file,{recursive:true});continue;}if(type!==''&&type!=='0')throw Error('Unsupported tar entry');await mkdir(dirname(file),{recursive:true});await writeFile(file,body);}}

async function download(url,file){const r=await fetch(url);if(!r.ok)throw Error('Acquisition failed');await writeFile(file,Buffer.from(await r.arrayBuffer()));}
if(process.argv.includes('--acquire'))await download(sourceURL,join(root,'upstream.tar.gz'));
const sourceArchive=await readFile(join(root,'upstream.tar.gz'));
if(createHash('sha256').update(sourceArchive).digest('hex')!=='dbe3d701810ae17a85b0d1b78f8c93975dacbcedb27d7df35c0af78b8e78d5ad')throw Error('Pinned upstream archive hash mismatch');
await extract(sourceArchive,root);
const lock=JSON.parse(await readFile(join(upstream,'package-lock.json'),'utf8'));
const names=['jose','openai','proper-lockfile','graceful-fs','retry','signal-exit'];
const manifest={repository:'https://github.com/openai/sign-in-with-chatgpt-devkit',commit,version:'0.1.0',build:'Node module.stripTypeScriptTypes mode=strip, unmodified upstream TypeScript; type-only erasure, no source patch',sourceSHA256:createHash('sha256').update(await readFile(join(root,'upstream.tar.gz'))).digest('hex'),packages:[]};
await mkdir(join(root,'downloads'),{recursive:true});
for(const name of names){const spec=lock.packages['node_modules/'+name];const file=join(root,'downloads',name+'.tgz');if(process.argv.includes('--acquire'))await download(spec.resolved,file);const bytes=await readFile(file);const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');if(integrity!==spec.integrity)throw Error('Dependency integrity mismatch: '+name);const dest=join(upstream,'node_modules',name);await mkdir(dest,{recursive:true});await extract(bytes,dest,1);manifest.packages.push({name,version:spec.version,url:spec.resolved,integrity});}
const dist=join(upstream,'packages/local/dist');await mkdir(dist,{recursive:true});
for(const name of await readdir(join(upstream,'packages/local/src'))){if(!name.endsWith('.ts'))continue;const source=await readFile(join(upstream,'packages/local/src',name),'utf8');const js=stripTypeScriptTypes(source,{mode:'strip'});await writeFile(join(dist,name.replace(/\.ts$/,'.js')),js);}
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','docs/dependency-inventory.json']){await mkdir(dirname(join(dist,name)),{recursive:true});await copyFile(join(upstream,name),join(dist,name));}
await writeFile(join(root,'PINNED-SOURCE.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));
