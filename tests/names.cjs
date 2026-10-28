/* Offline VM regressions for MAIN names and the isolated relay. No network or providers. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..');
const ORIGIN='https://gg-client-r.crave-saga.net',CHANNEL='crave-ai-translator/v1';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(options={}){
  let now=100000,timerSequence=0,names=options.names===undefined?['アレン','レオン']:options.names,held=false,release;
  const timers=new Map(),messages=[],calls=[],listeners=[],runtimeListeners=[],profileCalls=[],nativeWrites=[];
  const config={enabled:true,configured:true,cacheEnabled:true,cacheOnly:false,target:'한국어',translateLatin:true,fontFamily:'KR',cacheEpoch:'one',playerName:'',displayName:'',retryLimit:0,...options.config};
  const disk=new Map(options.entries||[]),scene={_components:[],children:[],parent:null};
  class Base{get string(){return this._s||'';}set string(value){this._s=String(value);nativeWrites.push({label:this,text:this._s});}}
  class Label extends Base{}class RichText extends Base{}
  function add(source){const label=new (options.rich?RichText:Label)(),node={activeInHierarchy:true,_components:[label],children:[],parent:scene};label.node=node;Object.assign(label,{fontFamily:'JP',useSystemFont:false,cacheMode:1});label._s=source;scene.children.push(node);return label;}
  const labels=(options.sources||['アレン、こんにちは','レオン、こんにちは']).map(add);
  const cc={Label,RichText,isValid:()=>true,director:{getScene:()=>scene},js:{getClassName:()=>options.className||(options.rich?'cc.RichText':'cc.Label')}};
  const window={cc,__require:name=>{profileCalls.push(name);assert.equal(name,'UserUtils');return {getUserBasicData:()=>{if(names===null)throw Error('Profile not ready');return {getMainCharacterName:()=>{profileCalls.push('getMainCharacterName');return names[0];},getUserName:()=>{profileCalls.push('getUserName');return names[1];}};}};},addEventListener:(type,fn)=>{if(type==='message')listeners.push(fn);},postMessage:message=>{messages.push(message);for(const fn of [...listeners])fn({source:window,origin:ORIGIN,data:message});}};
  let remote;
  window[Symbol.for('crave-ai-remote.v1')]={create:api=>(remote=api,{update(){},dispose(){}})};
  window[Symbol.for('crave-ai-distribution-client.v1')]={create:()=>({getState:()=>({status:'idle'}),subscribe(fn){fn({status:'idle'});return()=>{};},flushForAdvance:async()=>{},update(){}})};
  class Clock extends Date{static now(){return now;}}
  const globals={window,cc,document:{hidden:false,getElementById:()=>null,addEventListener(){}},location:{origin:ORIGIN,pathname:'/client/game/index_dmm.html'},Date:Clock,console,Map,Set,Symbol,Math,setTimeout:(fn,ms=0)=>{timers.set(++timerSequence,{fn,at:now+ms});return timerSequence;},clearTimeout:id=>timers.delete(id),setInterval:()=>0};
  function resolve(item,translate=false){let source;if(!translate||config.cacheEnabled!==false||config.cacheOnly)source=[item.source,...(item.templates||[])].find(key=>disk.has(key));if(source!==undefined)return {id:item.id,text:disk.get(source),cacheSource:source,cached:true};if(!translate)return {id:item.id,missing:true};source=item.templates?.[0]||item.source;const text=source==='{USER}'?'{USER}':(options.ai?options.ai(source):source.replace('こんにちは','안녕하세요'));if(config.cacheEnabled!==false)disk.set(source,text);return {id:item.id,text,cacheSource:source,cached:false};}
  const chrome={runtime:{onMessage:{addListener:fn=>runtimeListeners.push(fn)},sendMessage:async message=>{calls.push(message);let answer;if(message.type==='PUBLIC_CONFIG')answer={ok:true,config:{...config}};else if(message.type==='CACHE_WARM')answer={ok:true,entries:[...(options.warmEntries||options.entries||[])].map(([source,text])=>({source,text,target:config.target}))};else if(message.type==='CACHE_LOOKUP')answer={ok:true,results:message.items.map(item=>resolve(item))};else if(message.type==='TRANSLATE')answer={ok:true,results:message.items.map(item=>resolve(item,true))};else throw Error('Unexpected runtime '+message.type);if(message.type===options.holdType&&!held){held=true;await new Promise(done=>release=done);}return answer;}}};
  const mainContext=vm.createContext({...globals}),relayContext=vm.createContext({...globals,chrome});
  for(const name of ['dialogue-text.js','name-policy.js','story-policy.js','main.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),mainContext,{filename:name});
  for(const name of ['dialogue-text.js','retry-policy.js','auto-advance.js','content.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),relayContext,{filename:name});
  await tick();
  async function advance(ms){const end=now+ms;for(let n=0;n<10000;n++){const next=[...timers].filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next){now=end;await tick();return;}timers.delete(next[0]);now=next[1].at;next[1].fn();await tick();}throw Error('Timer loop did not settle');}
  const send=(type,payload={})=>window.postMessage({channel:CHANNEL,from:'bridge',type,...payload});
  const engine=(type,payload={})=>window.postMessage({channel:CHANNEL,from:'engine',type,...payload});
  async function settings(update){Object.assign(config,update);for(const fn of runtimeListeners)fn({type:'PUBLIC_CONFIG_CHANGED',config:{...config}},{},()=>{});await tick();}
  function entry(type,source,text){if(type==='CACHE_ENTRY_UPDATED')disk.set(source,text);else disk.delete(source);for(const fn of runtimeListeners)fn({type,entry:{source,text,target:config.target,manual:true}},{},()=>{});}
  return {labels,add,window,config,disk,messages,calls,profileCalls,nativeWrites,send,engine,advance,settings,entry,remote:()=>remote,release:async()=>{release?.();await tick();},profile:value=>{names=value;},refresh:()=>window[Symbol.for('crave-ai-translator.v1')].refresh()};
}
(async()=>{
  const canonical='{USER}、こんにちは',translated='{USER}님, 안녕하세요';
  let h=await harness({entries:[[canonical,translated],['アレン、こんにちは','정확한 원문 우선']],warmEntries:[[canonical,translated]]});
  assert(h.profileCalls.includes('getMainCharacterName'));assert(h.profileCalls.includes('getUserName'));
  assert.equal(h.labels[0].string,'アレン、こんにちは','canonical warm memory cannot beat literal persistent lookup');
  await h.advance(40);
  assert.equal(h.labels[0].string,'정확한 원문 우선');assert.equal(h.labels[1].string,'レオン님, 안녕하세요');
  const literalLookup=h.calls.filter(call=>call.type==='CACHE_LOOKUP').flatMap(call=>call.items).find(item=>item.source==='アレン、こんにちは');assert(literalLookup,'literal source reaches persistent lookup unchanged');assert.deepEqual(Array.from(literalLookup.templates),[canonical]);
  assert(!h.calls.some(call=>call.type==='TRANSLATE'),'all hits avoid AI');
  h.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});
  const records=h.messages.filter(message=>message.type==='RECORD_TEXT').map(message=>message.item);
  assert(records.some(row=>row.source===canonical&&row.text===translated),'recording keeps shared canonical text');
  assert(!records.some(row=>row.source===canonical&&row.text.includes('レオン')));
  const visible=h.remote().getVisible();await tick();const rows=(await visible).items;
  assert(rows.some(row=>row.source===canonical&&row.text===translated));assert(rows.some(row=>row.source==='アレン、こんにちは'&&row.text==='정확한 원문 우선'));
  h.entry('CACHE_ENTRY_DELETED',canonical);assert.equal(h.labels[1].string,'レオン、こんにちは');assert.equal(h.labels[0].string,'정확한 원문 우선','canonical delete cannot alter exact literal');await h.advance(1000);assert(!h.calls.some(call=>call.type==='TRANSLATE'),'deleted occurrence stays suppressed');
  h=await harness({entries:[[canonical,translated],['アレン、こんにちは','정확한 원문 우선']],warmEntries:[],holdType:'CACHE_LOOKUP'});await h.advance(20);
  h.entry('CACHE_ENTRY_DELETED',canonical);await tick();assert.equal(h.labels[0].string,'정확한 원문 우선','deletion during a pending lookup still checks the exact literal');assert.equal(h.labels[1].string,'レオン、こんにちは');await h.release();await h.advance(1000);assert.equal(h.labels[0].string,'정확한 원문 우선');assert.equal(h.labels[1].string,'レオン、こんにちは','late canonical hit cannot undo deletion');assert(!h.calls.some(call=>call.type==='TRANSLATE'));

  h=await harness({entries:[[canonical,translated]]});await h.advance(40);
  assert.equal(h.labels[0].string,'アレン님, 안녕하세요');assert.equal(h.labels[1].string,'レオン님, 안녕하세요');
  h.entry('CACHE_ENTRY_UPDATED',canonical,'안녕, {USER}님');await h.advance(40);
  assert.equal(h.labels[0].string,'안녕, アレン님');assert.equal(h.labels[1].string,'안녕, レオン님');
  await h.settings({displayName:'용사'});await h.advance(40);assert.equal(h.labels[0].string,'안녕, 용사님');assert.equal(h.labels[1].string,'안녕, 용사님');
  assert(!h.profileCalls.some(value=>value==='setUserName'),'profile is read-only');
  await h.settings({cacheEpoch:'two'});assert.equal(h.labels[0].string,'アレン、こんにちは','cache epoch reset restores original immediately');

  h=await harness({names:null,entries:[[canonical,translated]],holdType:'CACHE_LOOKUP'});await h.advance(20);
  const oldRequest=h.messages.find(message=>message.type==='CANDIDATE').item;
  assert(!('templates' in oldRequest));h.profile(['アレン','レオン']);h.refresh();assert(h.messages.some(message=>message.type==='NAME_BINDING_CHANGED'));
  await h.release();await h.advance(60);assert.equal(h.labels[0].string,'アレン님, 안녕하세요','late profile upgrades an unresolved literal binding');
  h.profile(['カイ','レオン']);h.refresh();assert.equal(h.labels[0].string,'アレン、こんにちは','profile change restores old binding');
  h.send('RESULT',{results:[{id:oldRequest.id,text:'stale {USER}',cacheSource:canonical}]});assert.equal(h.labels[0].string,'アレン、こんにちは','stale result cannot attach to a changed profile');
  h.labels[0].string='カイ、こんにちは';await h.advance(60);assert.equal(h.labels[0].string,'カイ님, 안녕하세요');

  h=await harness({names:['別人','他人'],sources:['勇者、こんにちは'],config:{playerName:'勇者',displayName:'용사'},entries:[[canonical,translated]]});await h.advance(40);assert.equal(h.labels[0].string,'용사님, 안녕하세요');assert.equal(h.profileCalls.length,0,'explicit source override bypasses profile access');
  h=await harness({sources:['<color="アレン">アレン</color>とレオン'],entries:[['<color="アレン">{USER}</color>とレオン','{USER}와 레온'],['<color="アレン">アレン</color>と{USER}','아렌과 {USER}']]});await h.advance(40);
  const two=h.calls.find(call=>call.type==='CACHE_LOOKUP').items[0];assert.equal(two.templates.length,2);assert.equal(two.templates[0],'<color="アレン">{USER}</color>とレオン','markup is protected');assert.equal(h.labels[0].string,'アレン와 레온','first canonical candidate wins');
  h=await harness({config:{cacheEnabled:false},sources:['アレン、こんにちは'],ai:()=>translated});await h.advance(500);assert.equal(h.labels[0].string,'アレン님, 안녕하세요');
  const generated=h.calls.find(call=>call.type==='TRANSLATE').items[0];assert.equal(generated.source,'アレン、こんにちは');assert.deepEqual(Array.from(generated.templates),[canonical],'AI queue forwards canonical alternatives without replacing the literal');
  h.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});const offRecord=h.messages.find(message=>message.type==='RECORD_TEXT');assert.equal(offRecord.item.source,canonical);assert.equal(offRecord.item.text,translated);
  const offVisible=await h.remote().getVisible();assert.equal(offVisible.items[0].source,canonical);assert.equal(offVisible.items[0].text,translated);
  h.entry('CACHE_ENTRY_UPDATED','アレン、こんにちは','개별 번역');assert.equal(h.labels[0].string,'개별 번역');h.entry('CACHE_ENTRY_DELETED',canonical);assert.equal(h.labels[0].string,'개별 번역','new exact literal edit detaches the old canonical alias');
  h=await harness({names:['용사'],sources:['용사'],config:{translateLatin:false,displayName:'주인공'}});await h.advance(500);assert.equal(h.labels[0].string,'주인공','standalone non-Japanese name can use canonical identity');assert.deepEqual(Array.from(h.calls.find(call=>call.type==='TRANSLATE').items[0].templates),['{USER}']);
  h=await harness({sources:['アレン、こんにちは'],holdType:'TRANSLATE',ai:()=>translated});await h.advance(500);h.profile(['カイ','レオン']);h.refresh();h.labels[0].string='カイ、こんにちは';await h.release();assert.equal(h.labels[0].string,'カイ、こんにちは','old AI generation cannot apply to a new name binding');await h.advance(7000);assert.equal(h.labels[0].string,'カイ님, 안녕하세요');
  h=await harness({config:{cacheEnabled:false}});h.entry('CACHE_ENTRY_UPDATED',canonical,'즉시 {USER}');assert.equal(h.labels[0].string,'즉시 アレン');assert.equal(h.labels[1].string,'즉시 レオン');await h.advance(1000);assert(!h.calls.some(call=>call.type==='TRANSLATE'),'canonical manual patch cancels MAIN debounce before TEXT');
  h=await harness({config:{cacheEnabled:false}});h.entry('CACHE_ENTRY_DELETED',canonical);await h.advance(1000);assert.equal(h.labels[0].string,'アレン、こんにちは');assert(!h.calls.some(call=>call.type==='TRANSLATE'),'canonical deletion cancels MAIN debounce before TEXT');

  h=await harness({config:{cacheEnabled:false},holdType:'TRANSLATE',ai:()=>translated});await h.advance(500);
  assert(!h.calls.some(call=>/CACHE_WARM|CACHE_LOOKUP/.test(call.type)));
  h.entry('CACHE_ENTRY_UPDATED',canonical,'수정 {USER}');assert.equal(h.labels[0].string,'수정 アレン');assert.equal(h.labels[1].string,'수정 レオン');
  await h.release();await h.advance(200);assert.equal(h.labels[0].string,'수정 アレン','manual pin beats stale AI');
  const count=h.calls.filter(call=>call.type==='TRANSLATE').length;for(let i=0;i<3;i++)h.labels[0].string=h.labels[0].string;await h.advance(1000);assert.equal(h.calls.filter(call=>call.type==='TRANSLATE').length,count,'cache-off current occurrence stays pinned');
  h.entry('CACHE_ENTRY_DELETED',canonical);assert.equal(h.labels[0].string,'アレン、こんにちは');assert.equal(h.labels[1].string,'レオン、こんにちは');await h.advance(1000);assert.equal(h.calls.filter(call=>call.type==='TRANSLATE').length,count,'canonical delete suppresses immediate AI');
  h.labels[0].string='別の文章';h.labels[0].string='アレン、こんにちは';await h.advance(7000);assert(h.calls.filter(call=>call.type==='TRANSLATE').length>count,'new cache-off occurrence can translate');

  h=await harness({config:{cacheEnabled:false},sources:['アレンとレオン、こんにちは'],holdType:'TRANSLATE'});await h.advance(500);
  h.entry('CACHE_ENTRY_UPDATED','アレンと{USER}、こんにちは','아렌과 {USER}');assert.equal(h.labels[0].string,'아렌과 レオン','pending second-name patch keeps the correct binding');await h.release();assert.equal(h.labels[0].string,'아렌과 レオン');
  h=await harness({config:{cacheEnabled:false,cacheOnly:true},entries:[[canonical,translated]]});await h.advance(1000);assert.equal(h.labels[0].string,'アレン님, 안녕하세요');assert(!h.calls.some(call=>call.type==='TRANSLATE'));
  h=await harness({names:null,sources:['{USER}'],config:{cacheOnly:true}});await h.advance(1000);assert(!h.labels[0].string.includes('{USER}'),'unresolved reserved token is never displayed');assert(!h.calls.some(call=>call.type==='TRANSLATE'));

  // AdvSubRoot substitutes {USER} before logging; backlog then resizes rich tags and removes body newlines.
  // Older exact rows can therefore contain the known nickname in both source and target.
  for(const [alias,displayName]of [['ロングテール','이사무'],['カイ','용사']]){
    const speaker=`<size=24>${alias}</size>`,body=`<size=24>${alias}、こんにちは</size>`,legacy=`<size=24>${alias}님, 안녕하세요</size>`;
    h=await harness({rich:true,className:'AdvRichBackLogText',names:[alias,'別アカウント'],sources:[speaker,body],config:{displayName},entries:[[speaker,speaker],[body,legacy],['<size=24>{USER}、こんにちは</size>','<size=24>다른 자동 {USER}</size>']]});await h.advance(40);
    assert.equal(h.labels[0].string,`<size=24>${displayName}</size>`,'backlog speaker personalizes its source-bound literal nickname');
    assert.equal(h.labels[1].string,`<size=24>${displayName}님, 안녕하세요</size>`,'exact legacy body wins but personalizes its known nickname');
    assert.equal(h.disk.get(body),legacy,'display personalization never rewrites an exact/manual row');
    h.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});
    const legacyRows=h.messages.filter(message=>message.type==='RECORD_TEXT').map(message=>message.item);
    assert(legacyRows.some(row=>row.source===body&&row.text===legacy),'legacy recording preserves the chosen exact durable row');
    const legacyVisible=await h.remote().getVisible();assert(legacyVisible.items.some(row=>row.source===body&&row.text===legacy),'editor retains the original exact/manual value');
    await h.settings({displayName:''});await h.advance(40);assert.equal(h.labels[1].string,legacy,'clearing display override restores literal row display');
    h=await harness({rich:true,className:'AdvRichBackLogText',names:[alias,'別アカウント'],sources:[speaker,body],config:{displayName},entries:[],ai:source=>source.replace('こんにちは','안녕하세요')});await h.advance(500);
    assert.equal(h.labels[0].string,`<size=24>${displayName}</size>`);assert.equal(h.labels[1].string,`<size=24>${displayName}、안녕하세요</size>`);
    assert([...h.disk].every(([source,text])=>source.includes('{USER}')&&text.includes('{USER}')&&!source.includes(alias)&&!text.includes(alias)&&!text.includes(displayName)),'new backlog cache rows retain complete canonical names');
    h.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});
    const freshRows=h.messages.filter(message=>message.type==='RECORD_TEXT').map(message=>message.item);
    assert(freshRows.length>=2);assert(freshRows.every(row=>row.source.includes('{USER}')&&row.text.includes('{USER}')&&!row.text.includes(alias)&&!row.text.includes(displayName)),'new backlog recordings keep canonical source and full target');
  }
  const taggedSpeaker='<color="ロングテール">ロングテール</color>',taggedBody='<color="ロングテール">ロングテール、こんにちは</color>',taggedLegacy='<color="ロングテール">ロングテール님, 수동 번역</color>';
  h=await harness({rich:true,className:'AdvRichBackLogText',names:['ロングテール','別アカウント'],sources:[taggedSpeaker,taggedBody],config:{displayName:'이사무'},entries:[[taggedSpeaker,taggedSpeaker],[taggedBody,taggedLegacy]]});await h.advance(40);
  assert.equal(h.labels[0].string,'<color="ロングテール">이사무</color>','legacy backlog speaker keeps nickname-looking tag attributes untouched');
  assert.equal(h.labels[1].string,'<color="ロングテール">이사무님, 수동 번역</color>','legacy backlog body personalizes visible text, not markup attributes');
  h.entry('CACHE_ENTRY_UPDATED',taggedBody,'<color="ロングテール">ロングテール님, 새 수동 번역</color>');assert.equal(h.labels[1].string,'<color="ロングテール">이사무님, 새 수동 번역</color>');
  const taggedVisible=await h.remote().getVisible();assert(taggedVisible.items.some(row=>row.source===taggedBody&&row.text==='<color="ロングテール">ロングテール님, 새 수동 번역</color>'),'manual literal edit retains its full original source/target bytes');
  const policyWindow={};vm.runInNewContext(fs.readFileSync(path.join(root,'name-policy.js'),'utf8'),{window:policyWindow});
  const namePolicy=policyWindow[Symbol.for('crave-ai-player-names.v1')];
  assert.equal(namePolicy.render('<color="ロングテール">ロングテール</color>と他人 {OTHER}', '이사무',['ロングテール']),'<color="ロングテール">이사무</color>と他人 {OTHER}','literal alias personalization protects attributes and unrelated variables/names');
  assert.equal(namePolicy.render('<color="ロングテール">手動の別人</color>','이사무',['ロングテール']),'<color="ロングテール">手動の別人</color>','aliases in attributes alone are not display names');
  assert.equal(namePolicy.render('ロングテールとカイ','이사무',['ロングテール']),'이사무とカイ','only the bound source alias changes');
  assert.equal(namePolicy.render('{USER}님','이사무',['ロングテール']),'이사무님');
  console.log('PASS names literal precedence/profile bindings/late and stale profile/display override/canonical editing and recording/cache-off regression tests');
})().catch(error=>{console.error(error);process.exitCode=1;});
