// Recorder-only authority boundary. No settings writes, provider calls or personal-cache writes.
import {createDistributionStore} from './distribution-store.mjs';
import {cacheId,portableEntry,validatePortableEntries,byteSize,CACHE_FORMAT} from './cache.mjs';
import {VERSION} from './core.mjs';
const TTL=10*60*1000, DEST='distributionDestination', PREFIX='distributionIntent:', AUTO='distributionAutoFinish:';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const active=s=>s&&['recording','ready'].includes(s.status);
const same=(a,b)=>a?.tabId===b?.tabId&&a?.frameId===b?.frameId;
const fail=code=>{throw Object.assign(new Error('Recorder request failed'),{code});};
const messages={FORBIDDEN:'이 화면에서는 녹화 요청을 사용할 수 없습니다.',INVALID_INTENT:'녹화 창이 만료되었습니다. 게임에서 다시 열어 주세요.',INVALID_FILE_NAME:'255자 이하의 .ndjson 또는 .jsonl 파일 이름을 선택하세요.',INVALID_SELECTION:'저장할 파일을 다시 선택하세요.',ACTIVE_SESSION:'기존 녹화를 먼저 저장하거나 삭제해 주세요.',OWNER_MISMATCH:'다른 게임 프레임에서 녹화 중입니다.',STALE_SESSION:'녹화 상태가 바뀌었습니다. 게임에서 다시 열어 주세요.',FROZEN:'녹화가 종료되어 더 이상 추가할 수 없습니다.',TARGET_MISMATCH:'녹화 언어와 현재 문구의 언어가 다릅니다.',INVALID_ENTRY:'녹화할 캐시 항목이 올바르지 않습니다.',BATCH_LIMIT:'한 번에 녹화할 문구의 수나 크기를 초과했습니다.',QUOTA:'저장 공간이 부족합니다. 개인 캐시는 변경하지 않았습니다.',UNAVAILABLE:'안전한 녹화 저장소를 사용할 수 없습니다.',STORAGE:'녹화를 저장하지 못했습니다. 다시 시도해 주세요.',INVALID_STATE:'현재 녹화 상태에서는 이 작업을 할 수 없습니다.',INVALID_CURSOR:'녹화 파일의 페이지 요청이 올바르지 않습니다.',UNKNOWN_ACTION:'알 수 없는 녹화 요청입니다.'};
const captureMessages={CACHE_MISSING:'개인 캐시에 원본 항목이 없어 기록하지 못했습니다.',TEXT_CHANGED:'화면 번역과 개인 캐시가 달라 기록하지 못했습니다.',CAPTURE_SKIPPED:'개인 캐시 누락 또는 번역 변경으로 기록하지 못했습니다.'};
Object.assign(messages,captureMessages);
function safeDetails(value){const reasons=value?.skipReasons;if(!reasons)return undefined;const skipReasons={};for(const code of ['CACHE_MISSING','TEXT_CHANGED'])if(Number.isSafeInteger(reasons[code])&&reasons[code]>0)skipReasons[code]=reasons[code];return Object.keys(skipReasons).length?{skipReasons}:undefined;}
export function distributionErrorResponse(e){const code=Object.hasOwn(messages,e?.code)?e.code:'STORAGE';return {ok:false,code,error:messages[code],retryable:['QUOTA','STORAGE','UNAVAILABLE'].includes(code),...(e?.distributionSession?{session:e.distributionSession}:{})};}
function fileName(value){if(typeof value!=='string'||!value.trim()||value.length>255||/[\\/:\x00-\x1f\x7f-\x9f]/.test(value)||!/^.+\.(ndjson|jsonl)$/i.test(value))fail('INVALID_FILE_NAME');return value;}
function ownerOf(sender){const owner={tabId:sender?.tab?.id,frameId:sender?.frameId};if(!Number.isSafeInteger(owner.tabId)||owner.tabId<0||!Number.isSafeInteger(owner.frameId)||owner.frameId<0)fail('FORBIDDEN');return owner;}
export function createDistributionBroker({chrome,cache,editor,settings,isGame,store:providedStore}={}){
  let instance=providedStore,serial=Promise.resolve();const errors=new Map();
  const store=()=>instance??=createDistributionStore();
  const locked=fn=>{const next=serial.then(fn,fn);serial=next.catch(()=>{});return next;};
  const windowRole=sender=>sender?.id===chrome.runtime.id&&sender.frameId===0&&typeof sender.url==='string'&&sender.url.split(/[?#]/)[0]===chrome.runtime.getURL('distribution.html');
  function sessionStorage(){const area=chrome.storage.session;if(!area?.get||!area?.set||!area?.remove)fail('UNAVAILABLE');return area;}
  async function destination(s){const value=(await chrome.storage.local.get(DEST))[DEST];return value?.id===s.id&&uuid(value.selectionId)?value:null;}
  async function view(s,withSelection=false){if(!s||s.status==='idle')return {status:'idle',count:0};const result={status:s.status,id:s.id,count:s.count,fileName:s.fileName,target:s.target,createdAt:s.createdAt};try{const saved=(await chrome.storage.local.get('distributionError')).distributionError;if(!errors.has(s.id)&&saved?.id===s.id&&Object.hasOwn(messages,saved.code))errors.set(s.id,{code:saved.code,...(safeDetails(saved.details)?{details:safeDetails(saved.details)}:{})});}catch{}if(errors.has(s.id)){const failure=errors.get(s.id);result.code=result.errorCode=failure.code;if(failure.details)result.errorDetails=failure.details;result.warning='PARTIAL_RECORDING';}if(withSelection){try{const d=await destination(s);if(d){result.selectionId=d.selectionId;result.fileName=d.fileName;}}catch{result.warning='DESTINATION_UNAVAILABLE';}}return result;}
  async function current(owner){const s=await store().status();if(s.status==='idle')return s;if(!same(s.owner,owner)){if(active(s))fail('OWNER_MISMATCH');return {status:'idle',count:0};}return s;}
  async function bound(intent,id){if(typeof intent.id!=='string'||(id!==undefined&&id!==intent.id))fail('STALE_SESSION');const s=await current(intent.owner);if(s.id!==intent.id)fail('STALE_SESSION');return s;}
  async function readIntent(message,sender){if(!windowRole(sender))fail('FORBIDDEN');if(!uuid(message.intent))fail('INVALID_INTENT');let url;try{url=new URL(sender.url);}catch{fail('FORBIDDEN');}if(url.searchParams.get('intent')!==message.intent)fail('INVALID_INTENT');const area=sessionStorage(),key=PREFIX+message.intent,intent=(await area.get(key))[key];const now=Date.now();if(!intent||!['start','finish'].includes(intent.action)||!Number.isFinite(intent.expiresAt)||intent.expiresAt<=now||intent.expiresAt>now+TTL||!Number.isSafeInteger(intent.owner?.tabId)||intent.owner.tabId<0||!Number.isSafeInteger(intent.owner?.frameId)||intent.owner.frameId<0)fail('INVALID_INTENT');return intent;}
  async function saveIntent(nonce,intent){await sessionStorage().set({[PREFIX+nonce]:intent});}
  async function metadata(s,message){fileName(message.fileName);if(!uuid(message.selectionId))fail('INVALID_SELECTION');try{await chrome.storage.local.set({[DEST]:{id:s.id,selectionId:message.selectionId,fileName:message.fileName}});return {session:await view(s,true)};}catch{return {session:await view(s),warning:'DESTINATION_UNAVAILABLE'};}}
  async function partial(s,code,details){if(!code){await view(s);if(errors.has(s.id))return;}const failure={code:Object.hasOwn(messages,code)?code:'STORAGE',...(safeDetails(details)?{details:safeDetails(details)}:{})};errors.set(s.id,failure);try{await chrome.storage.local.set({distributionError:{id:s.id,...failure}});}catch{}}
  async function ownerPresence(s){
    const absent=e=>/^(?:No tab with id:?\s*\d+\.?|Could not establish connection\. Receiving end does not exist\.?|No frame with id \d+ in tab \d+\.?|The frame was removed\.?|Frame with ID \d+ was removed\.?)$/i.test(e?.message??'');
    const owner=s.owner;
    if(!Number.isSafeInteger(owner?.tabId)||owner.tabId<0||!Number.isSafeInteger(owner.frameId)||owner.frameId<0)return 'OWNER_UNCONFIRMED';
    if(typeof chrome.tabs?.get==='function'){
      try{const tab=await chrome.tabs.get(owner.tabId);if(tab?.id!==owner.tabId)return 'OWNER_UNCONFIRMED';}
      catch(e){return /^No tab with id:?\s*\d+\.?$/i.test(e?.message??'')?'absent':'OWNER_UNCONFIRMED';}
    }
    if(typeof chrome.tabs?.sendMessage!=='function')return 'OWNER_UNCONFIRMED';
    try{const reply=await chrome.tabs.sendMessage(owner.tabId,{type:'GET_ENGINE_STATUS'},{frameId:owner.frameId});return reply?.ok===true?'OWNER_ACTIVE':'OWNER_UNCONFIRMED';}
    catch(e){return absent(e)?'absent':'OWNER_UNCONFIRMED';}
  }
  async function openWindow(intent,automatic=false){
    const area=sessionStorage(),nonce=globalThis.crypto.randomUUID(),key=intent.action==='finish'?AUTO+intent.id:null;
    const claimed=key&&!(await area.get(key))[key];
    if(key&&!claimed&&automatic)return;
    if(claimed)await area.set({[key]:true});
    try{
      await saveIntent(nonce,{...intent,...(automatic?{automatic:true}:{})});
      await chrome.windows.create({url:chrome.runtime.getURL('distribution.html')+'?intent='+nonce,type:'popup',width:540,height:500});
    }catch(e){
      try{await area.remove(PREFIX+nonce);}catch{}
      if(claimed)try{await area.remove(key);}catch{}
      throw e;
    }
  }
  async function automaticFinish(s){
    const frozen=await store().finish(s.owner,s.id);
    try{await openWindow({owner:s.owner,action:'finish',id:s.id,expiresAt:Date.now()+TTL},true);}
    catch(e){e.distributionSession=await view(frozen);throw e;}
    return frozen;
  }
  async function dispatch(message,sender){
    if(!message||typeof message.type!=='string'||!message.type.startsWith('DISTRIBUTION_'))fail('UNKNOWN_ACTION');
    const type=message.type;
    if(['DISTRIBUTION_STATUS','DISTRIBUTION_OPEN','DISTRIBUTION_CAPTURE','DISTRIBUTION_FINISH_ON_UNLOAD'].includes(type)){
      if(!isGame?.(sender))fail('FORBIDDEN');const owner=ownerOf(sender);
      if(type==='DISTRIBUTION_STATUS'){
        if(Object.hasOwn(message,'initial')&&typeof message.initial!=='boolean')fail('INVALID_ENTRY');
        let s=await store().status();
        if(s.status!=='idle'&&!same(s.owner,owner)){
          if(!active(s))return {ok:true,apiVersion:2,session:{status:'idle',count:0}};
          const presence=await ownerPresence(s);
          if(presence!=='absent')return {ok:true,apiVersion:2,session:{status:'busy',count:0,reason:presence}};
          if(s.status==='recording')s=await automaticFinish(s);
        }else if(s.status==='recording'&&message.initial===true)s=await automaticFinish(s);
        return {ok:true,apiVersion:2,session:await view(s)};
      }
      if(type==='DISTRIBUTION_FINISH_ON_UNLOAD'){
        if(typeof message.id!=='string'||!message.id||typeof message.partial!=='boolean')fail('INVALID_ENTRY');
        const s=await current(owner);if(s.id!==message.id||!active(s))fail('STALE_SESSION');
        if(message.partial)await partial(s);
        return {ok:true,session:await view(await automaticFinish(s))};
      }
      if(type==='DISTRIBUTION_OPEN'){
        if(!['start','finish'].includes(message.action))fail('UNKNOWN_ACTION');if(Object.hasOwn(message,'partial')&&(typeof message.partial!=='boolean'||message.action!=='finish'))fail('INVALID_ENTRY');
        let action=message.action,s=await store().status();
        if(s.status!=='idle'&&!same(s.owner,owner)){
          if(active(s)){
            if(action!=='finish'||message.id!==s.id||s.status!=='ready'||await ownerPresence(s)!=='absent')fail('OWNER_MISMATCH');
          }else s={status:'idle',count:0};
        }
        if(action==='start'&&s.status==='recording')return {ok:true,opened:false,code:'ACTIVE_SESSION',session:await view(s)};
        if(action==='start'&&s.status==='ready')action='finish';
        if(action==='finish'&&(!active(s)||(message.id!==undefined&&message.id!==s.id)))fail('STALE_SESSION');
        if(message.partial===true){if(message.id!==s.id)fail('STALE_SESSION');await partial(s);}
        const intent={owner:action==='finish'?s.owner:owner,action,expiresAt:Date.now()+TTL,...(action==='finish'?{id:s.id}:{})};
        // Only an explicit expected id can freeze before the trusted window opens.
        if(action==='finish'&&message.id===s.id)s=await store().finish(s.owner,s.id);
        await openWindow(intent);
        return {ok:true,opened:true,...(s.id?{session:await view(s)}:{})};
      }
      const s=await current(owner);if(s.id!==message.id)fail('STALE_SESSION');if(s.status!=='recording')fail('FROZEN');
      try{
        const items=message.items;if(!Array.isArray(items)||items.length>32)fail('BATCH_LIMIT');
        for(const x of items){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['source','text','target'].includes(k))||typeof x.source!=='string'||!x.source.trim()||x.source.length>8192||typeof x.text!=='string'||!x.text.trim()||x.text.length>49152||typeof x.target!=='string'||x.target.length>64)fail('INVALID_ENTRY');if(x.target!==s.target)fail('TARGET_MISMATCH');}
        if(byteSize(items)>1024*1024)fail('BATCH_LIMIT');
        const rows=[],skipReasons={CACHE_MISSING:0,TEXT_CHANGED:0};let skipped=0;
        for(const x of items){const id=await cacheId(x.target,x.source),result=await editor.get({id}),entry=result?.entry;if(!entry){skipped++;skipReasons.CACHE_MISSING++;continue;}if(entry.id!==id||entry.source!==x.source||entry.target!==x.target)fail('INVALID_ENTRY');if(entry.text!==x.text){skipped++;skipReasons.TEXT_CHANGED++;continue;}const portable=portableEntry(entry);try{await validatePortableEntries([portable]);}catch{fail('INVALID_ENTRY');}rows.push(portable);}
        const appended=rows.length?await store().append(owner,rows):s;
        if(skipped)await partial(s,skipReasons.CACHE_MISSING&&skipReasons.TEXT_CHANGED?'CAPTURE_SKIPPED':skipReasons.CACHE_MISSING?'CACHE_MISSING':'TEXT_CHANGED',{skipReasons});
        return {ok:true,session:await view(appended),accepted:rows.length,skipped,skipReasons,added:appended.added??0,upserted:appended.upserted??0};
      }catch(e){await partial(s,Object.hasOwn(messages,e?.code)?e.code:'STORAGE');e.distributionSession=await view(s);throw e;}
    }
    const intent=await readIntent(message,sender);
    if(type==='DISTRIBUTION_WINDOW_GET'){const s=intent.id?await bound(intent):await current(intent.owner);return {ok:true,action:intent.action,automatic:intent.automatic===true,...(s.id?{session:await view(s,true)}:{})};}
    if(type==='DISTRIBUTION_START'){
      if(intent.action!=='start')fail('FORBIDDEN');fileName(message.fileName);if(!uuid(message.selectionId))fail('INVALID_SELECTION');
      if(intent.id){const s=await bound(intent);if(!active(s))fail('INVALID_STATE');return {ok:true,session:await view(s,true)};}
      const previous=await current(intent.owner);if(active(previous))fail('ACTIVE_SESSION');const config=await settings();const s=await store().start({owner:intent.owner,target:config.target,fileName:message.fileName});intent.id=s.id;await saveIntent(message.intent,intent);return {ok:true,...await metadata(s,message)};
    }
    if(type!=='DISTRIBUTION_FREEZE'&&message.id!==intent.id)fail('STALE_SESSION');
    const s=await bound(intent,message.id);
    if(type==='DISTRIBUTION_FREEZE'){if(intent.action!=='finish'||!active(s))fail('INVALID_STATE');const frozen=await store().finish(intent.owner,s.id);return {ok:true,status:'ready',count:frozen.count,session:await view(frozen,true),header:{format:CACHE_FORMAT,version:3,identity:'source-v3',exportedAt:new Date(frozen.finishedAt??Date.now()).toISOString(),appVersion:VERSION}};}
    if(type==='DISTRIBUTION_PAGE'){if(intent.action!=='finish'||s.status!=='ready')fail('INVALID_STATE');return {ok:true,...await store().exportPage({id:s.id,cursor:message.cursor??null,limit:250,maxBytes:1024*1024})};}
    if(type==='DISTRIBUTION_RESELECT'){if(!active(s))fail('INVALID_STATE');return {ok:true,...await metadata(s,message)};}
    if(type==='DISTRIBUTION_SAVED'||type==='DISTRIBUTION_DISCARD'){if(intent.action!=='finish')fail('FORBIDDEN');const done=await store()[type==='DISTRIBUTION_SAVED'?'saved':'discard'](intent.owner,s.id);errors.delete(s.id);try{await chrome.storage.local.remove('distributionError');const d=await destination(done);if(d)await chrome.storage.local.remove(DEST);}catch{}try{await sessionStorage().remove(AUTO+s.id);}catch{}return {ok:true,session:await view(done)};}
    fail('UNKNOWN_ACTION');
  }
  return {handle:(message,sender)=>locked(()=>dispatch(message,sender)),errorResponse:distributionErrorResponse};
}
