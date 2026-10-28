import {VERSION,DEFAULTS,sanitizeSettings,isConfigured,publicConfig,wantsTranslation,protect,restore,makePrompt,parseTranslations,redact,providerRequest,extractProviderText} from './core.mjs';
import {createCacheStore} from './cache-store.mjs';
import {createCacheTransfer} from './cache-transfer.mjs';
import {createCacheEditor} from './cache-editor.mjs';
import {createDistributionBroker,distributionErrorResponse} from './distribution-broker.mjs';
import {cacheId,validateTextPair} from './cache.mjs';
import {createNetworkClient} from './network-client.mjs';
import {createChatGPTClient} from './chatgpt-client.mjs';
import {appError,failure,unchangedJapanese} from './reliability.mjs';
import './dialogue-text.js';
const dialogue=globalThis[Symbol.for('crave-ai-dialogue-text.v1')];
const network=createNetworkClient();
const chatgpt=createChatGPTClient();
const gameTabs=new Map();
const accessReady=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
let serial=Promise.resolve(),nativeReloadPending=false;
const locked=fn=>{const next=serial.then(fn,fn);serial=next.catch(()=>{});return next;};
const cache=createCacheStore();
const transfers=createCacheTransfer(cache),editor=createCacheEditor(cache),pendingMap=new Map();
// Reclaim abandoned file-import staging after a browser/worker restart.
Promise.resolve(transfers.cleanup?.()).catch(()=>{});
function settle(job,value){if(job.done)return;job.done=true;if(pendingMap.get(job.key)===job)pendingMap.delete(job.key);job.resolve(value);}
function cancelPending(){const info=failure(appError('CANCELLED'));for(const job of pendingMap.values())settle(job,{error:info.message,...info});}
async function invalidate(){await chrome.storage.local.set({configRevision:crypto.randomUUID()});cancelPending();await network.cancelAll();await chatgpt.cancelAll();}
function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
async function getUsage(){const {usage}=await chrome.storage.local.get('usage');return usage?.date===today()?usage:{date:today(),chars:0,requests:0};}
async function settings(){await accessReady;const {settings:s}=await chrome.storage.local.get('settings');return sanitizeSettings(s||DEFAULTS);}
async function currentConfig(s){const {configRevision}=await chrome.storage.local.get('configRevision');return {...publicConfig(s),cacheEpoch:configRevision||'initial'};}
function assertReady(s){if(!isConfigured(s))throw Error('설정에서 provider·모델·인증 및 전송 동의를 확인하세요.');}
async function assertPermission(endpoint){const origin=new URL(endpoint).origin+'/*';if(!await chrome.permissions.contains({origins:[origin]}))throw Error('설정 화면에서 이 endpoint의 사이트 접근 권한을 허용하세요.');}
async function jsonFetch(url,options={},timeout=180000){return network.jsonFetch(url,options,timeout);}
async function providerCall(s,prompt,checkpoint=async()=>{}){await checkpoint();
  if(s.provider==='chatgpt')return chatgpt.translate(s,prompt,checkpoint);
  await assertPermission(s.endpoint);await checkpoint();
  const request=providerRequest(s,prompt);const data=await jsonFetch(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(request.body)},s.requestTimeoutSeconds*1000);
  const limited=s.provider==='gemini'?data.candidates?.[0]?.finishReason==='MAX_TOKENS':s.provider==='anthropic'?data.stop_reason==='max_tokens':data.choices?.[0]?.finish_reason==='length';if(limited)throw appError('OUTPUT_LIMIT',undefined,true);
  return extractProviderText(s.provider,data);
}
function validateTranslationItem(item,s){
  if(!item||typeof item.id!=='string'||item.id.length>80||typeof item.source!=='string'||!item.source.trim()||item.source.length>8192||(item.context!=null&&(typeof item.context!=='string'||item.context.length>300)))throw appError('BAD_REQUEST','번역 요청 문구가 올바르지 않습니다.');
  const templates=item.templates;
  if(templates!==undefined&&(!Array.isArray(templates)||templates.length>2||templates.some(source=>typeof source!=='string'||!source.includes('{USER}')||source.length>8192)))throw appError('BAD_REQUEST','이름 공유 캐시 원문이 올바르지 않습니다.');
  if(!wantsTranslation(item.source,s.translateLatin)&&item.source!=='{USER}'&&!templates?.includes('{USER}'))throw appError('BAD_REQUEST','번역할 수 있는 문구가 아닙니다.');
  return item.source.length+(templates||[]).reduce((n,source)=>n+source.length,0);
}
async function lookupTranslation(item,s){
  const literal=await cache.lookup(item,s);if(literal)return literal;
  for(const source of item.templates||[]){const hit=await cache.lookup({source,context:item.context},s);if(hit)return hit;}
  if(dialogue.isStory(item.context))for(const source of [item.source,...(item.templates||[])]){const hit=await cache.lookupDialogue({source,context:item.context},s);if(hit)return hit;}
  return null;
}
async function translate(items,s,{test=false,revision:expectedRevision}={}){
  assertReady(s);
  if(!Array.isArray(items)||items.length>16)throw appError('BAD_REQUEST','번역 요청 항목 수가 올바르지 않습니다.');
  const seen=new Set(),groups=new Map();let chars=0;
  for(const x of items){validateTranslationItem(x,s);if(seen.has(x.id))throw appError('BAD_REQUEST','번역 요청 ID가 중복되었습니다.');seen.add(x.id);const key=JSON.stringify([x.source,...(x.templates||[]),dialogue.isStory(x.context)]);let g=groups.get(key);if(!g){g={item:x,ids:[]};groups.set(key,g);chars+=Math.max(x.source.length,...(x.templates||[]).map(source=>source.length));}g.ids.push(x.id);}
  if(chars>Math.max(8192,s.maxBatchChars))throw appError('BAD_REQUEST','한 번에 요청한 문구가 너무 깁니다.');
  const {configRevision:startRevision}=await chrome.storage.local.get('configRevision');if(expectedRevision!==undefined&&expectedRevision!==(startRevision??'initial'))throw appError('CANCELLED');
  const owned=[];let cacheSaved,storageWarning;
  const guard=async()=>{const live=await settings(),{configRevision}=await chrome.storage.local.get('configRevision');if(configRevision!==startRevision||(!test&&!live.enabled))throw appError('CANCELLED');};
  await locked(async()=>{
    await guard();const misses=new Map();
    for(const g of groups.values()){
      const hit=test||(!s.cacheOnly&&s.cacheEnabled===false)?null:await lookupTranslation(g.item,s);
      if(hit){g.result={text:hit.text,cached:true,cacheSource:hit.source};continue;}
      if(!test&&s.cacheOnly){g.result={missing:true,error:'캐시 전용 모드: 저장되지 않은 문구는 원문으로 표시합니다.',code:'CACHE_MISS',retryable:false};continue;}
      g.literalSource=g.item.source;
      g.item={id:g.item.id,source:dialogue.canonical(g.item.templates?.[0]||g.item.source,g.item.context),context:g.item.context||''};
      g.key=JSON.stringify([startRevision??'initial',s.target,g.item.source]);
      const prior=test?null:pendingMap.get(g.key);
      if(prior){g.job=prior;g.shared=true;}
      else if(misses.has(g.key)){g.owner=misses.get(g.key);g.shared=true;}
      else misses.set(g.key,g);
    }
    if(!test&&pendingMap.size+misses.size>512)throw appError('RATE_LIMIT',undefined,true,{retryAfterMs:5000});
    for(const g of misses.values()){let resolve;const promise=new Promise(r=>{resolve=r;});if(!s.cacheOnly&&s.cacheEnabled===false)g.item.replaceSources=[];const job={key:g.key,promise,resolve,done:false,item:g.item,target:s.target};g.job=job;owned.push(job);if(!test)pendingMap.set(g.key,job);}
    for(const g of groups.values()){if(g.owner)g.job=g.owner.job;if(!s.cacheOnly&&s.cacheEnabled===false&&g.job&&g.literalSource!==g.job.item.source&&!g.job.item.replaceSources.includes(g.literalSource))g.job.item.replaceSources.push(g.literalSource);}
  });
  async function runOwned(){
    try{
      const missing=owned.filter(job=>job.item.source!=='{USER}').map(job=>job.item);
      let parsed,records;
      if(missing.length){
        await locked(async()=>{await guard();const size=missing.reduce((n,item)=>n+item.source.length,0),usage=await getUsage();if(s.dailyRequestLimit>0&&usage.requests>=s.dailyRequestLimit)throw appError('QUOTA');if(s.dailyCharLimit>0&&usage.chars+size>s.dailyCharLimit)throw appError('QUOTA');await chrome.storage.local.set({usage:{date:today(),chars:usage.chars+size,requests:usage.requests+1}});});
        const prefix='P'+crypto.randomUUID().replace(/-/g,'').slice(0,10);records=new Map(missing.map(x=>[x.id,protect(x.source,prefix+x.id.replace(/[^a-zA-Z0-9]/g,'').slice(-12))]));
        const prompt=makePrompt(missing.map(x=>{const record=records.get(x.id);return {id:x.id,text:record.masked,context:x.context||'',nameTokens:record.values.filter(value=>value.value==='{USER}').map(value=>value.token)};}),s.target);
        const raw=await providerCall(s,prompt,guard);try{parsed=parseTranslations(raw,missing.map(x=>x.id));}catch{throw appError('INVALID_RESPONSE',undefined,true);}
      }
      const values=new Map(),toStore=[];
      for(const job of owned){const item=job.item;try{const text=item.source==='{USER}'?'{USER}':restore(parsed.get(item.id),records.get(item.id));validateTextPair(item.source,text);if(unchangedJapanese(item.source,text,s.target))throw appError('UNTRANSLATED',undefined,true);values.set(job,{text,cached:false,cacheSource:item.source});if(!test)toStore.push({...item,text});}catch(e){const info=failure(e.code?e:appError('VALIDATION',undefined,true));values.set(job,{error:info.message,...info});}}
      // A joined job resolves only after this revision-guarded durable write finishes.
      await locked(async()=>{await guard();const activeWrites=toStore.filter(item=>owned.some(job=>!job.done&&job.item.source===item.source));if(activeWrites.length){try{await cache.put(activeWrites,s,{replaceExisting:!s.cacheOnly&&s.cacheEnabled===false});cacheSaved=true;}catch(e){if(!/quota|storage.?full|disk.?full|space/i.test(String(e?.name)+' '+String(e?.message)))throw e;cacheSaved=false;storageWarning='STORAGE_FULL';}}for(const job of owned){const value=values.get(job);if(typeof value.text==='string'&&!test){value.cacheSaved=cacheSaved===true;if(storageWarning)value.warning=value.storageWarning=storageWarning;}settle(job,value);}});
    }catch(e){const info=failure(e);for(const job of owned)settle(job,{error:info.message,...info});}
  }
  // Start every request's owned batch before waiting for jobs owned by other requests.
  const running=owned.length?runOwned():Promise.resolve();
  const results=[];await Promise.all([...groups.values()].map(async g=>{const value=g.result||await g.job.promise;if(value.warning==='STORAGE_FULL')storageWarning='STORAGE_FULL';if(value.cacheSaved===false)cacheSaved=false;else if(value.cacheSaved===true&&cacheSaved!==false)cacheSaved=true;for(const id of g.ids)results.push({id,...value,...(g.shared?{shared:true}: {})});}));await running;
  // Cache-only and cache hits also must not escape a concurrent pause/config revision.
  try{await locked(guard);}catch(e){const info=failure(e);return {ok:true,results:items.map(x=>({id:x.id,error:info.message,...info})),usage:await getUsage()};}
  return {ok:true,results,usage:await getUsage(),...(cacheSaved!==undefined?{cacheSaved}:{}),...(storageWarning?{storageWarning,warning:storageWarning}:{})};
}
async function storageCleaned(){const tabs=await chrome.tabs.query({});await Promise.all(tabs.map(t=>chrome.tabs.sendMessage(t.id,{type:'CACHE_STORAGE_CLEANED'}).catch(()=>{})));}
async function broadcast(config){const tabs=await chrome.tabs.query({});await Promise.all(tabs.map(t=>chrome.tabs.sendMessage(t.id,{type:'PUBLIC_CONFIG_CHANGED',config}).catch(()=>{})));}
async function broadcastEdit(entry){const tabs=await chrome.tabs.query({});const patch={source:entry.source,target:entry.target,text:entry.text,updatedAt:entry.updatedAt,manual:true};await Promise.all(tabs.map(t=>chrome.tabs.sendMessage(t.id,{type:'CACHE_ENTRY_UPDATED',entry:patch}).catch(()=>{})));}
async function broadcastDelete(result){const tabs=await chrome.tabs.query({});const entry={source:result.source,target:result.target};await Promise.all(tabs.map(t=>chrome.tabs.sendMessage(t.id,{type:'CACHE_ENTRY_DELETED',entry}).catch(()=>{})));}
function isAdmin(sender){return sender.id===chrome.runtime.id&&typeof sender.url==='string'&&sender.url.split(/[?#]/)[0]===chrome.runtime.getURL('popup.html');}
function isGame(sender){try{const u=new URL(sender.url);return sender.id===chrome.runtime.id&&u.protocol==='https:'&&u.hostname==='gg-client-r.crave-saga.net'&&/^\/client\/[^/]+\/index_dmm\.html$/.test(u.pathname);}catch{return false;}}
const perDocument=new Map();
function checkRate(sender){const key=`${sender.tab?.id}:${sender.documentId||sender.frameId}`,now=Date.now();const recent=(perDocument.get(key)||[]).filter(t=>now-t<60000);if(recent.length>=12)throw appError('RATE_LIMIT',undefined,true,{retryAfterMs:60000});recent.push(now);perDocument.set(key,recent);if(perDocument.size>200)perDocument.delete(perDocument.keys().next().value);}
async function listModels(s){if(s.migrationRequired||!['openai','gemini','anthropic','custom','chatgpt'].includes(s.provider))throw appError('BAD_REQUEST','제거된 CLI 연결입니다. 지원되는 연결 방식을 다시 선택하세요.');if(s.provider==='chatgpt')return {ok:true,models:await chatgpt.models(),authVerified:true,message:'공식 계정의 표시 가능 모델 목록입니다. 개별 모델 요청 성공이나 사용량 잔여는 확인되지 않았습니다.'};await assertPermission(s.endpoint);let headers={},url;
  if(s.provider==='gemini'){headers['x-goog-api-key']=s.apiKey;url=`${s.endpoint}/models?pageSize=1000`;}
  else if(s.provider==='anthropic'){headers={'x-api-key':s.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'};url=`${s.endpoint.replace(/\/messages$/,'')}/models`;}
  else {if(s.apiKey)headers.Authorization=`Bearer ${s.apiKey}`;url=`${s.endpoint.replace(/\/chat\/completions$/,'')}/models`;}
  const data=await jsonFetch(url,{headers});const list=data.models||data.data||[];
  const models=list.filter(x=>s.provider!=='gemini'||x.supportedGenerationMethods?.includes('generateContent')).map(x=>({id:String(x.id||x.name||'').replace(/^models\//,''),name:x.displayName||x.display_name||x.id||x.name})).filter(x=>x.id);
  return {ok:true,models};
}
function relatedJob(job,entry){return job.target===entry.target&&(job.item.source===entry.source||(dialogue.isStory(job.item.context)&&dialogue.equivalent(job.item.source,entry.source)));}
async function saveCacheEdit(message){const result=await editor.save({id:message.id,source:message.source,target:message.target,text:message.text,expectedUpdatedAt:message.expectedUpdatedAt,expectedText:message.expectedText,create:message.create===true});for(const job of pendingMap.values())if(relatedJob(job,result.entry))settle(job,{text:result.entry.text,cached:true,manual:true,cacheSaved:true,cacheSource:result.entry.source});await broadcastEdit(result.entry);return {ok:true,...result};}
function assertGameCacheScope(message,s){if(typeof message.source!=='string'||!message.source.trim()||message.source.length>8192||typeof message.target!=='string'||message.target!==s.target)throw appError('BAD_REQUEST','현재 번역 언어의 올바른 문구만 편집할 수 있습니다.');}
let distributionBroker;
async function handle(message,sender){await accessReady;if(!message||typeof message.type!=='string')throw Error('잘못된 메시지입니다.');
  if(message.type.startsWith('DISTRIBUTION_'))return (distributionBroker??=createDistributionBroker({chrome,cache,editor,settings,isGame})).handle(message,sender);
  if(!isAdmin(sender)&&!isGame(sender))throw appError('BAD_REQUEST','이 페이지에서는 확장을 사용할 수 없습니다.');
  if(isGame(sender)&&sender.tab?.id){gameTabs.set(sender.tab.id,Date.now());if(gameTabs.size>20)gameTabs.delete(gameTabs.keys().next().value);}
  if(message.type==='PUBLIC_CONFIG'){const s=await settings();return {ok:true,config:await currentConfig(s),usage:await getUsage()};}
  if(message.type==='OPEN_OPTIONS')throw Error('설정은 툴바의 크레이브사가 번역기 아이콘을 눌러 팝업에서 변경하세요.');
  if(message.type==='CACHE_WARM'){if(!isGame(sender))throw Error('게임 프레임 전용 요청입니다.');const s=await settings();return {ok:true,...(s.enabled&&(s.cacheOnly||s.cacheEnabled!==false)?await cache.warm(s.target):{entries:[],remaining:0,bytes:0})};}
  if(message.type==='CACHE_LOOKUP'){
    if(!isGame(sender))throw Error('게임 프레임 전용 요청입니다.');const s=await settings();if(!s.enabled)return {ok:true,results:[]};
    const items=message.items;if(!Array.isArray(items)||items.length>32||items.reduce((n,x)=>n+(typeof x?.source==='string'?x.source.length:0),0)>131072)throw Error('캐시 조회 크기가 올바르지 않습니다.');
    const ids=new Set();let bytes=0;for(const x of items){bytes+=validateTranslationItem(x,s);if(ids.has(x.id)||bytes>131072)throw appError('BAD_REQUEST','캐시 조회 항목이 올바르지 않습니다.');ids.add(x.id);}
    const results=await Promise.all(items.map(async x=>{const hit=!s.cacheOnly&&s.cacheEnabled===false?null:await lookupTranslation(x,s);return hit?{id:x.id,text:hit.text,cached:true,cacheSource:hit.source}:{id:x.id,missing:true};}));return {ok:true,results};
  }
  if(message.type==='TRANSLATE'){
    if(!isGame(sender))throw Error('게임 프레임 전용 요청입니다.');if(nativeReloadPending)throw appError('CANCELLED');checkRate(sender);
    const snapshot=await locked(async()=>({s:await settings(),...(await chrome.storage.local.get('configRevision'))}));if(!snapshot.s.enabled)throw appError('CANCELLED');return translate(message.items,snapshot.s,{revision:snapshot.configRevision??'initial'});
  }
  if(message.type==='SET_ENABLED')return locked(async()=>{const s=await settings();s.enabled=!!message.enabled;if(s.enabled)assertReady(s);await chrome.storage.local.set({settings:s});await invalidate();const config=await currentConfig(s);await broadcast(config);return {ok:true,config};});
  if(message.type==='SET_CACHE_ENABLED')return locked(async()=>{if(typeof message.cacheEnabled!=='boolean')throw appError('BAD_REQUEST','캐시 사용 값은 true 또는 false여야 합니다.');const s=await settings();if(s.cacheOnly&&!message.cacheEnabled)throw appError('BAD_REQUEST','캐시 전용 모드에서는 캐시를 끌 수 없습니다.');const {settings:stored}=await chrome.storage.local.get('settings');s.cacheEnabled=message.cacheEnabled;await chrome.storage.local.set({settings:{...(stored||s),cacheEnabled:message.cacheEnabled}});await invalidate();const config=await currentConfig(s);await broadcast(config);return {ok:true,config};});
  if(message.type==='GAME_CACHE_GET')return locked(async()=>{if(!isGame(sender))throw appError('BAD_REQUEST','게임 프레임 전용 요청입니다.');const s=await settings();assertGameCacheScope(message,s);const id=await cacheId(s.target,message.source);return {ok:true,...await editor.get({id})};});
  if(message.type==='GAME_CACHE_EDIT_SAVE')return locked(async()=>{if(!isGame(sender))throw appError('BAD_REQUEST','게임 프레임 전용 요청입니다.');const s=await settings();assertGameCacheScope(message,s);if(Object.hasOwn(message,'create')&&typeof message.create!=='boolean')throw appError('VALIDATION',undefined,false);try{return await saveCacheEdit(message);}catch(e){if(e?.code==='INVALID')throw appError('VALIDATION',undefined,false);throw e;}});
  if(!isAdmin(sender))throw Error('확장 설정 화면 전용 요청입니다.');
  if(message.type==='GET_ACTIVE_STATUS'||message.type==='RETRY_FAILED'){
    const [active]=await chrome.tabs.query({active:true,currentWindow:true});
    const targetId=sender.tab?.id===active?.id?([...gameTabs].sort((a,b)=>b[1]-a[1])[0]?.[0]||active?.id):active?.id;
    if(!targetId)return {ok:true,found:false,status:{},notice:'게임 탭을 열고 아이콘을 눌러 주세요.',cacheHits:0,queued:0};
    try{const result=await chrome.tabs.sendMessage(targetId,{type:message.type==='RETRY_FAILED'?'RETRY_FAILED':'GET_ENGINE_STATUS'});if(!result?.ok)throw Error('No game frame');if(message.type==='RETRY_FAILED')return {ok:true};return {ok:true,found:true,status:result.status||{},notice:String(result.notice||'').slice(0,350),cacheHits:Number(result.cacheHits)||0,queued:Number(result.queued)||0,retrying:Number(result.retrying)||0,lastErrorCode:String(result.lastErrorCode||''),nextRetryAt:Number(result.nextRetryAt)||0,attempts:Number(result.attempts)||0,failed:Number(result.failed)||0};}
    catch{if(message.type==='RETRY_FAILED')throw appError('BAD_REQUEST','게임 탭에서 다시 시도하세요.');return {ok:true,found:false,status:{},notice:'게임 탭이 아니거나 새로고침이 필요합니다.',cacheHits:0,queued:0};}
  }
  if(message.type==='GET_SETTINGS'){return {ok:true,version:VERSION,capabilities:{playerNames:true,cacheClear:true,warningImports:true,backlogReuse:true,storyAutoAdvance:true,recorderRecovery:true},settings:await settings(),usage:await getUsage(),cacheCount:await cache.count()};}
  if(message.type==='CHATGPT_AUTH_REBIND'){
    const profileId=message.profileId;
    if(profileId!==undefined&&(typeof profileId!=='string'||!profileId||profileId.length>200))throw appError('BAD_REQUEST');
    if(Object.hasOwn(message,'newProfile')&&typeof message.newProfile!=='boolean')throw appError('BAD_REQUEST');
    if(profileId&&message.newProfile===true)throw appError('BAD_REQUEST');
    if(!await chrome.permissions.contains({permissions:['nativeMessaging']}))throw appError('NATIVE_PERMISSION_REQUIRED');
    if(pendingMap.size)return {ok:true,state:{available:false,connected:false,planEnabled:false,loginPending:false,profiles:[],errorCode:'NATIVE_RELOAD_BUSY'}};
    if(!chrome.storage.session?.set)throw appError('NATIVE_RELOAD_REQUIRED');
    const params={...(profileId?{profileId}:{}),...(message.newProfile===true?{newProfile:true}:{})};
    await chrome.storage.session.set({chatgptAuthResume:{params,expiresAt:Date.now()+120000}});
    nativeReloadPending=true;
    setTimeout(()=>chrome.runtime.reload(),100);
    return {ok:true,reloading:true};
  }
  if(message.type==='CHATGPT_AUTH_STATUS')return {ok:true,state:await chatgpt.status()};
  if(message.type==='CHATGPT_MODEL_LIST')return {ok:true,models:await chatgpt.models()};
  if(['CHATGPT_AUTH_START','CHATGPT_AUTH_CANCEL','CHATGPT_AUTH_SELECT','CHATGPT_AUTH_LOGOUT'].includes(message.type)){
    const profileId=message.profileId;
    if(profileId!==undefined&&(typeof profileId!=='string'||!profileId||profileId.length>200))throw appError('BAD_REQUEST');
    if(message.type==='CHATGPT_AUTH_SELECT'&&!profileId)throw appError('BAD_REQUEST');
    if(Object.hasOwn(message,'newProfile')&&(message.type!=='CHATGPT_AUTH_START'||typeof message.newProfile!=='boolean'))throw appError('BAD_REQUEST');
    if(message.type==='CHATGPT_AUTH_START'&&message.newProfile===true&&profileId)throw appError('BAD_REQUEST');
    if(message.type==='CHATGPT_AUTH_CANCEL'&&profileId!==undefined)throw appError('BAD_REQUEST');
    const methods={CHATGPT_AUTH_START:'LOGIN_START',CHATGPT_AUTH_CANCEL:'LOGIN_CANCEL',CHATGPT_AUTH_SELECT:'SELECT_PROFILE',CHATGPT_AUTH_LOGOUT:'LOGOUT'};
    const s=await settings();
    if(s.provider==='chatgpt'&&message.type!=='CHATGPT_AUTH_CANCEL')await invalidate();
    const params=message.type==='CHATGPT_AUTH_START'?{...(profileId?{profileId}:{}),...(message.newProfile===true?{newProfile:true}:{})}:profileId?{id:profileId}:{};
    const state=await chatgpt.auth(methods[message.type],params);
    if(s.provider==='chatgpt')await broadcast(await currentConfig(s));
    return {ok:true,state};
  }
  if(message.type==='SAVE_SETTINGS')return locked(async()=>{const s=sanitizeSettings(message.settings);if(s.enabled)assertReady(s);if(!s.cacheOnly&&s.provider!=='chatgpt')await assertPermission(s.endpoint);if(s.enabled&&!s.cacheOnly&&s.provider==='chatgpt'){const state=await chatgpt.status();if(!state.available)throw appError(state.errorCode==='NATIVE_PERMISSION_REQUIRED'?'NATIVE_PERMISSION_REQUIRED':'HELPER_UNAVAILABLE');if(!state.connected||state.loginPending)throw appError('AUTH_REQUIRED');if(!state.planEnabled)throw appError('PLAN_PERMISSION_REQUIRED');}await chrome.storage.local.set({settings:s});await invalidate();await broadcast(await currentConfig(s));return {ok:true,settings:s};});
  if(message.type==='LIST_MODELS')return listModels(sanitizeSettings(message.settings));
  if(message.type==='TEST')return (async()=>{const s=sanitizeSettings(message.settings);if(s.cacheOnly)throw Error('AI 연결 테스트는 캐시 전용 모드를 끈 뒤 실행하세요.');const answer=await translate([{id:'test',source:'攻撃力が10%上昇する。',context:'connection test'}],s,{test:true});if(answer.results[0]?.error)throw appError(answer.results[0].code||'BAD_REQUEST',answer.results[0].error,!!answer.results[0].retryable,answer.results[0]);return {ok:true,text:answer.results[0]?.text,usage:answer.usage};})();
  if(message.type==='CACHE_SEARCH')return {ok:true,...await editor.search({query:message.query??'',target:message.target,mode:message.mode??'contains',cursor:message.cursor??null,limit:message.limit??20})};
  if(message.type==='CACHE_GET')return {ok:true,...await editor.get({id:message.id})};
  if(message.type==='CACHE_EDIT_SAVE')return locked(()=>saveCacheEdit(message));
  if(message.type==='CACHE_ENTRY_DELETE')return locked(async()=>{const result=await editor.remove({id:message.id,source:message.source,target:message.target,expectedUpdatedAt:message.expectedUpdatedAt,expectedText:message.expectedText});const info=failure(appError('CANCELLED'));for(const job of pendingMap.values())if(relatedJob(job,result))settle(job,{error:info.message,...info});await broadcastDelete(result);return {ok:true,...result};});
  if(message.type==='EXPORT_START')return {ok:true,...await transfers.exportStart()};
  if(message.type==='EXPORT_PAGE')return {ok:true,...await transfers.exportNext({token:message.token,cursor:message.cursor})};
  if(message.type==='EXPORT_END')return {ok:true,...await transfers.exportEnd(message.token)};
  if(message.type==='IMPORT_START')return {ok:true,...await transfers.importStart(message.mode||'merge',{conflictPolicy:message.conflictPolicy})};
  if(message.type==='IMPORT_BATCH')return {ok:true,...await transfers.importStage(message.token,message.entries)};
  if(message.type==='IMPORT_ABORT')return {ok:true,...await transfers.importAbort(message.token)};
  if(message.type==='IMPORT_COMMIT')return locked(async()=>{const result=await transfers.importCommit(message.token,message.header,{expectedCount:message.expectedCount});await invalidate();await storageCleaned();await broadcast(await currentConfig(await settings()));return {ok:true,...result};});
  if(message.type==='DELETE_OLDEST'){const count=message.count??message.amount;if(!Number.isSafeInteger(count)||count<1)throw appError('BAD_REQUEST','삭제 개수는 1 이상의 안전한 정수여야 합니다.');return locked(async()=>{const result=await cache.deleteOldest(count);await storageCleaned();return {ok:true,...result};});}
  if(message.type==='EXPORT_CACHE')return locked(async()=>({ok:true,...await cache.export()}));
  if(message.type==='IMPORT_CACHE')return locked(async()=>{const result=await cache.import(message.data,message.mode||'merge',{conflictPolicy:message.conflictPolicy});await invalidate();await storageCleaned();await broadcast(await currentConfig(await settings()));return {ok:true,...result};});
  if(message.type==='CLEAR_CACHE')return locked(async()=>{if(message.confirmed!==true)throw appError('BAD_REQUEST','캐시 전체 초기화에는 명시적인 확인이 필요합니다.');const result=await cache.clear();await invalidate();await storageCleaned();await broadcast(await currentConfig(await settings()));return {ok:true,...result};});
  if(message.type==='RESET_USAGE')return locked(async()=>{await chrome.storage.local.set({usage:{date:today(),chars:0,requests:0}});return {ok:true};});
  throw Error('알 수 없는 요청입니다.');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message?.target==='network-offscreen')return false;handle(message,sender).then(reply).catch(async e=>{if(typeof message?.type==='string'&&message.type.startsWith('DISTRIBUTION_')){reply(distributionErrorResponse(e));return;}let s={};try{s=await settings();}catch{}// Never return unsanitized upstream response bodies or credentials.
  if(e.code==='STORAGE')e=appError('STORAGE_FULL');
  const supplied=message?.settings;let safe=redact(e.message,s);if(supplied)safe=redact(safe,{apiKey:String(supplied.apiKey||'')});const info=failure(e);reply({ok:false,error:safe,...info});});return true;});
chrome.runtime.onInstalled.addListener(async()=>{await accessReady;const {settings:s}=await chrome.storage.local.get('settings');if(!s){await chrome.storage.local.set({settings:{...DEFAULTS}});}});
// Only explicit login arms this short-lived intent; no OAuth credentials are stored here.
(async()=>{if(!chrome.storage.session?.get)return;const {chatgptAuthResume:v}=await chrome.storage.session.get('chatgptAuthResume');if(!v)return;await chrome.storage.session.remove('chatgptAuthResume');const p=v.params;if(!Number.isFinite(v.expiresAt)||v.expiresAt<=Date.now()||v.expiresAt>Date.now()+120000||!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['profileId','newProfile'].includes(k))||(p.profileId!==undefined&&(typeof p.profileId!=='string'||!p.profileId||p.profileId.length>200))||(p.newProfile!==undefined&&typeof p.newProfile!=='boolean')||(p.profileId&&p.newProfile===true))return;if(typeof chrome.runtime.connectNative==='function')await chatgpt.auth('LOGIN_START',p);})().catch(()=>{});
