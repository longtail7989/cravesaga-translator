/* MAIN: observe verified Cocos story state; never invoke game input/advance APIs. */
(()=>{'use strict';
const KEY=Symbol.for('crave-ai-story-policy.v1');if(window[KEY])return;
const VIEW=new Set(['MessageView','ggMessageView','ggAdultMessageView']);
const BODY=new Set(['AdvText','AdvTextExtension']);
function create({getEngine,getConfig,getRecords,actual,emit}){
  let watching=false,disposed=false,scanned=false,scene=null,views=[],roots=[],blockers=[],identity=null,sequence=0,segmenter=null;
  let state={id:'s0',ready:false,reason:'대사 대기'};
  const valid=value=>!!value&&(!getEngine()?.isValid||getEngine().isValid(value));
  const active=value=>valid(value)&&value.node?.activeInHierarchy===true&&value.enabledInHierarchy!==false;
  const className=value=>getEngine()?.js?.getClassName?.(value)||'';
  function progress(label,nativeFrame){
    try{
      if(!valid(label)||!BODY.has(className(label))||typeof nativeFrame!=='string'||typeof label.getPlaneText!=='function'||typeof label.getMaxLength!=='function')return null;
      const full=label.getPlaneText(),length=label.getMaxLength(),shown=label._dispLength;
      if(typeof full==='string'&&length===full.length&&Number.isFinite(shown)&&shown>=0&&shown<=length&&nativeFrame.length===Math.trunc(shown)&&full.startsWith(nativeFrame))return {full,length,shown};
    }catch{}
    return null;
  }
  function source(label,nativeFrame){return progress(label,nativeFrame)?.full??nativeFrame;}
  function typingPlan(text){
    segmenter??=new Intl.Segmenter(undefined,{granularity:'grapheme'});
    const units=[],stack=[],spans=[];
    let visible='',close='',offset=0;
    function append(start,end){
      if(start===end)return;
      spans.push({offset:visible.length,start,length:end-start,close});visible+=text.slice(start,end);
    }
    function flush(){
      let spanIndex=0;
      for(const part of segmenter.segment(visible)){
        const end=part.index+part.segment.length;
        while(end>spans[spanIndex].offset+spans[spanIndex].length)spanIndex++;
        const span=spans[spanIndex];units.push({end:span.start+end-span.offset,close:span.close});
      }
      visible='';spans.length=0;
    }
    for(const match of text.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>|\{[^{}]*\}/g)){
      append(offset,match.index);
      const token=match[0];offset=match.index+token.length;
      if(token[0]==='{'){flush();units.push({end:offset,close});continue;}
      if(token.startsWith('<!--'))continue;
      const end=token.match(/^<\s*\/\s*([A-Za-z][\w:-]*)\s*>$/);
      if(end){
        if(stack.at(-1)?.toLowerCase()!==end[1].toLowerCase())return null;
        stack.pop();
      }else{
        const start=token.match(/^<\s*([A-Za-z][\w:-]*)(?=[\s=/>])/);
        if(!start)return null;
        if(!/\/\s*>$/.test(token)&&!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(start[1]))stack.push(start[1]);
      }
      close=stack.slice().reverse().map(name=>'</'+name+'>').join('');
    }
    append(offset,text.length);flush();
    return stack.length?null:{text,units,count:-1,display:''};
  }
  function reveal(label,nativeFrame,fullDisplayText){
    const record=getRecords().get(label),frame=progress(label,nativeFrame);
    if(!record||!frame||frame.shown>=frame.length){if(record)delete record.typingPlan;return fullDisplayText;}
    let plan=record.typingPlan;
    if(!plan||plan.text!==fullDisplayText){
      plan=typingPlan(fullDisplayText);
      if(!plan){delete record.typingPlan;return fullDisplayText;}
      record.typingPlan=plan;
    }
    if(frame.shown===0)return '';
    const count=Math.min(plan.units.length,Math.max(1,Math.floor(plan.units.length*frame.shown/frame.length)));
    if(plan.count!==count){
      const unit=plan.units[count-1];
      plan.display=count===plan.units.length?fullDisplayText:fullDisplayText.slice(0,unit.end)+unit.close;
      plan.count=count;
    }
    return plan.display;
  }
  function publish(ready,reason){const next={id:'s'+sequence,ready,reason};if(next.id===state.id&&next.ready===state.ready&&next.reason===state.reason)return;state=next;if(watching&&!disposed)emit('STORY_STATE',{state:{...state}});}
  function under(node,parent){for(let depth=0;node&&depth<40;depth++,node=node.parent)if(node===parent)return true;return false;}
  function translated(label){
    if(!label||!active(label))return !label;
    const r=getRecords().get(label);if(!r||r.deleted||actual(label)!==r.display)return false;
    if(!r.raw.trim())return true;
    if(r.resolved&&typeof r.templateText==='string'&&r.templateText.trim())return r.displayComplete===true;
    const bare=r.raw.replace(/<[^>]*>|\{[^{}]*\}/g,'');
    const needs=r.raw==='{USER}'||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(bare)||(getConfig().translateLatin!==false&&/[A-Za-z]/.test(bare));
    return !needs&&!r.requested&&actual(label)===r.raw;
  }
  function check(){
    if(!watching||disposed)return;
    try{
      const config=getConfig();
      if(document.hidden||!config.enabled||!config.configured||!scanned)return publish(false,'게임 대사 대기');
      const liveViews=views.filter(active),liveRoots=roots.filter(active);
      if(liveViews.length!==1||liveRoots.length!==1||blockers.some(active))return publish(false,'대사창 밖·팝업에서 대기');
      const view=liveViews[0],root=liveRoots[0],label=view.messageText;
      if(!under(view.node,root.node)||root.getMessageView()!==view||!active(label)||!BODY.has(className(label)))return publish(false,'대사창 확인 대기');
      const manager=typeof window.__require==='function'&&window.__require('AdvManager');
      if(!manager||typeof manager.getAdvData!=='function'||typeof manager.getPlayState!=='function'||typeof manager.getCurrentCommandName!=='function')return publish(false,'스토리 상태 확인 대기');
      const data=manager.getAdvData(),command=manager.getCurrentCommandName();
      if(!data||data.initialized!==true||manager.getPlayState()!==1||!Number.isSafeInteger(data.currentScenarioIndex)||!Number.isSafeInteger(data.cnt)||!Array.isArray(data.messageLogList))return publish(false,'스토리 전환 중');
      const r=getRecords().get(label);if(!r||!r.raw.trim())return publish(false,'대사 대기');
      const token=[scene,data,root,label,data.currentScenarioIndex,data.messageLogList.length,data.messageLogList.at(-1),r.raw];
      if(!identity||token.some((part,index)=>part!==identity[index])){identity=token;sequence++;}
      if(root.enabledInHierarchy!==true||root._isSuspendUpdate!==false||['_advLogPopup','_advConfigPopup','_advSkipConfirmPopup'].some(key=>valid(root[key])&&root[key].node?.activeInHierarchy!==false))return publish(false,'백로그·메뉴에서 대기');
      if(!valid(view.selectionNode)||!Array.isArray(view.selectionNode.children)||view.selectionNode.children.length)return publish(false,'선택지에서 대기');
      if(command!=='msg'&&command!=='clickwait')return publish(false,'대사 이외의 진행에서 대기');
      if(valid(root.messageTouchNode)||typeof label.getMaxLength!=='function'||!Number.isFinite(label._dispLength))return publish(false,'대사 표시 중');
      const length=label.getMaxLength();if(!Number.isFinite(length)||length<0||label._dispLength<length)return publish(false,'대사 표시 중');
      if(!translated(label)||(view.nameText?.node?.activeInHierarchy===true&&!translated(view.nameText)))return publish(false,'현재 대사 번역 대기');
      publish(true,'번역 완료');
    }catch{publish(false,'스토리 구조 확인 대기');}
  }
  function reset(){scanned=false;views=[];roots=[];blockers=[];publish(false,'대사 상태 다시 확인 중');}
  return {source,reveal,
    setWatching(value){watching=value===true;if(watching){state={...state,ready:false,reason:''};reset();}else reset();},
    begin(value){if(!watching||disposed)return;scene=value;scanned=false;views=[];roots=[];blockers=[];},
    visit(node){if(!watching||disposed||node.activeInHierarchy!==true)return;for(const component of node._components||[]){if(!active(component))continue;const name=className(component);if(VIEW.has(name))views.push(component);if(/AdvSubRoot(?:Base)?$/.test(name)&&typeof component.getMessageView==='function')roots.push(component);if(name==='AdvExtensionLogPopup'||/(?:Config|SkipConfirm)Popup$/.test(name))blockers.push(component);}},
    end(){if(!watching||disposed)return;scanned=true;check();},check,reset,
    confirm(message){if(typeof message?.requestId!=='string'||!/^a\d+$/.test(message.requestId)||message.requestId.length>80||typeof message.id!=='string'||!/^s\d+$/.test(message.id)||message.id.length>80)return;check();emit('STORY_ADVANCE_ACK',{requestId:message.requestId,id:message.id,ready:watching&&!disposed&&state.ready&&state.id===message.id});},
    dispose(){watching=false;disposed=true;reset();identity=null;}
  };
}
window[KEY]=Object.freeze({create});
})();
