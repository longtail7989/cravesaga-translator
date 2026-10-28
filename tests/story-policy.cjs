'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../story-policy.js'),'utf8');
function harness(Segmenter=Intl.Segmenter){
  const messages=[],window={},document={hidden:false},config={enabled:true,configured:true,translateLatin:true};
  const scene={activeInHierarchy:true,_components:[],children:[]};
  function node(parent=scene){const n={parent,activeInHierarchy:true,_components:[],children:[]};parent.children.push(n);return n;}
  function component(name,n){const c={name,node:n,enabledInHierarchy:true};n._components.push(c);return c;}
  const root=component('AdvSubRoot',node()),view=component('ggMessageView',node(root.node)),label=component('AdvText',node(view.node));
  view.messageText=label;view.selectionNode=node(view.node);root.getMessageView=()=>view;root._isSuspendUpdate=false;root.clickWaitCursorNode=node(root.node);
  label._dispLength=8;label.getMaxLength=()=>8;label.string='번역된 대사';
  const record={raw:'冒険の続きです。',display:label.string,displayComplete:true,resolved:true,templateText:label.string,requested:'冒険の続きです。'},records=new Map([[label,record]]);
  label.getPlaneText=()=>record.raw;
  const data={initialized:true,currentScenarioIndex:0,cnt:4,messageLogList:[{}]};let command='clickwait',play=1;
  window.__require=id=>{assert.equal(id,'AdvManager');return {getAdvData:()=>data,getPlayState:()=>play,getCurrentCommandName:()=>command};};
  const engine={isValid:x=>x&&!x.destroyed,js:{getClassName:x=>x.name}};
  vm.runInNewContext(source,{window,document,Symbol,Set,Number,Array,Intl:{Segmenter}});
  const policy=window[Symbol.for('crave-ai-story-policy.v1')].create({getEngine:()=>engine,getConfig:()=>config,getRecords:()=>records,actual:x=>x.string,emit:(type,payload)=>messages.push({type,...payload})});
  function scan(){policy.begin(scene);const visit=n=>{policy.visit(n);n.children.forEach(visit);};visit(scene);policy.end();}
  function state(){return messages.filter(x=>x.type==='STORY_STATE').at(-1)?.state;}
  return {policy,messages,window,document,config,scene,root,view,label,record,records,data,node,component,scan,state,setCommand:x=>command=x,setPlay:x=>play=x};
}
function typewriter(h,full){
  h.label.getPlaneText=()=>full;h.label.getMaxLength=()=>full.length;
  return (shown,target)=>{h.label._dispLength=shown;return h.policy.reveal(h.label,full.slice(0,shown),target);};
}
{
 const h=harness(),full='あいうえおかきくけこ',target='가나다라마바사아자차',reveal=typewriter(h,full);
 h.config.enabled=false;h.config.configured=false;
 assert.equal(reveal(0,target),'','zero original progress reveals no Korean even with auto/config disabled');
 const plan=h.record.typingPlan;
 assert.equal(reveal(1,target),'가','the first verified source character reveals one translated grapheme');
 assert.equal(reveal(3,target),'가나다');assert.equal(reveal(7,target),'가나다라마바사');
 assert.equal(h.record.typingPlan,plan,'native ticks reuse the transient plan');
 assert.equal(h.policy.source(h.label,full.slice(0,7)),full,'projection does not change the complete original');
 assert.equal(h.label._dispLength,7,'projection never advances the original typewriter');
 assert.equal(h.label.getPlaneText(),full);assert.equal(h.label.string,'번역된 대사','projection itself does not mutate the label');
 assert.equal(reveal(full.length,target),target,'completion returns the exact complete target');
 assert.equal(h.record.typingPlan,undefined,'original completion releases the transient plan');
 assert.equal(reveal(full.length,'늦게 도착한 번역 전체'),'늦게 도착한 번역 전체','late AI results do not replay a completed typewriter');
 assert.equal(h.record.typingPlan,undefined);
}
{
 let passes=0;
 class CountedSegmenter{
   constructor(...args){this.segmenter=new Intl.Segmenter(...args);}
   segment(text){passes++;return this.segmenter.segment(text);}
 }
 const h=harness(CountedSegmenter),reveal=typewriter(h,'あ'.repeat(20)),target='가나다라';
 assert.equal(reveal(1,target),'가');const plan=h.record.typingPlan,parsed=passes;
 for(const shown of [2,3,4,5,6,7,8,9])assert.equal(reveal(shown,target),'가');
 assert.equal(passes,parsed,'same-unit native ticks do not resegment the translation');
 assert.equal(h.record.typingPlan,plan);assert.equal(reveal(10,target),'가나');assert.equal(passes,parsed,'new units also use the cached plan');
 assert.equal(reveal(10,'마바사아'),'마바');assert.notEqual(h.record.typingPlan,plan);assert.ok(passes>parsed,'a changed personalized target rebuilds the plan');
 assert.equal(reveal(1,'한'),'한');const shortPlan=h.record.typingPlan;assert.equal(reveal(2,'한'),'한');assert.equal(h.record.typingPlan,shortPlan,'a one-grapheme target remains cached until original completion');
 assert.equal(reveal(0,'한'),'','original progress can reset without replaying a cached unit');
}
{
 const h=harness(),reveal=typewriter(h,'あ'.repeat(10)),parts=['한','👩🏽‍🚀','e\u0301','🇰🇷','끝'],target=parts.join('');
 assert.equal(reveal(0,target),'');
 for(const [shown,count] of [[1,1],[2,1],[4,2],[6,3],[8,4],[10,5]])assert.equal(reveal(shown,target),parts.slice(0,count).join(''),'projection never splits Jamo, emoji modifiers/ZWJ, accents or flags');
 assert.equal(h.record.typingPlan,undefined);
 const decorated='<b>ᄒ</b>ᅡᆫ<i>👩🏽‍</i>🚀끝';
 assert.equal(reveal(1,decorated),'<b>ᄒ</b>ᅡᆫ','graphemes stay whole across formatting boundaries');
 assert.equal(reveal(7,decorated),'<b>ᄒ</b>ᅡᆫ<i>👩🏽‍</i>🚀','ZWJ sequences stay whole across formatting boundaries');
}
{
 const h=harness(),reveal=typewriter(h,'あ'.repeat(20));
 const target='<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{USER}\r\n나</color><i>끝</i>';
 const expected=[
   '<color="#ff00aa"><b>가</b></color>',
   '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b></color>',
   '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{USER}</color>',
   '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{USER}\r\n</color>',
   '<color="#ff00aa"><b>가👨‍👩‍👧‍👦</b>{USER}\r\n나</color>'
 ];
 assert.equal(reveal(0,target),'');
 for(const [shown,index] of [[1,0],[7,1],[10,2],[14,3],[17,4]])assert.equal(reveal(shown,target),expected[index],'markup stays balanced, variables atomic and CRLF intact');
 assert.equal(reveal(20,target),target,'completion preserves all original target bytes, including tags, placeholders and line endings');
 const personalized='<b>용사👩‍🚀</b>님\n안녕';
 assert.equal(reveal(1,personalized),'<b>용</b>','a supplied personalized target, not the canonical placeholder, is projected');
 assert.equal(reveal(20,personalized),personalized);
 const quoted='<color title="a>b">가<img src="face"/><br/>나</color>';
 assert.equal(reveal(1,quoted),'<color title="a>b">가</color>','quoted tag delimiters are atomic');
 assert.equal(reveal(11,quoted),'<color title="a>b">가</color>');
 assert.equal(reveal(20,quoted),quoted);
 assert.equal(reveal(1,'<b>가<i>나</b></i>'),'<b>가<i>나</b></i>','unbalanced input is not projected into broken markup');
}
for(const [description,change,native='あ'] of [
 ['ordinary static label',h=>h.label.name='cc.Label'],
 ['backlog label',h=>h.label.name='AdvRichBackLogText'],
 ['stale source',h=>h.label.getPlaneText=()=>'違う原文'],
 ['stale length',h=>h.label.getMaxLength=()=>200],
 ['stale progress',h=>h.label._dispLength=4],
 ['invalid progress',h=>h.label._dispLength=NaN],
 ['negative progress',h=>h.label._dispLength=-1],
 ['out-of-range progress',h=>h.label._dispLength=11],
 ['missing original method',h=>delete h.label.getPlaneText],
 ['throwing original method',h=>h.label.getPlaneText=()=>{throw Error('missing');}],
 ['destroyed component',h=>h.label.destroyed=true],
 ['mismatched native frame',()=>{},'い']
]){
 const h=harness(),reveal=typewriter(h,'あいうえおかきくけこ'),target='<b>한국어 전체</b>';
 assert.equal(reveal(1,target),'<b>한</b>');assert.ok(h.record.typingPlan);
 change(h);assert.equal(h.policy.reveal(h.label,native,target),target,description+' returns the complete target rather than guessing progress');
 assert.equal(h.record.typingPlan,undefined,description+' releases stale transient state');
}
{
 const h=harness(),reveal=typewriter(h,'あいうえお'),target='한국어 전체';
 h.label.name='AdvTextExtension';assert.equal(reveal(1,target),'한','adult dialogue uses verified inherited typing progress');
 h.records.delete(h.label);assert.equal(reveal(1,target),target,'untracked labels do not gain separate persistent state');
}
{
 const h=harness(),full='ミナト、攻撃力が10%上がる。\n冒険を続けよう！';
 h.label._planeText=full;h.label.getPlaneText=()=>h.label._planeText;h.label.getMaxLength=()=>h.label._planeText.length;
 for(const shown of [0,1,5]){h.label._dispLength=shown;assert.equal(h.policy.source(h.label,full.slice(0,shown)),full,'complete source is available before typing finishes and without enabling auto advance');}
 h.label._dispLength=1;h.label._planeText='ミナト、次の物語が始まる。';assert.equal(h.policy.source(h.label,'ミ'),h.label._planeText,'a repeated first character must use the next complete line');
 h.label.name='AdvTextExtension';assert.equal(h.policy.source(h.label,'ミ'),h.label._planeText,'the inherited adult dialogue typewriter has the same original source contract');
 h.label.name='cc.Label';assert.equal(h.policy.source(h.label,'ミ'),'ミ','ordinary labels must not borrow unrelated story metadata');
}
for(const [description,change] of [
 ['different native text',h=>h.label._planeText='別の原文'],
 ['stale length metadata',h=>h.label.getMaxLength=()=>200],
 ['stale progress',h=>h.label._dispLength=3],
 ['invalid progress',h=>h.label._dispLength=Infinity],
 ['negative progress',h=>h.label._dispLength=-1],
 ['out-of-range progress',h=>h.label._dispLength=100],
 ['unavailable original',h=>h.label.getPlaneText=()=>null],
 ['throwing original getter',h=>h.label.getPlaneText=()=>{throw Error('unavailable');}],
 ['destroyed component',h=>h.label.destroyed=true]
]){
 const h=harness();h.label._planeText='ミナト、冒険へ。';h.label.getPlaneText=()=>h.label._planeText;h.label.getMaxLength=()=>h.label._planeText.length;h.label._dispLength=1;
 change(h);assert.equal(h.policy.source(h.label,'ミ'),'ミ',description+' keeps the native frame rather than a guessed source');
}
{
 const h=harness();h.label._planeText=h.record.raw;h.label.getPlaneText=()=>h.label._planeText;h.label.getMaxLength=()=>h.label._planeText.length;h.label._dispLength=1;
 assert.equal(h.policy.source(h.label,h.record.raw.slice(0,1)),h.record.raw);h.policy.setWatching(true);h.scan();assert.equal(h.state().ready,false,'early cached Korean never completes the game typewriter');
 h.label._dispLength=h.label.getMaxLength();h.policy.check();assert.equal(h.state().ready,true,'advance becomes ready only at the original source length');assert.equal(h.label._planeText,h.record.raw,'translation does not replace the game original');
}
{
 const h=harness(),target='한국어 대사 전체',reveal=typewriter(h,h.record.raw);
 h.record.templateText=target;h.record.display=h.label.string=reveal(1,target);h.record.displayComplete=false;
 h.policy.setWatching(true);h.scan();assert.equal(h.state().ready,false,'both original and Korean can still be typing');
 h.record.displayComplete=true;h.policy.check();assert.equal(h.state().ready,false,'a display-complete flag never bypasses original progress');
 h.record.displayComplete=false;h.label._dispLength=h.record.raw.length;h.policy.check();assert.equal(h.state().ready,false,'original completion alone never advances a partial Korean projection');
 h.record.display=h.label.string=reveal(h.record.raw.length,target);h.record.displayComplete=true;h.policy.check();assert.equal(h.state().ready,true,'only original and Korean completion together permit readiness');
 assert.equal(h.record.display,target);assert.equal(h.record.typingPlan,undefined);
}
{
 const h=harness();h.policy.setWatching(true);h.record.raw=h.record.display=h.label.string=h.record.templateText='……';h.record.requested=null;h.record.displayComplete=false;h.scan();
 assert.equal(h.state().ready,false,'resolved translations cannot bypass Korean completion through the no-translation-needed fallback');
 h.record.displayComplete=true;h.policy.check();assert.equal(h.state().ready,true);
}
{
 const h=harness();h.scan();assert.equal(h.messages.length,0);h.policy.setWatching(true);h.scan();assert.equal(h.state().ready,true);const id=h.state().id;
 h.policy.check();h.scan();assert.equal(h.state().id,id);h.policy.reset();h.scan();assert.equal(h.state().id,id,'binding refresh is not a new dialogue occurrence');
 h.data.cnt++;h.scan();assert.equal(h.state().id,id,'msg to clickwait is still the same dialogue occurrence');
 h.data.cnt++;h.data.messageLogList.push({});h.scan();assert.notEqual(h.state().id,id,'same source at a distinct command is a new occurrence');
 const current=h.state().id;h.policy.confirm({id,requestId:'a1'});assert.equal(h.messages.at(-1).ready,false);h.policy.confirm({id:current,requestId:'a2'});assert.equal(h.messages.at(-1).ready,true);
 h.root._isSuspendUpdate=true;h.policy.confirm({id:current,requestId:'a3'});assert.equal(h.messages.at(-1).ready,false,'confirmation rechecks the live menu state');
}
{
 const h=harness();h.root.clickWaitCursorNode.activeInHierarchy=false;h.policy.setWatching(true);h.scan();
 assert.equal(h.state().ready,true,'a completed cache hit advances even when the decorative wait cursor is hidden');
 h.policy.confirm({id:h.state().id,requestId:'a1'});assert.equal(h.messages.at(-1).ready,true);
 h.label._dispLength=2;h.policy.check();assert.equal(h.state().ready,false,'hidden cursor does not bypass typewriter completion');
 h.label._dispLength=8;h.record.resolved=false;h.record.templateText=null;h.policy.check();assert.equal(h.state().ready,false,'hidden cursor does not bypass translation completion');
 h.record.resolved=true;h.record.templateText=h.record.display;h.node(h.view.selectionNode);h.scan();assert.equal(h.state().ready,false,'hidden cursor does not allow selecting a choice');
}
for(const [description,change] of [
 ['typing',h=>h.label._dispLength=2],['typewriter touch node',h=>h.root.messageTouchNode=h.node()],
 ['translation pending',h=>{h.record.resolved=false;h.record.templateText=null;}],
 ['partial Korean projection',h=>h.record.displayComplete=false],
 ['unknown Korean completion',h=>delete h.record.displayComplete],
 ['nonboolean Korean completion',h=>h.record.displayComplete=1],
 ['cache miss',h=>{h.record.resolved=true;h.record.templateText=null;}],['deleted row',h=>h.record.deleted=true],
 ['stale displayed string',h=>h.label.string='次の原文です。'],['choice',h=>h.node(h.view.selectionNode)],
 ['choice command',h=>h.setCommand('select')],['transition',h=>h.setCommand('wait')],['uninitialized',h=>h.data.initialized=false],
 ['game auto/skip',h=>h.setPlay(2)],['menu',h=>h.root._isSuspendUpdate=true],
 ['backlog popup',h=>h.component('AdvExtensionLogPopup',h.node())],['hidden document',h=>h.document.hidden=true],
 ['backlog label',h=>h.label.name='AdvRichBackLogText'],['inactive body',h=>h.label.node.activeInHierarchy=false],
 ['missing choice state',h=>delete h.view.selectionNode],['ambiguous second dialogue',h=>h.component('ggAdultMessageView',h.node())],
 ['speaker translation pending',h=>{const speaker=h.component('AdvText',h.node(h.view.node));speaker.string='名前';h.view.nameText=speaker;h.records.set(speaker,{raw:'名前',display:'名前',resolved:false,requested:'名前'});}],
 ['speaker projection incomplete',h=>{const speaker=h.component('AdvText',h.node(h.view.node));speaker.string='이름';h.view.nameText=speaker;h.records.set(speaker,{raw:'名前',display:'이름',resolved:true,templateText:'이름',displayComplete:false});}],
 ['unknown game module',h=>h.window.__require=()=>{throw Error('unavailable');}]
]){const h=harness();h.policy.setWatching(true);change(h);h.scan();assert.equal(h.state().ready,false,description);h.policy.confirm({id:h.state().id,requestId:'a1'});assert.equal(h.messages.at(-1).ready,false,description+' confirm');}
{
 const h=harness();h.policy.setWatching(true);h.label.name='AdvTextExtension';h.view.name='ggAdultMessageView';h.root.name='AdultAdvSubRoot';h.record.raw='……';h.record.display='……';h.label.string='……';h.record.requested=null;h.record.resolved=false;h.record.templateText=null;h.scan();assert.equal(h.state().ready,true,'punctuation-only dialogue needs no AI');
 h.policy.setWatching(false);const count=h.messages.length;h.policy.check();assert.equal(h.messages.length,count);
}
console.log('PASS story readiness and reveal: verified original progress, cached grapheme-safe balanced projection, exact completion, stable occurrence IDs and typing/translation/choice/menu/backlog guards');
