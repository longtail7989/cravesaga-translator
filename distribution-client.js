/* ISOLATED recording transport. No path/handle/credentials cross the MAIN boundary. */
(()=>{'use strict';const KEY=Symbol.for('crave-ai-distribution-client.v1');if(window[KEY])return;
function create({runtime,send,getConfig}){
 let state={status:'idle',count:0},closed=false,busy=false,capable=false,lastSent='',sequence=0,pendingBytes=0,error='';
 let chain=Promise.resolve(),timer=null,flushTimer=null;const listeners=new Set(),pending=new Map(),acks=new Map(),encoder=new TextEncoder();
 const notify=()=>{const s=getState();for(const fn of listeners)fn(s);};
 function getState(){return {...state,busy,capable,error};}
 function sync(force=false){const c=getConfig()||{},active=state.status==='recording'&&state.target===c.target;const key=JSON.stringify([active,state.id,c.target]);if(!force&&key===lastSent)return;lastSent=key;const requestId='d'+(++sequence);send('RECORDING_STATE',{active,id:active?state.id:null,requestId});const t=setTimeout(()=>{acks.delete(requestId);if(!capable){error='게임 새로고침 후 배포 기록을 사용할 수 있습니다.';notify();}},3000);acks.set(requestId,{timer:t});}
 async function poll(){if(closed)return;try{const r=await runtime({type:'DISTRIBUTION_STATUS'});state=r.session||{status:'idle',count:0};if(state.status==='busy')state={status:'other',count:0};if(state.errorCode)error='일부 배포 기록을 저장하지 못했습니다. Finish 전에 저장 창에서 확인하세요.';else if(['saved','discarded','aborted','idle'].includes(state.status))error='';sync();notify();}catch{error='배포 기록 상태를 확인하지 못했습니다.';notify();}}
 function scheduleFlush(){if(flushTimer||closed)return;flushTimer=setTimeout(()=>{flushTimer=null;void flush();},50);}
 function flush(){if(!pending.size)return chain;const id=pending.values().next().value.id,items=[];let bytes=0;for(const [source,x]of pending){if(x.id!==id)continue;if(items.length>=32||(items.length&&bytes+x.bytes>512*1024))break;pending.delete(source);pendingBytes-=x.bytes;bytes+=x.bytes;items.push(x.item);}if(!items.length)return chain;
  const work=async()=>{try{const r=await runtime({type:'DISTRIBUTION_CAPTURE',id,items});if(r.session?.id===state.id)state=r.session;if(r.skipped>0)error='일부 문구가 개인 캐시에 없거나 바뀌어 배포 기록에서 제외되었습니다.';notify();}catch{error='배포 기록 저장 실패: 개인 캐시는 유지됩니다. 저장 창에서 확인하세요.';notify();}};
  chain=chain.then(work,work);if(pending.size)scheduleFlush();return chain;
 }
 async function drain(){while(pending.size){await flush();}await chain;}
 function capture(m){if(closed||state.status!=='recording'||m.id!==state.id||m.target!==state.target)return;const x=m.item;if(!x||typeof x.source!=='string'||!x.source.trim()||x.source.length>8192||typeof x.text!=='string'||!x.text.trim()||x.text.length>50000)return;
  const item={source:x.source,text:x.text,target:m.target},bytes=encoder.encode(JSON.stringify(item)).byteLength+1;if(bytes>1024*1024){error='배포 문구 한 항목이 전송 한도를 넘었습니다.';notify();return;}
  const key=state.id+'|'+x.source,old=pending.get(key);if((!old&&pending.size>=512)||pendingBytes-(old?.bytes||0)+bytes>8*1024*1024){error='배포 기록 대기가 너무 많아 일부 항목이 누락될 수 있습니다.';notify();void flush();return;}if(old)pendingBytes-=old.bytes;pending.set(key,{item,bytes,id:state.id});pendingBytes+=bytes;scheduleFlush();
 }
 function onMessage(event){if(event.source!==window||event.origin!==location.origin)return;const m=event.data;if(!m||m.channel!=='crave-ai-translator/v1'||m.from!=='engine')return;
  if(m.type==='RECORD_TEXT'){capture(m);return;}
  if(m.type==='RECORDING_ACK'&&typeof m.requestId==='string'){const a=acks.get(m.requestId);if(!a)return;clearTimeout(a.timer);acks.delete(m.requestId);capable=true;if(a.resolve)a.resolve();notify();}
 }
 function stopMain(){return new Promise((resolve,reject)=>{const requestId='d'+(++sequence),t=setTimeout(()=>{acks.delete(requestId);reject(Error('기록 종료 확인 실패. 게임을 새로고침한 뒤 다시 시도하세요.'));},3000);acks.set(requestId,{timer:t,resolve});send('RECORDING_STATE',{active:false,id:null,requestId});lastSent='stopped';});}
 async function start(){if(busy||closed)return;if(!capable){error='게임 새로고침 후 배포 기록을 사용할 수 있습니다.';notify();return;}busy=true;error='';notify();try{await runtime({type:'DISTRIBUTION_OPEN',action:'start'});await poll();}catch(e){error='저장 위치 선택 창을 열지 못했습니다. 기존 배포 기록이 남아 있는지 확인하세요.';}finally{busy=false;notify();}}
 async function finish(){if(busy||closed||!['recording','ready'].includes(state.status))return;const priorError=error;busy=true;notify();try{if(state.status==='recording')await stopMain();await drain();await runtime({type:'DISTRIBUTION_OPEN',action:'finish',id:state.id,partial:!!(priorError||error)});await poll();}catch{error='배포 Finish를 완료하지 못했습니다. 수집된 기록은 남아 있으니 다시 시도하세요.';}finally{busy=false;notify();}}
 window.addEventListener('message',onMessage);void poll();timer=setInterval(poll,2000);
 return {getState,subscribe(fn){listeners.add(fn);fn(getState());return()=>listeners.delete(fn);},start,finish,update(){sync();},dispose(){closed=true;clearInterval(timer);clearTimeout(flushTimer);for(const a of acks.values())clearTimeout(a.timer);acks.clear();window.removeEventListener('message',onMessage);listeners.clear();}};
}
window[KEY]=Object.freeze({create});})();
