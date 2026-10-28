/* ISOLATED recording transport. No path/handle/credentials cross the MAIN boundary. */
(()=>{'use strict';const KEY=Symbol.for('crave-ai-distribution-client.v1');if(window[KEY])return;
function create({runtime,send,getConfig}){
 let state={status:'idle',count:0},closed=false,unloading=false,initial=true,busy=false,capable=false,apiReady=false,updateRequired=false,lastSent='',sequence=0,captureVersion=0,pendingBytes=0,error='';
 let errorCode='',errorSummary='',errorDetails;
 const failures={
  CACHE_MISSING:['개인 캐시 항목 없음','개인 캐시에 원본 항목이 없어 배포 기록에서 제외되었습니다.'],
  TEXT_CHANGED:['화면·캐시 번역 불일치','화면 번역이 현재 개인 캐시와 달라 배포 기록에서 제외되었습니다.'],
  CAPTURE_SKIPPED:['캐시 누락·번역 불일치','개인 캐시 누락 또는 번역 변경으로 일부 배포 기록이 제외되었습니다.'],
  QUOTA:['저장 공간 부족','배포 기록 저장 공간이 부족합니다. 개인 캐시는 유지됩니다.'],
  STORAGE:['배포 기록 저장 실패','배포 기록을 저장하지 못했습니다. 개인 캐시는 유지됩니다.'],
  UNAVAILABLE:['기록 저장소 사용 불가','안전한 배포 기록 저장소를 사용할 수 없습니다.'],
  INVALID_ENTRY:['캐시 항목 검증 실패','배포 기록할 캐시 항목이 검증을 통과하지 못했습니다.'],
  TARGET_MISMATCH:['기록 언어 불일치','배포 기록 언어와 현재 문구의 언어가 다릅니다.'],
  BATCH_LIMIT:['기록 전송 한도 초과','한 번에 배포 기록할 문구의 수나 크기를 초과했습니다.'],
  STALE_SESSION:['기록 세션 변경','배포 기록 상태가 바뀌었습니다. 저장 창에서 확인하세요.'],
  FROZEN:['기록 종료됨','종료된 배포 기록에는 문구를 추가할 수 없습니다.'],
  OWNER_MISMATCH:['다른 게임에서 기록 중','다른 게임 탭 또는 프레임에서 배포 기록 중입니다.'],
  FORBIDDEN:['기록 요청 권한 없음','이 화면에서는 배포 기록 요청을 사용할 수 없습니다.'],
  INVALID_STATE:['기록 상태 확인 필요','현재 배포 기록 상태에서는 이 작업을 할 수 없습니다.'],
  INVALID_INTENT:['저장 창 만료','저장 창이 만료되었습니다. 게임에서 다시 열어 주세요.'],
  INVALID_FILE_NAME:['파일 이름 확인 필요','255자 이하의 .ndjson 또는 .jsonl 파일 이름을 선택하세요.'],
  INVALID_SELECTION:['저장 파일 선택 필요','저장할 파일을 다시 선택하세요.'],
  ACTIVE_SESSION:['기존 기록 저장 필요','기존 배포 기록을 먼저 Finish로 저장하세요.'],
  INVALID_CURSOR:['기록 페이지 요청 오류','배포 기록 파일의 페이지 요청이 올바르지 않습니다.'],
  UNKNOWN_ACTION:['알 수 없는 기록 요청','알 수 없는 배포 기록 요청입니다.'],
  CANCELLED:['확장 새로고침 필요','확장 프로그램을 다시 로드한 뒤 게임을 새로고침하세요.'],
  STATUS_FAILED:['기록 상태 확인 실패','배포 기록 상태를 확인하지 못했습니다.'],
  HANDSHAKE_REQUIRED:['게임 새로고침 필요','게임 새로고침 후 배포 기록을 사용할 수 있습니다.'],
  PENDING_LIMIT:['기록 대기 한도 초과','배포 기록 대기가 너무 많아 일부 항목이 누락될 수 있습니다.'],
  OPEN_FAILED:['저장 창 열기 실패','저장 위치 선택 창을 열지 못했습니다. 기존 배포 기록이 남아 있는지 확인하세요.'],
  FINISH_FAILED:['기록 종료 확인 실패','배포 Finish를 완료하지 못했습니다. 수집된 기록은 남아 있으니 다시 시도하세요.']
 };
 function clearError(){error='';errorCode='';errorSummary='';errorDetails=undefined;}
 function setFailure(value,fallback='STORAGE'){
  const code=Object.hasOwn(failures,value?.code)?value.code:fallback,description=failures[code];errorCode=code;errorSummary=description[0];errorDetails=undefined;
  const reasons=value?.details?.skipReasons||value?.session?.errorDetails?.skipReasons,skipReasons={};for(const key of ['CACHE_MISSING','TEXT_CHANGED'])if(Number.isSafeInteger(reasons?.[key])&&reasons[key]>0)skipReasons[key]=reasons[key];
  const counts=[];if(skipReasons.CACHE_MISSING)counts.push('캐시 없음 '+skipReasons.CACHE_MISSING+'건');if(skipReasons.TEXT_CHANGED)counts.push('번역 변경 '+skipReasons.TEXT_CHANGED+'건');if(counts.length)errorDetails={skipReasons};
  error=description[1]+(counts.length?' ('+counts.join(', ')+')':'')+' ['+code+']';
 }
 function failure(){return Object.assign(Error(error||'배포 기록 상태가 바뀌었습니다.'),{code:errorCode||'STALE_SESSION',summary:errorSummary||'기록 상태 변경',...(errorDetails?{details:errorDetails}:{})});}
 function applySession(next){
  const changed=next?.id!==state.id;state=next||{status:'idle',count:0};
  if(changed||errorCode==='STATUS_FAILED')clearError();
  if(['saved','discarded','aborted','idle'].includes(state.status)){clearError();return;}
  if(state.errorCode){const code=Object.hasOwn(failures,state.errorCode)?state.errorCode:'STORAGE';if(!error||code!=='STORAGE')setFailure({code,details:state.errorDetails||(code===errorCode?errorDetails:undefined)});}
 }
 let chain=Promise.resolve(),timer=null,flushTimer=null;const listeners=new Set(),pending=new Map(),outbound=new Set(),acks=new Map(),encoder=new TextEncoder();
 const notify=()=>{const s=getState();for(const fn of listeners)fn(s);};
 function getState(){return {...state,status:updateRequired?'update-required':apiReady?state.status:'checking',reason:updateRequired?'UPDATE_REQUIRED':state.reason,busy,capable,error:updateRequired?'배포 기록 확장 업데이트가 필요합니다. 확장 프로그램을 다시 로드한 뒤 게임을 새로고침하세요.':error,errorCode:updateRequired?'UPDATE_REQUIRED':errorCode,errorSummary:updateRequired?'확장 업데이트 필요':errorSummary,errorDetails};}
 function sync(force=false){if(closed||unloading)return;const c=getConfig()||{},active=apiReady&&state.status==='recording'&&state.target===c.target;const key=JSON.stringify([active,state.id,c.target]);if(!force&&key===lastSent)return;lastSent=key;const requestId='d'+(++sequence);send('RECORDING_STATE',{active,id:active?state.id:null,requestId});const t=setTimeout(()=>{acks.delete(requestId);if(!capable){if(!error)setFailure({code:'HANDSHAKE_REQUIRED'});notify();}},3000);acks.set(requestId,{timer:t});}
 async function poll(){if(closed||unloading)return;try{const r=await runtime({type:'DISTRIBUTION_STATUS',initial});if(!r||r.ok===false)throw r||Error('Status failed');if(closed||unloading)return;if(r.apiVersion!==2){apiReady=false;updateRequired=true;sync();notify();return;}apiReady=true;updateRequired=false;initial=false;applySession(r.session);if(state.status==='busy')state={status:'other',count:0,reason:state.reason==='OWNER_ACTIVE'?'OWNER_ACTIVE':'OWNER_UNCONFIRMED'};sync();if(pending.size)scheduleFlush();notify();}catch(e){if(closed||unloading)return;if(!error||errorCode==='STATUS_FAILED')setFailure(e,'STATUS_FAILED');notify();}}
 function scheduleFlush(){if(flushTimer||closed||unloading)return;flushTimer=setTimeout(()=>{flushTimer=null;void flush();},50);}
 function flush(){if(closed||unloading||!apiReady||!pending.size)return chain;const id=pending.values().next().value.id,entries=[];let bytes=1;for(const [source,x]of pending){if(x.id!==id)continue;if(entries.length>=32||(entries.length&&bytes+x.bytes>512*1024))break;pending.delete(source);pendingBytes-=x.bytes;bytes+=x.bytes;entries.push(x);}if(!entries.length)return chain;
  const batch={id,entries};outbound.add(batch);
  const work=async()=>{if(closed||unloading)return;if(!apiReady){for(const x of entries){const key=id+'|'+x.item.source,prior=pending.get(key);if(prior&&prior.version>=x.version)continue;if(prior)pendingBytes-=prior.bytes;pending.set(key,x);pendingBytes+=x.bytes;}outbound.delete(batch);return;}try{const r=await runtime({type:'DISTRIBUTION_CAPTURE',id,items:entries.map(x=>x.item)});if(!r||r.ok===false)throw r||Error('Capture failed');outbound.delete(batch);for(const older of outbound){if(older.id!==id)continue;older.entries=older.entries.filter(x=>!entries.some(ack=>ack.item.source===x.item.source&&ack.version>=x.version));if(!older.entries.length)outbound.delete(older);}if(closed||unloading)return;if(r.session?.id===state.id)applySession(r.session);if(r.skipped>0)setFailure({code:r.skipReasons?.CACHE_MISSING&&r.skipReasons?.TEXT_CHANGED?'CAPTURE_SKIPPED':r.skipReasons?.CACHE_MISSING?'CACHE_MISSING':r.skipReasons?.TEXT_CHANGED?'TEXT_CHANGED':'CAPTURE_SKIPPED',details:{skipReasons:r.skipReasons}});notify();}catch(e){if(closed||unloading)return;if(e?.session?.id===state.id)applySession(e.session);setFailure(e);notify();}};
  chain=chain.then(work,work);if(pending.size)scheduleFlush();return chain;
 }
 async function drain(){while(pending.size&&!closed&&!unloading&&apiReady){await flush();}await chain;}
 async function flushForAdvance(){const id=state.id;if(closed||unloading||!apiReady)throw failure();if(state.status!=='recording'){if(busy||error||['ready','other','busy'].includes(state.status))throw failure();return;}await drain();if(closed||unloading||!apiReady||busy||error||state.status!=='recording'||state.id!==id)throw failure();}
 function capture(m){if(closed||unloading||!apiReady||state.status!=='recording'||m.id!==state.id||m.target!==state.target)return;const x=m.item;if(!x||typeof x.source!=='string'||!x.source.trim()||x.source.length>8192||typeof x.text!=='string'||!x.text.trim()||x.text.length>50000)return;
  const item={source:x.source,text:x.text,target:m.target},bytes=encoder.encode(JSON.stringify(item)).byteLength+1;if(bytes>1024*1024){setFailure({code:'BATCH_LIMIT'});notify();return;}
  const key=state.id+'|'+x.source,old=pending.get(key);if((!old&&pending.size>=512)||pendingBytes-(old?.bytes||0)+bytes>8*1024*1024){setFailure({code:'PENDING_LIMIT'});notify();void flush();return;}if(old)pendingBytes-=old.bytes;pending.set(key,{item,bytes,id:state.id,version:++captureVersion});pendingBytes+=bytes;scheduleFlush();
 }
 function onPageHide(){
  if(closed||unloading)return;unloading=true;clearInterval(timer);clearTimeout(flushTimer);flushTimer=null;
  if(!apiReady||state.status!=='recording')return;
  // Queued and in-flight batches still belong to this document until acknowledged.
  // Replay oldest first, letting buffered revisions replace older source snapshots.
  const latest=new Map();for(const batch of outbound)if(batch.id===state.id)for(const x of batch.entries){const prior=latest.get(x.item.source);if(!prior||prior.version<x.version)latest.set(x.item.source,x);}for(const x of pending.values())if(x.id===state.id)latest.set(x.item.source,x);
  let partial=!!error,items=[],bytes=1;
  const dispatch=message=>{try{Promise.resolve(runtime(message)).catch(()=>{});}catch{partial=true;}};
  const replay=()=>{if(!items.length)return;dispatch({type:'DISTRIBUTION_CAPTURE',id:state.id,items});items=[];bytes=1;};
  for(const x of latest.values()){if(items.length>=32||(items.length&&bytes+x.bytes>512*1024))replay();items.push(x.item);bytes+=x.bytes;}replay();
  pending.clear();pendingBytes=0;outbound.clear();
  dispatch({type:'DISTRIBUTION_FINISH_ON_UNLOAD',id:state.id,partial});
 }
 function onMessage(event){if(event.source!==window||event.origin!==location.origin)return;const m=event.data;if(!m||m.channel!=='crave-ai-translator/v1'||m.from!=='engine')return;
  if(m.type==='RECORD_TEXT'){capture(m);return;}
  if(m.type==='RECORDING_ACK'&&typeof m.requestId==='string'){const a=acks.get(m.requestId);if(!a)return;clearTimeout(a.timer);acks.delete(m.requestId);capable=true;if(a.resolve)a.resolve();notify();}
 }
 function stopMain(){return new Promise((resolve,reject)=>{const requestId='d'+(++sequence),t=setTimeout(()=>{acks.delete(requestId);reject(Error('기록 종료 확인 실패. 게임을 새로고침한 뒤 다시 시도하세요.'));},3000);acks.set(requestId,{timer:t,resolve});send('RECORDING_STATE',{active:false,id:null,requestId});lastSent='stopped';});}
 async function start(){if(busy||closed||unloading)return;if(!apiReady||['recording','ready','other','busy'].includes(state.status)){notify();return;}if(!capable){setFailure({code:'HANDSHAKE_REQUIRED'});notify();return;}busy=true;clearError();notify();try{const r=await runtime({type:'DISTRIBUTION_OPEN',action:'start'});if(r?.ok===false)throw r;await poll();}catch(e){setFailure(e,'OPEN_FAILED');}finally{busy=false;notify();}}
 async function finish(){if(busy||closed||unloading||!apiReady||!['recording','ready'].includes(state.status))return;const priorError=error;busy=true;notify();try{if(state.status==='recording')await stopMain();await drain();if(closed||unloading||!apiReady)return;const r=await runtime({type:'DISTRIBUTION_OPEN',action:'finish',id:state.id,partial:!!(priorError||error)});if(r?.ok===false)throw r;await poll();}catch(e){if(!error)setFailure(e,'FINISH_FAILED');}finally{busy=false;notify();}}
 window.addEventListener('message',onMessage);window.addEventListener('pagehide',onPageHide);void poll();timer=setInterval(poll,2000);
 return {getState,flushForAdvance,subscribe(fn){listeners.add(fn);fn(getState());return()=>listeners.delete(fn);},start,finish,update(){sync();},dispose(){closed=true;clearInterval(timer);clearTimeout(flushTimer);for(const a of acks.values())clearTimeout(a.timer);acks.clear();pending.clear();outbound.clear();window.removeEventListener('message',onMessage);window.removeEventListener('pagehide',onPageHide);listeners.clear();}};
}
window[KEY]=Object.freeze({create});})();
