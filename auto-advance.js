/* ISOLATED: only the trusted remote can arm this page-local center clicker. */
(()=>{'use strict';
const KEY=Symbol.for('crave-ai-auto-advance.v1');if(window[KEY])return;
const SETTLE_MS=1000,ACK_MS=2500;
function create({send,getConfig,distribution}){
  let enabled=false,disposed=false,editorOpen=false,busy=false,timer=null,pending=null,generation=0,sequence=0,lastClicked='',state=null,reason='꺼짐';
  let signature=configKey(),priorRecording=false,distributionKey='';
  const listeners=new Set();
  function configKey(){const c=getConfig()||{};return JSON.stringify([!!c.enabled,!!c.configured,c.cacheEpoch,c.target,c.cacheOnly,c.cacheEnabled,c.playerName,c.displayName]);}
  function getState(){return {enabled,busy,reason};}
  function notify(){const value=getState();for(const listener of listeners)listener(value);}
  function cancel(){generation++;clearTimeout(timer);timer=null;if(pending){clearTimeout(pending.timer);pending.resolve(false);pending=null;}}
  function recording(){return distribution?.getState()||{status:'idle'};}
  function allowed(){const c=getConfig()||{},d=recording();return enabled&&!disposed&&!document.hidden&&!editorOpen&&c.enabled===true&&c.configured===true&&!d.busy&&!d.error&&!['ready','other','busy'].includes(d.status);}
  function explain(){const c=getConfig()||{},d=recording();if(!enabled)return reason;if(document.hidden)return '탭 숨김';if(editorOpen)return '수정창에서 일시정지';if(!c.enabled||!c.configured)return '번역 설정 대기';if(d.error)return d.errorSummary||'배포 기록 저장 실패';if(d.busy||['ready','other','busy'].includes(d.status))return '배포 작업 대기';if(!state?.ready)return state?.reason||'대사 대기';return state.id===lastClicked?'다음 대사 대기':'번역·기록 완료 확인 중';}
  function centerClick(){
    const canvas=document.getElementById('GameCanvas');
    if(!canvas||canvas.tagName!=='CANVAS'||!canvas.isConnected)return false;
    const r=canvas.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    if(![r.left,r.top,r.width,r.height,x,y].every(Number.isFinite)||r.width<=0||r.height<=0||x<0||y<0||x>=window.innerWidth||y>=window.innerHeight||document.elementFromPoint(x,y)!==canvas)return false;
    const options={bubbles:true,cancelable:true,view:window,button:0,clientX:x,clientY:y,detail:1};
    canvas.dispatchEvent(new MouseEvent('mousedown',{...options,buttons:1}));
    canvas.dispatchEvent(new MouseEvent('mouseup',{...options,buttons:0}));
    canvas.dispatchEvent(new MouseEvent('click',{...options,buttons:0}));
    return true;
  }
  function confirm(id){return new Promise(resolve=>{const requestId='a'+(++sequence);pending={id,requestId,resolve,timer:setTimeout(()=>{if(pending?.requestId!==requestId)return;pending=null;resolve(false);},ACK_MS)};send('STORY_ADVANCE_CHECK',{id,requestId});});}
  async function advance(id,mine){
    timer=null;if(mine!==generation||!allowed()||!state?.ready||state.id!==id||id===lastClicked)return;
    busy=true;reason='배포 기록 확인 중';notify();
    try{
      if(recording().status==='recording')await distribution.flushForAdvance();
      if(mine!==generation||!allowed()||!state?.ready||state.id!==id)return;
      const approved=await confirm(id);
      if(mine!==generation||!allowed()||!state?.ready||state.id!==id)return;
      if(!approved){stop('대사 진행 상태를 확인하지 못했습니다');return;}
      // Mark before dispatch: input may synchronously change the game and emit a new state.
      lastClicked=id;
      if(!centerClick()){stop('게임 중앙이 가려졌거나 클릭할 수 없습니다');return;}
      reason='다음 대사 대기';
    }catch(e){if(mine===generation)stop('자동진행 중지: '+(recording().errorSummary||e?.summary||'배포 기록 저장 실패'));}
    finally{busy=false;if(!disposed){schedule();notify();}}
  }
  function schedule(){
    if(timer||busy||!allowed()||!state?.ready||state.id===lastClicked){reason=explain();return;}
    reason=explain();const mine=generation,id=state.id;
    timer=setTimeout(()=>{void advance(id,mine);},SETTLE_MS);
  }
  function stop(message='꺼짐'){cancel();enabled=false;reason=message;send('STORY_WATCH',{active:false});notify();}
  function setEnabled(value){
    if(disposed||typeof value!=='boolean')return;
    if(!value){stop();return;}
    const c=getConfig()||{};
    if(document.hidden||!c.enabled||!c.configured){reason='번역을 켠 게임 화면에서 활성화하세요';notify();return;}
    if(recording().error){stop('자동진행 중지: '+(recording().errorSummary||'배포 기록 저장 실패'));return;}
    cancel();enabled=true;lastClicked='';state=null;reason='대사 상태 확인 중';send('STORY_WATCH',{active:true});notify();
  }
  function receiveState(value){
    if(disposed||!enabled||!value||typeof value.id!=='string'||value.id.length>80||!/^s\d+$/.test(value.id)||typeof value.ready!=='boolean')return;
    const next={id:value.id,ready:value.ready,reason:typeof value.reason==='string'?value.reason.slice(0,120):'대사 대기'};
    if(!state||state.id!==next.id||state.ready!==next.ready){cancel();state=next;schedule();notify();}
    else{state=next;reason=explain();notify();}
  }
  function receiveAck(message){const p=pending;if(!p||message?.requestId!==p.requestId||message.id!==p.id)return;clearTimeout(p.timer);pending=null;p.resolve(message.ready===true);}
  function setEditorOpen(value){if(editorOpen===!!value)return;editorOpen=!!value;cancel();schedule();notify();}
  function update(){const next=configKey();if(next!==signature){signature=next;if(enabled){stop('설정 변경으로 자동진행 중지');return;}}cancel();schedule();notify();}
  function visibility(){if(document.hidden&&enabled)stop('탭이 숨겨져 자동진행 중지');}
  function pagehide(){if(enabled)stop('페이지 이동으로 자동진행 중지');}
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',pagehide);
  const unsubscribe=distribution?.subscribe(value=>{const key=JSON.stringify([value?.id,value?.status,!!value?.busy,value?.error||'']);if(key===distributionKey)return;distributionKey=key;const active=value?.status==='recording';if(value?.error&&enabled){priorRecording=active;stop('자동진행 중지: '+(value.errorSummary||'배포 기록 저장 실패'));return;}if(priorRecording&&!active&&enabled){priorRecording=active;stop('배포 기록이 종료되어 자동진행 중지');return;}priorRecording=active;cancel();schedule();notify();});
  return {getState,subscribe(fn){listeners.add(fn);fn(getState());return()=>listeners.delete(fn);},setEnabled,setEditorOpen,receiveState,receiveAck,update,stop,dispose(){if(disposed)return;stop();disposed=true;unsubscribe?.();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',pagehide);listeners.clear();}};
}
window[KEY]=Object.freeze({create});
})();
