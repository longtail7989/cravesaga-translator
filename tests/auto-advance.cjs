/* Deterministic center-input behavior; no browser/profile/provider requests. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'auto-advance.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
 let now=10000,serial=0,controller,overlay=false,autoAck=true,flush=async()=>{},recording={status:'idle'},recordListener;
 const timers=new Map(),events=[],messages=[],listeners={},documentListeners={},config={enabled:true,configured:true,target:'한국어',cacheEpoch:'one'};
 const canvas={tagName:'CANVAS',isConnected:true,getBoundingClientRect:()=>({left:10,top:20,width:400,height:200}),dispatchEvent(event){events.push(event);return true;}};
 const document={hidden:false,getElementById:id=>id==='GameCanvas'?canvas:null,elementFromPoint:()=>overlay?{}:canvas,addEventListener:(type,fn)=>documentListeners[type]=fn,removeEventListener:type=>delete documentListeners[type]};
 const window={innerWidth:800,innerHeight:600,addEventListener:(type,fn)=>listeners[type]=fn,removeEventListener:type=>delete listeners[type]};
 class Clock extends Date{static now(){return now;}}class MouseEvent{constructor(type,init){this.type=type;Object.assign(this,init);}}
 const distribution={getState:()=>({...recording}),subscribe(fn){recordListener=fn;fn({...recording});return()=>recordListener=null;},flushForAdvance:()=>flush()};
 const context=vm.createContext({window,document,Symbol,Map,Set,JSON,Number,MouseEvent,Date:Clock,setTimeout:(fn,delay)=>{const id=++serial;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source,context);
 controller=window[Symbol.for('crave-ai-auto-advance.v1')].create({getConfig:()=>config,distribution,send(type,payload){messages.push({type,...payload});if(type==='STORY_ADVANCE_CHECK'&&autoAck)controller.receiveAck({...payload,ready:true});}});
 async function advance(ms){const end=now+ms;for(let i=0;i<10000;i++){const next=[...timers].filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next){now=end;await tick();return;}timers.delete(next[0]);now=next[1].at;next[1].fn();await tick();}throw Error('Timer runaway');}
 return {controller,config,document,canvas,events,messages,advance,ready:(id='s1')=>controller.receiveState({id,ready:true}),waiting:(id='s1')=>controller.receiveState({id,ready:false}),overlay:value=>overlay=value,holdAck:()=>autoAck=false,ack(){const m=messages.filter(x=>x.type==='STORY_ADVANCE_CHECK').at(-1);controller.receiveAck({...m,ready:true});},record(value){recording={...recording,...value};recordListener?.({...recording});},flush(fn){flush=fn;},hide(){document.hidden=true;documentListeners.visibilitychange();}};
}
(async()=>{
 let h=fixture();h.ready();await h.advance(2000);assert.equal(h.events.length,0,'default off never advances');h.controller.setEnabled(true);h.waiting();await h.advance(2000);assert.equal(h.events.length,0,'untranslated story does not advance');h.ready();await h.advance(999);assert.equal(h.events.length,0,'settling blocks early input');await h.advance(1);assert.deepEqual(h.events.map(x=>x.type),['mousedown','mouseup','click']);for(const e of h.events){assert.equal(e.clientX,210);assert.equal(e.clientY,120);assert.equal(e.button,0);}h.ready();await h.advance(10000);assert.equal(h.events.length,3,'same dialogue never gets repeated clicks');h.ready('s2');await h.advance(1000);assert.equal(h.events.length,6,'a different dialogue receives one new center click');h.controller.dispose();
 h=fixture();h.controller.setEnabled(true);h.ready();h.controller.setEditorOpen(true);await h.advance(2000);assert.equal(h.events.length,0);h.controller.setEditorOpen(false);await h.advance(1000);assert.equal(h.events.length,3);h.ready('s2');h.hide();await h.advance(2000);assert.equal(h.events.length,3);assert.equal(h.controller.getState().enabled,false,'hidden page disarms instead of background clicking');h.controller.dispose();
 h=fixture();h.controller.setEnabled(true);h.ready();h.overlay(true);await h.advance(1000);assert.equal(h.events.length,0,'DOM overlay blocks center input');assert.equal(h.controller.getState().enabled,false);h.controller.dispose();
 h=fixture();h.controller.setEnabled(true);h.holdAck();h.ready();await h.advance(1000);h.waiting();h.ack();await tick();assert.equal(h.events.length,0,'a late ready acknowledgement cannot advance a changed story');h.controller.dispose();
 h=fixture();let release;h.record({status:'recording',id:'one'});h.flush(()=>new Promise(resolve=>release=resolve));h.controller.setEnabled(true);h.ready();await h.advance(1000);assert.equal(h.events.length,0,'pending durable capture blocks input');release();await tick();assert.equal(h.events.length,3,'input follows successful capture completion');h.controller.dispose();
 h=fixture();h.record({status:'recording',id:'one'});h.flush(()=>new Promise(resolve=>release=resolve));h.controller.setEnabled(true);h.ready();await h.advance(1000);h.record({status:'ready'});release();await tick();assert.equal(h.events.length,0,'Finish cancels an advance already waiting on capture');assert.equal(h.controller.getState().enabled,false);h.controller.dispose();
 h=fixture();h.controller.setEnabled(true);h.ready();h.config.cacheEpoch='two';h.controller.update();await h.advance(2000);assert.equal(h.events.length,0);assert.equal(h.controller.getState().enabled,false,'settings changes disarm old timing');h.controller.dispose();
 h=fixture();h.record({status:'recording',id:'one'});h.flush(async()=>{throw Error('disk full')});h.controller.setEnabled(true);h.ready();await h.advance(1000);assert.equal(h.events.length,0,'recording failure never advances');assert.equal(h.controller.getState().enabled,false);h.controller.dispose();
 for(const [code,summary]of [['CACHE_MISSING','개인 캐시 항목 없음'],['TEXT_CHANGED','화면·캐시 번역 불일치'],['QUOTA','저장 공간 부족'],['INVALID_ENTRY','캐시 항목 검증 실패']]){
  h=fixture();h.record({status:'recording',id:'one'});
  h.flush(async()=>{h.record({errorCode:code,errorSummary:summary,error:'안전한 설명 ['+code+']'});throw Object.assign(Error('SYNTHETIC_PRIVATE_TEXT'),{code,summary});});
  h.controller.setEnabled(true);h.ready();await h.advance(1000);
  assert.equal(h.events.length,0,code+' failure during durable flush must prevent every input event');
  assert(!h.messages.some(message=>message.type==='STORY_ADVANCE_CHECK'),'failed recording never requests a click acknowledgement');
  assert.equal(h.controller.getState().enabled,false);assert.equal(h.controller.getState().reason,'자동진행 중지: '+summary);
  h.record({error:'안전한 설명 ['+code+']'});h.ready('s2');await h.advance(2000);assert.equal(h.events.length,0);
  h.controller.setEnabled(true);assert.equal(h.controller.getState().enabled,false,'explicit arm cannot bypass a pending recording failure');
  h.record({error:'',errorCode:'',errorSummary:''});h.ready('s3');await h.advance(2000);assert.equal(h.events.length,0,'later polling or recovery never automatically rearms after failure');assert(!h.controller.getState().reason.includes('SYNTHETIC_PRIVATE'));
  h.controller.dispose();
 }
 h=fixture();h.record({status:'recording',id:'one'});h.controller.setEnabled(true);h.holdAck();h.ready();await h.advance(1000);
 h.record({errorCode:'QUOTA',errorSummary:'저장 공간 부족',error:'저장 공간 부족 [QUOTA]'});h.ack();await tick();
 assert.equal(h.events.length,0,'a recording failure after durable flush but before click acknowledgement also blocks input');assert.equal(h.controller.getState().reason,'자동진행 중지: 저장 공간 부족');assert.equal(h.controller.getState().enabled,false);h.controller.dispose();
 console.log('PASS opt-in story input: one center click, settling, overlay/editor/visibility/config guards, stale checks and durable recording/Finish ordering');
})().catch(error=>{console.error(error);process.exitCode=1;});
