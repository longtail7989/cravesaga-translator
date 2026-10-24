import {createDistributionFileStore} from './distribution-files.mjs';
import {checkPortableShape,validatePortableEntries,byteSize} from './cache.mjs';
const MAX_ROWS=250,MAX_BYTES=1024*1024;
const fallbackHeader=()=>({format:'crave-ai-translation-cache',version:3,identity:'source-v3',exportedAt:new Date().toISOString(),appVersion:'0.3.5'});
function headerValue(raw){
  if(raw===undefined)return fallbackHeader();
  const keys=['format','version','identity','exportedAt','appVersion'];
  if(!raw||Object.keys(raw).some(k=>!keys.includes(k))||raw.format!=='crave-ai-translation-cache'||raw.version!==3||raw.identity!=='source-v3'||typeof raw.exportedAt!=='string'||!/^\d{4}-\d\d-\d\dT/.test(raw.exportedAt)||!Number.isFinite(Date.parse(raw.exportedAt))||typeof raw.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(raw.appVersion))throw Error('INVALID_HEADER');
  return Object.fromEntries(keys.map(k=>[k,raw[k]]));
}
export function createDistributionUI({win=globalThis.window,doc=globalThis.document,runtime=globalThis.chrome?.runtime,files=createDistributionFileStore()}={}){
  const node=id=>doc.getElementById(id),button=node('primary');
  const intent=new URLSearchParams(win.location.search).get('intent');
  let session,handle,header,busy=true,mode='loading',closedFile=false,partialApproved=false;
  const status=(text,tone='normal')=>{node('status').textContent=text;node('status').dataset.tone=tone;};
  function action(next,label){mode=next;button.textContent=label;button.disabled=busy||next==='done';}
  function show(s){session=s;node('target').textContent=typeof s.target==='string'?s.target:'확인 중';node('count').textContent=String(s.count??0);node('fileName').textContent=typeof s.fileName==='string'?s.fileName:'선택 전';}
  async function send(type,extra={}){
    const response=await runtime.sendMessage({type,intent,...extra});
    if(!response||response.ok!==true)throw Error('BACKEND_FAILED');
    return response;
  }
  function failure(e,{start=false}={}){
    const cancelled=e?.name==='AbortError';
    status(cancelled?'파일 선택을 취소했습니다. 수집 데이터는 변경하지 않았습니다.':e?.name==='NotAllowedError'?'파일 저장 권한이 없습니다. 권한을 확인한 뒤 다시 시도하세요.':e?.name==='QuotaExceededError'?'저장 공간이 부족합니다. 공간을 확보한 뒤 다시 시도하세요.':start?'Start하지 못했습니다. 저장 파일은 쓰지 않았습니다. 다시 시도하세요.':'저장하지 못했습니다. 수집 데이터는 Finish 대기 상태로 남아 있습니다. 파일·저장 공간·권한을 확인하고 다시 시도하세요.','error');
  }
  function picker(){
    if(typeof win.showSaveFilePicker!=='function')throw Error('NO_FSA');
    return win.showSaveFilePicker({suggestedName:'크레이브-배포-'+new Date().toISOString().slice(0,10)+'.ndjson',types:[{description:'번역 캐시 NDJSON',accept:{'application/x-ndjson':['.ndjson']}}],excludeAcceptAllOption:true});
  }
  function canPick(){if(typeof win.showSaveFilePicker==='function')return true;status('이 브라우저는 파일 위치 선택을 지원하지 않습니다. 지원되는 Chrome 확장 창에서 다시 여세요. 다운로드로 대체하지 않습니다.','error');action('done','파일 선택 미지원');return false;}
  async function selected(promise,isStart){
    let selectionId,accepted=false;
    try{
      const chosen=await promise;selectionId=await files.put(chosen);
      const result=await send(isStart?'DISTRIBUTION_START':'DISTRIBUTION_RESELECT',{...(isStart?{}:{id:session.id}),fileName:chosen.name,selectionId});accepted=true;
      const previous=session?.selectionId;
      if(isStart){show(result.session);node('heading').textContent='수집 중';status('Start 완료. 창을 닫아도 수집은 계속됩니다. 게임에서 Finish를 눌러 저장하세요.');action('done','수집 중 · 창을 닫아도 됩니다');}
      else{
        // Reselect ack need not echo the full session. Identity stays frozen.
        show({...session,...result.session,fileName:chosen.name,selectionId});handle=chosen;
        if(previous&&previous!==selectionId)await files.delete(previous).catch(()=>{});
        await prepareHandle();
      }
    }catch(e){if(selectionId&&!accepted)await files.delete(selectionId).catch(()=>{});failure(e,{start:isStart});action(isStart?'start':'pick',isStart?'저장 위치 선택하고 Start':'저장 위치 다시 선택하고 Finish');}
    finally{busy=false;button.disabled=mode==='done';}
  }
  async function acknowledge(){
    try{await send('DISTRIBUTION_SAVED',{id:session.id});}
    catch{status('파일 쓰기는 완료되었지만 저장 완료 확인에 실패했습니다. 파일이 이미 존재할 수 있습니다. 확인을 다시 시도하세요. 수집 데이터는 보존됩니다.','error');action('ack','저장 완료 확인 다시 시도');return;}
    let cleaned=true;try{await files.delete(session.selectionId);}catch{cleaned=false;}
    status('Finish 완료. '+session.count+'개 항목을 파일에 저장했습니다.'+(cleaned?'':' 로컬 파일 권한 참조 정리에 실패했습니다.'));action('done','저장 완료');
  }
  async function save(){
    let writer;
    try{
      status('배포 파일을 검증하고 저장합니다. 완료될 때까지 이 창을 닫지 마세요.');
      writer=await handle.createWritable({keepExistingData:false});
      await writer.write(JSON.stringify(header)+'\n');
      let cursor=null,count=0,lastId=null;
      for(;;){
        const page=await send('DISTRIBUTION_PAGE',{id:session.id,cursor});
        if(!Array.isArray(page.entries)||page.entries.length>MAX_ROWS||typeof page.done!=='boolean')throw Error('INVALID_PAGE');
        let bytes=0;
        for(const row of page.entries){checkPortableShape(row);if(!/^v3:[a-f0-9]{64}$/.test(row.id)||row.target!==session.target||(lastId!==null&&row.id<=lastId))throw Error('INVALID_ROW');bytes+=byteSize(row)+1;if(bytes>MAX_BYTES)throw Error('PAGE_LIMIT');lastId=row.id;}
        const canonical=await validatePortableEntries(page.entries);
        if(canonical.length!==page.entries.length||canonical.some((row,i)=>row.id!==page.entries[i].id))throw Error('NONCANONICAL_PAGE');
        // Preserve order, context, timestamps and manual:false on validated portable rows.
        for(const row of page.entries){if(++count>session.count)throw Error('COUNT_MISMATCH');await writer.write(JSON.stringify(row)+'\n');}
        node('count').textContent=count+' / '+session.count;
        if(page.done)break;
        if(!page.entries.length||typeof page.cursor!=='string'||!page.cursor||(cursor!==null&&page.cursor<=cursor))throw Error('INVALID_CURSOR');cursor=page.cursor;
      }
      if(count!==session.count)throw Error('COUNT_MISMATCH');
      await writer.write(JSON.stringify({end:true,count})+'\n');await writer.close();writer=undefined;closedFile=true;
      await acknowledge();
    }catch(e){if(writer)try{await writer.abort();}catch{}failure(e);action('permission','파일 저장 권한 확인하고 Finish');}
  }
  async function prepareHandle(){
    if(session.errorCode&&!partialApproved){status('일부 번역을 배포 기록에 저장하지 못했습니다. 개인 캐시는 유지됩니다. 기존 수집분만 파일로 저장할지 확인하세요.','error');action('partial','수집된 항목만 Finish');return;}

    if(!handle){if(canPick()){status('이 브라우저에서 저장 위치를 찾을 수 없습니다. 저장할 파일을 다시 선택하세요. 수집 데이터는 보존됩니다.');action('pick','저장 위치 다시 선택하고 Finish');}return;}
    let permission;try{permission=await handle.queryPermission({mode:'readwrite'});}catch{}
    if(permission==='granted')await save();else{status('수집을 멈췄습니다. 파일 저장 권한을 확인하면 Finish가 완료됩니다.');action('permission','파일 저장 권한 확인하고 Finish');}
  }
  async function freeze(){
    const result=await send('DISTRIBUTION_FREEZE',{...(session?.id?{id:session.id}:{})});
    if(result.status!=='ready'||!result.session||typeof result.session.id!=='string'||!Number.isSafeInteger(result.session.count)||result.session.count<0||(result.count!==undefined&&result.count!==result.session.count))throw Error('INVALID_FREEZE');
    show(result.session);header=headerValue(result.header);node('heading').textContent='Finish · 파일 저장';handle=await files.get(session.selectionId);await prepareHandle();
  }
  async function initialize(){busy=true;button.disabled=true;try{
    if(typeof intent!=='string'||!/^[a-f0-9-]{36}$/i.test(intent))throw Error('INVALID_INTENT');
    const result=await send('DISTRIBUTION_WINDOW_GET');
    if(result.session)show(result.session);
    if(result.action==='start'){node('heading').textContent='배포용 수집 시작';node('description').textContent='저장 위치를 선택하면 새 번역 수집을 시작합니다.';if(canPick()){status('Start에서는 파일을 쓰거나 비우지 않습니다.');action('start','저장 위치 선택하고 Start');}}
    else if(result.action==='finish'){node('description').textContent='수집을 멈추고 배포 파일을 저장합니다.';await freeze();}
    else throw Error('INVALID_ACTION');
  }catch{status('요청 상태를 확인하지 못했습니다. 게임에서 Start 또는 Finish를 다시 열어 주세요.','error');action('done','요청을 다시 열어 주세요');}finally{busy=false;button.disabled=mode==='done';}}
  // Native picker and permission request MUST run synchronously in this trusted click stack.
  button.addEventListener('click',event=>{
    if(!event.isTrusted||busy||mode==='done')return;
    busy=true;button.disabled=true;
    const current=mode;
    if(current==='start'||current==='pick'){
      let promise;try{promise=picker();}catch(e){failure(e,{start:current==='start'});busy=false;button.disabled=false;return;}
      return selected(promise,current==='start');
    }
    if(current==='partial'){partialApproved=true;return prepareHandle().finally(()=>{busy=false;button.disabled=mode==='done';});}
    if(current==='permission'){
      let promise;try{promise=handle.requestPermission({mode:'readwrite'});}catch(e){failure(e);busy=false;button.disabled=false;return;}
      return Promise.resolve(promise).then(async permission=>{if(permission!=='granted'){status('파일 저장 권한이 허용되지 않았습니다. 수집 데이터는 보존됩니다.','error');return;}await save();}).catch(e=>failure(e)).finally(()=>{busy=false;button.disabled=mode==='done';});
    }
    if(current==='ack'&&closedFile)return acknowledge().finally(()=>{busy=false;button.disabled=mode==='done';});
    busy=false;button.disabled=false;
  });
  return {initialize};
}
if(typeof document!=='undefined'&&typeof chrome!=='undefined')createDistributionUI().initialize();
