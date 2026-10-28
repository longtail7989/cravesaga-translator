/* Offline tests only: no provider credentials, paid calls, or live game interaction. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
const root=process.env.CRAVE_AI_ROOT||path.resolve(__dirname,'..');let passed=0;
const test=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
const C=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'core.mjs')).toString('base64'));
test('legacy mandatory daily cap is migrated off without changing credentials',()=>{const s=C.sanitizeSettings({model:'old-model',apiKey:'FAKE_ONLY',dailyCharLimit:100000});assert.equal(s.dailyCharLimit,0);assert.equal(s.dailyRequestLimit,0);assert.equal(s.model,'old-model');assert.equal(s.apiKey,'FAKE_ONLY');});
test('explicit future limits and timeout bounds are respected',()=>{const s=C.sanitizeSettings({requestTimeoutSeconds:999,dailyCharLimit:1234,dailyRequestLimit:10,retryLimit:99});assert.equal(s.requestTimeoutSeconds,240);assert.equal(s.dailyCharLimit,1234);assert.equal(s.dailyRequestLimit,10);assert.equal(s.retryLimit,20);});
test('default starts disabled and without consent',()=>{assert.equal(C.DEFAULTS.enabled,false);assert.equal(C.DEFAULTS.consent,false);assert.equal(C.isConfigured(C.DEFAULTS),false);});
test('settings strip unknown fields and reject insecure remote endpoint',()=>{assert.throws(()=>C.sanitizeSettings({endpoint:'http://example.com/v1'}));assert.throws(()=>C.sanitizeSettings({endpoint:'https://user:pass@example.com'}));assert.throws(()=>C.sanitizeSettings({endpoint:'https://example.com/?key=secret'}));assert.equal(C.safeEndpoint('http://127.0.0.1:1234/v1/'),'http://127.0.0.1:1234/v1');assert.equal('secretUnknown' in C.sanitizeSettings({secretUnknown:1}),false);});
test('removed CLI provider is read-only migrated paused without API fallback',()=>{for(const provider of ['codex','claude-code']){const old={provider,endpoint:'https://example.com',model:'legacy',apiKey:'FAKE',bridgeToken:'FAKE',enabled:true,consent:true,cacheOnly:true},raw=JSON.stringify(old),s=C.sanitizeSettings(old);assert.equal(s.provider,'removed');assert.equal(s.migrationRequired,'cli-provider-removed');assert.equal(s.enabled,false);assert.equal(s.consent,false);assert.equal(C.isConfigured(s),false);assert.equal(s.apiKey,'');assert(!('bridgeToken' in s));assert.equal(JSON.stringify(old),raw);assert.throws(()=>C.providerRequest(old,{system:'x',user:'y'}));}});
test('all Japanese and optional Latin terms, not plain numbers or Korean',()=>{assert(C.wantsTranslation('こんにちは'));assert(C.wantsTranslation('Wolf'));assert(!C.wantsTranslation('Wolf',false));assert(!C.wantsTranslation('공격력'));assert(!C.wantsTranslation('123.4%'));assert(!C.wantsTranslation('x'.repeat(8193)));});
test('numbers tags variables newlines preserved exactly',()=>{const source='<color=#fff>ATK20%上昇</color>\r\n{value} ３ターン';const p=C.protect(source,'TEST');const out=p.masked.replace('上昇','증가').replace('ターン','턴');assert.equal(C.restore(out,p),'<color=#fff>ATK20%증가</color>\r\n{value} ３턴');});
test('missing/reordered tokens or invented digits fail closed',()=>{const p=C.protect('10%で3ターン','TEST');assert.throws(()=>C.restore('효과',p));assert.throws(()=>C.restore(p.values[1].token+p.values[0].token,p));assert.throws(()=>C.restore(p.masked+'99',p));assert.throws(()=>C.restore(p.masked+'<b>추가</b>',p));});
test('player-name placeholders may move without changing other protected spans',()=>{const record=C.protect('{USER}は10%上昇\n{value}','NAME'),[name,number,newline,variable]=record.values.map(x=>x.token);assert.equal(C.restore('효과 '+number+newline+name+'님 '+variable,record),'효과 10%\n{USER}님 {value}');for(const text of [number+newline+variable,name+name+number+newline+variable,name+newline+number+variable])assert.throws(()=>C.restore(text,record));});
test('source/display nickname settings preserve literal metacharacters but reject markup and oversized names',()=>{const settings=C.sanitizeSettings({playerName:'名$&[x]',displayName:'별명'});assert.equal(settings.playerName,'名$&[x]');assert.equal(C.sanitizeSettings({playerName:'名'.repeat(64)}).playerName.length,64);for(const playerName of ['x'.repeat(65),'<b>name</b>','{USER}','name\nnext'])assert.throws(()=>C.sanitizeSettings({playerName}));});
test('JSON response validation rejects missing and duplicate ids',()=>{const m=C.parseTranslations('{"translations":[{"id":"a","text":"공격"}]}',['a']);assert.equal(m.get('a'),'공격');assert.throws(()=>C.parseTranslations('{"translations":[]}', ['a']));assert.throws(()=>C.parseTranslations('{"translations":[{"id":"x","text":"공격"}]}',['a']));});
test('legacy v0.1 migration key retains endpoint model target and prompt version',()=>{const a=C.cacheIdentity(C.DEFAULTS,'攻撃');assert.notEqual(a,C.cacheIdentity({...C.DEFAULTS,endpoint:'https://other.example/v1'},'攻撃'));assert.notEqual(a,C.cacheIdentity({...C.DEFAULTS,model:'other'},'攻撃'));assert.notEqual(a,C.cacheIdentity({...C.DEFAULTS,target:'English'},'攻撃'));});
test('legacy v0.1 migration key also isolates context',()=>assert.notEqual(C.cacheIdentity(C.DEFAULTS,'攻撃','Skill'),C.cacheIdentity(C.DEFAULTS,'攻撃','Story')));
test('provider requests route keys only to configured service',()=>{const s={...C.DEFAULTS,model:'test-model',apiKey:'TEST_NOT_REAL'};let r=C.providerRequest(s,{system:'s',user:'u'});assert.equal(r.url,'https://api.openai.com/v1/chat/completions');assert.equal(r.headers.Authorization,'Bearer TEST_NOT_REAL');r=C.providerRequest({...s,provider:'gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta'},{system:'s',user:'u'});assert.equal(r.headers['x-goog-api-key'],'TEST_NOT_REAL');assert(!r.url.includes('TEST_NOT_REAL'));assert(!r.headers.Authorization);r=C.providerRequest({...s,provider:'anthropic',endpoint:'https://api.anthropic.com/v1'},{system:'s',user:'u'});assert.equal(r.url,'https://api.anthropic.com/v1/messages');assert.equal(r.headers['x-api-key'],'TEST_NOT_REAL');});
test('public config never contains endpoint/key/token',()=>{const c=C.publicConfig({...C.DEFAULTS,apiKey:'SECRET_A',bridgeToken:'SECRET_B'});assert(!JSON.stringify(c).includes('SECRET'));assert(!('endpoint'in c));assert.equal(C.redact('key SECRET_A',{apiKey:'SECRET_A'}),'key [redacted]');});
function makeEngine({conflict=false,typewriter=false}={}){
 const messages=[],listeners={},timeouts=new Map(),nativeWrites=[];let timerId=0;const settle=()=>{const callbacks=[...timeouts.values()];timeouts.clear();for(const fn of callbacks)fn();};class Base{get string(){return this._s||'';}set string(v){this._s=String(v);nativeWrites.push({label:this,text:this._s});}}class Label extends Base{}class RichText extends Base{};
 // Public AdvText retains parsed plain text before its native prefix setter, including while inactive.
 class AdvText extends Label{getPlaneText(){return this._planeText;}getMaxLength(){return this._maxLength;}setCustomText(source,length){this.node.activeInHierarchy=false;this._planeText=source;this._maxLength=source.length;this.setDispLength(length);this.node.activeInHierarchy=true;}setDispLength(length){this._dispLength=Math.min(length,this.getMaxLength());this.string=this._planeText.substring(0,this._dispLength);}}
 const label=typewriter?new AdvText():new Label(),node={name:'StoryText',activeInHierarchy:true,_components:[label],children:[],parent:null};label.node=node;Object.assign(label,{font:{original:true},fontFamily:'JP',useSystemFont:false,fontSize:24,lineHeight:26,cacheMode:1,enableWrapText:true,overflow:0});if(typewriter)label.setCustomText('こんにちは。',1);else label.string='こんにちは';
 const scene={name:'Scene',_components:[],children:[node],parent:null};node.parent=scene;
 const cc={Label,RichText,isValid:()=>true,director:{getScene:()=>scene},js:{getClassName:c=>c instanceof AdvText?'AdvText':c instanceof Label?'cc.Label':'Story'}};
 const window={cc,postMessage:m=>messages.push(m),addEventListener:(t,fn)=>listeners[t]=fn};
 const context=vm.createContext({window,cc,document:{hidden:false,getElementById:()=>conflict?{}:null},location:{origin:'https://gg-client-r.crave-saga.net'},setInterval:()=>1,clearInterval(){},setTimeout:fn=>{const id=++timerId;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),console,Map,Set,Symbol});
 for(const name of ['dialogue-text.js','name-policy.js','story-policy.js','main.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context);
 const send=(type,payload={})=>listeners.message({source:window,origin:'https://gg-client-r.crave-saga.net',data:{channel:'crave-ai-translator/v1',from:'bridge',type,...payload}});
 const enable=(flush=true,override={})=>{send('CONFIG',{config:{enabled:true,configured:true,provider:'custom',model:'mock',target:'한국어',translateLatin:true,fontFamily:'KR',cacheEpoch:'one',...override}});if(flush)settle();};
 return {label,scene,window,messages,send,enable,settle,nativeWrites,refresh:()=>window[Symbol.for('crave-ai-translator.v1')].refresh(),dispose:()=>window[Symbol.for('crave-ai-translator.v1')].dispose()};
}
test('engine captures story labels without allowlist and swaps only after result',()=>{const e=makeEngine();assert.equal(e.messages.filter(x=>x.type==='TEXT').length,0);e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;assert.equal(item.source,'こんにちは');assert.equal(e.label.string,'こんにちは');e.send('RESULT',{results:[{id:item.id,text:'안녕하세요'}]});assert.equal(e.label.string,'안녕하세요');assert.equal(e.label.fontFamily,'KR');e.send('CONFIG',{config:{enabled:false,configured:true,provider:'custom',model:'mock',target:'한국어',fontFamily:'KR',translateLatin:true,cacheEpoch:'one'}});assert.equal(e.label.string,'こんにちは');assert.equal(e.label.fontFamily,'JP');});
test('late result cannot replace newer dialogue',()=>{const e=makeEngine();e.enable();const old=e.messages.find(x=>x.type==='TEXT').item;e.label.string='さようなら';e.send('RESULT',{results:[{id:old.id,text:'이전 대사'}]});assert.equal(e.label.string,'さようなら');});
test('unchanged config polling does not re-request pending labels',()=>{const e=makeEngine();e.enable();const count=e.messages.filter(x=>x.type==='TEXT').length;e.enable();assert.equal(e.messages.filter(x=>x.type==='TEXT').length,count);});
test('existing patch conflict stops without altering original setter',()=>{const e=makeEngine({conflict:true});assert(e.messages.some(x=>x.type==='ERROR'));e.enable();assert.equal(e.messages.filter(x=>x.type==='TEXT').length,0);assert.equal(e.label.string,'こんにちは');});
test('warm candidate response bypasses settle and AI text emission',()=>{const e=makeEngine();e.enable(false);const item=e.messages.find(x=>x.type==='CANDIDATE').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요'}]});e.settle();assert.equal(e.label.string,'안녕하세요');assert.equal(e.messages.filter(x=>x.type==='TEXT').length,0);});
test('typewriter prefixes use one complete source and progressively reveal the resolved Korean',()=>{
 const e=makeEngine({typewriter:true});e.enable(false);const item=e.messages.find(x=>x.type==='CANDIDATE').item;
 assert.equal(item.source,'こんにちは。');assert.equal(e.label.string,'こ');e.label.setDispLength(2);assert.equal(e.label.string,'こん');
 assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,1);assert.equal(e.messages.filter(x=>x.type==='TEXT').length,0);
 e.settle();const emitted=e.messages.filter(x=>x.type==='TEXT');assert.equal(emitted.length,1);assert.equal(emitted[0].item.source,'こんにちは。');
 e.send('RESULT',{results:[{id:item.id,text:'안녕하세요.'}]});assert.equal(e.label.string,'안녕');
 for(const [length,text]of [[3,'안녕하'],[4,'안녕하세'],[5,'안녕하세요'],[6,'안녕하세요.']]){e.label.setDispLength(length);assert.equal(e.label.string,text);e.refresh();assert.equal(e.label.string,text);}
 assert.equal(e.label.getPlaneText(),'こんにちは。');assert.equal(e.label._dispLength,6);assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,1);assert.equal(e.messages.filter(x=>x.type==='TEXT').length,1);
});
test('cached dialogue reveals empty and later native frames synchronously without Japanese writes',()=>{
 const e=makeEngine({typewriter:true});e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요.'}]});
 e.label.setCustomText('別の文章',1);e.refresh();const count=e.messages.filter(x=>x.type==='CANDIDATE').length,before=e.nativeWrites.length;
 e.label.setCustomText('こんにちは。',0);assert.equal(e.label.string,'');assert.equal(e.label._dispLength,0);
 for(const [length,text]of [[1,'안'],[2,'안녕'],[4,'안녕하세'],[6,'안녕하세요.']]){e.label.setDispLength(length);assert.equal(e.label.string,text);}
 assert.deepEqual(e.nativeWrites.slice(before).map(x=>x.text),['','안','안녕','안녕하세','안녕하세요.']);
 assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,count);
});
test('same-prefix complete dialogue switches cache identities and projects each matching translation',()=>{
 const e=makeEngine({typewriter:true});e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,text:'첫 인사'}]});
 e.label.setCustomText('こんばんは。',1);assert.equal(e.label.string,'こ');e.refresh();const second=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;
 assert.equal(second.source,'こんばんは。');assert.notEqual(second.cacheId,first.cacheId);e.send('RESULT',{results:[{id:second.id,text:'저녁 인사'}]});
 const n=e.messages.filter(x=>x.type==='CANDIDATE').length;e.label.setCustomText('こんにちは。',1);assert.equal(e.label.string,'첫');
 e.label.setCustomText('こんばんは。',1);assert.equal(e.label.string,'저');e.label.setDispLength(2);assert.equal(e.label.string,'저');
 e.label.setDispLength(6);assert.equal(e.label.string,'저녁 인사');assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,n);
});
test('late response rechecks changed full dialogue even before its identical native prefix is reassigned',()=>{
 const e=makeEngine({typewriter:true});e.enable();const old=e.messages.find(x=>x.type==='TEXT').item;e.label._planeText='こんばんは。';e.label._maxLength=e.label._planeText.length;
 e.send('RESULT',{results:[{id:old.id,text:'이전 대사'}]});assert.equal(e.label.string,'こ');const current=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;
 assert.equal(current.source,'こんばんは。');assert.notEqual(current.id,old.id);e.send('RESULT',{results:[{id:current.id,text:'새 대사'},{id:old.id,text:'아직 늦은 대사'}]});
 assert.equal(e.label.string,'새');e.label.setDispLength(2);assert.equal(e.label.string,'새');e.label.setDispLength(6);assert.equal(e.label.string,'새 대사');
});
test('AI arriving at native completion displays the full translation without replaying typing',()=>{
 const e=makeEngine({typewriter:true});e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;
 e.label.setDispLength(6);assert.equal(e.label.string,'こんにちは。');e.send('RESULT',{results:[{id:item.id,text:'늦게 도착한 완전한 번역'}]});
 assert.equal(e.label.string,'늦게 도착한 완전한 번역');e.refresh();assert.equal(e.label.string,'늦게 도착한 완전한 번역');
 assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,1);assert.equal(e.label._dispLength,6);
});
test('missing and deleted full dialogue keep native animation and deletion cancels prefix re-requests',()=>{const e=makeEngine({typewriter:true});e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,missing:true}]});e.label.setDispLength(2);assert.equal(e.label.string,'こん');assert.equal(e.label.fontFamily,'JP');e.send('CACHE_REFRESH');const pending=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;e.send('RESULT',{results:[{id:pending.id,text:'인사'}]});e.label.setDispLength(3);e.send('CACHE_ENTRY_DELETED',{ids:[pending.cacheId]});assert.equal(e.label.string,'こんに');assert.equal(e.label.fontFamily,'JP');const n=e.messages.filter(x=>x.type==='CANDIDATE').length;for(const length of [4,5,6]){e.label.setDispLength(length);assert.equal(e.label.string,e.label.getPlaneText().substring(0,length));}e.send('RESULT',{results:[{id:pending.id,text:'삭제 전 늦은 번역'}]});e.settle();assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,n);assert.equal(e.label.string,'こんにちは。');});
test('disable dispose and scene removal restore the latest native prefix and original font',()=>{for(const action of ['disable','dispose','remove']){const e=makeEngine({typewriter:true});e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요.'}]});e.label.setDispLength(3);assert.equal(e.label.string,'안녕하');if(action==='disable')e.enable(false,{enabled:false});else if(action==='dispose')e.dispose();else{e.scene.children=[];e.refresh();}assert.equal(e.label.string,'こんに',action);assert.equal(e.label.fontFamily,'JP',action);assert.equal(e.label._dispLength,3,action);assert.equal(e.label.getPlaneText(),'こんにちは。',action);}});
test('cache Off keeps one full request and progressively reveals resolved or manually pinned Korean',()=>{
 const e=makeEngine({typewriter:true});e.enable(false,{cacheEnabled:false});const item=e.messages.find(x=>x.type==='CANDIDATE').item;e.label.setDispLength(2);
 assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,1);assert.equal(item.source,'こんにちは。');e.send('RESULT',{results:[{id:item.id,text:'새 인사 번역'}]});
 e.label.setDispLength(3);assert.equal(e.label.string,'새 인');e.send('MANUAL_PATCH',{ids:[item.cacheId],text:'직접 고친 인사'});e.send('RESULT',{results:[{id:item.id,text:'늦은 자동 번역'}]});
 for(const [length,text]of [[4,'직접 고친'],[5,'직접 고친 '],[6,'직접 고친 인사']]){e.label.setDispLength(length);e.refresh();assert.equal(e.label.string,text);}
 e.settle();assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,1);assert.equal(e.messages.filter(x=>x.type==='TEXT').length,0);
});
test('typewriter names editor and recording retain complete canonical values while only UI progresses',()=>{
 const e=makeEngine({typewriter:true}),source='アレン、攻撃力が10%上昇する。\n次の行',canonical=source.replace('アレン','{USER}'),text='{USER}님, 공격력이 10% 상승합니다.\n다음 줄',full=text.replace('{USER}','별명');
 e.label.setCustomText(source,0);e.enable(false,{playerName:'アレン',displayName:'별명'});const item=e.messages.find(x=>x.type==='CANDIDATE').item;
 assert.equal(item.source,source);assert.equal(item.templates[0],canonical);e.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});
 e.send('RESULT',{results:[{id:item.id,text,cacheSource:canonical}]});assert.equal(e.label.string,'');
 for(const length of [0,1,2,3,4,source.length]){
  e.label.setDispLength(length);assert(full.startsWith(e.label.string));assert(!e.label.string.includes('{USER}'));
  if(length===0)assert.equal(e.label.string,'');else if(length===source.length)assert.equal(e.label.string,full);else assert(e.label.string.length>0&&e.label.string.length<full.length);
  e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'v'+length});const row=e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items[0];
  assert.equal(row.source,canonical);assert.equal(row.text,text);assert.equal(row.key,item.cacheId);
 }
 const rows=e.messages.filter(x=>x.type==='RECORD_TEXT');assert.equal(rows.length,1);assert.equal(rows[0].item.source,canonical);assert.equal(rows[0].item.text,text);
 assert.equal(e.label._dispLength,source.length);assert.equal(e.label.getPlaneText(),source);e.settle();assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,1);assert.equal(e.messages.filter(x=>x.type==='TEXT').length,0);
});
test('an empty or original-equal projected prefix remains editable with full canonical text',()=>{
 const e=makeEngine({typewriter:true});e.label.setCustomText('こんにちは。',0);e.enable(false);const item=e.messages.find(x=>x.type==='CANDIDATE').item;
 e.send('RESULT',{results:[{id:item.id,text:'こ와 함께'}]});
 for(const length of [0,1,2,1]){e.label.setDispLength(length);assert.equal(e.label.string,length===0?'':'こ');e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'v'+length});
  const row=e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items[0];assert.equal(row.source,'こんにちは。');assert.equal(row.text,'こ와 함께');
 }
 e.label.setDispLength(6);assert.equal(e.label.string,'こ와 함께');assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,1);
});
test('same-page translated source is reused synchronously',()=>{const e=makeEngine();e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요'}]});e.label.string='別の文章';const count=e.messages.filter(x=>x.type==='CANDIDATE').length;e.label.string='こんにちは';assert.equal(e.label.string,'안녕하세요');assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,count);});
test('same source in a new context uses only the Korean native setter synchronously',()=>{const e=makeEngine();e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요'}]});const other=new e.label.constructor();other.node={activeInHierarchy:true,_components:[other,{}],children:[],parent:null};const before=e.nativeWrites.length;other.string='こんにちは';assert.equal(other.string,'안녕하세요');assert.deepEqual(e.nativeWrites.slice(before).map(x=>x.text),['안녕하세요']);});
test('provider and model changes do not partition page translation identity',()=>{const e=makeEngine();e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요'}]});e.send('CONFIG',{config:{enabled:true,configured:true,provider:'different',model:'changed',target:'한국어',translateLatin:true,fontFamily:'KR',cacheEpoch:'one'}});e.label.string='こんにちは';assert.equal(e.label.string,'안녕하세요');});
test('MAIN memory evicts beyond 5000 entries and keeps recently touched sources',()=>{const e=makeEngine();e.enable();for(let i=0;i<5001;i++){e.label.string='文章'+i;const item=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;e.send('RESULT',{results:[{id:item.id,text:'문장'+i}]});if(i===4999)e.label.string='文章0';}e.label.string='文章0';assert.equal(e.label.string,'문장0');e.label.string='文章1';assert.equal(e.label.string,'文章1');});
test('raw whitespace and Unicode forms remain distinct cache identities',()=>{const e=makeEngine();e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요'}]});e.label.string='こんにちは ';assert.equal(e.label.string,'こんにちは ');e.label.string='こんにちは';assert.equal(e.label.string,'안녕하세요');e.label.string='ガ';const last=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;e.send('RESULT',{results:[{id:last.id,text:'가'}]});e.label.string='ガ';assert.equal(e.label.string,'ガ');});
test('MAIN memory is also bounded by 8MiB of source and text',()=>{const e=makeEngine();e.enable();for(let i=0;i<100;i++){e.label.string='容量'+i;const item=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;e.send('RESULT',{results:[{id:item.id,text:'가'.repeat(50000)}]});}e.label.string='容量0';assert.equal(e.label.string,'容量0');e.label.string='容量99';assert.equal(e.label.string,'가'.repeat(50000));});
test('cache-only configuration needs no API credentials or consent',()=>assert.equal(C.isConfigured({...C.DEFAULTS,cacheOnly:true}),true));
test('cache Off bypasses MAIN memory for a repeated source without scan-request floods',()=>{const e=makeEngine();e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,text:'저장 번역'}]});e.send('CONFIG',{config:{enabled:true,configured:true,cacheEnabled:false,target:'한국어',cacheEpoch:'one',translateLatin:true}});assert.equal(e.label.string,'저장 번역');e.settle();let last=e.messages.filter(x=>x.type==='TEXT').at(-1).item;assert.notEqual(last.id,first.id);e.send('RESULT',{results:[{id:last.id,text:'새 번역'}]});const n=e.messages.filter(x=>x.type==='CANDIDATE').length;for(let i=0;i<15;i++)e.label.string='こんにちは';assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,n);e.label.string='別の文章';e.label.string='こんにちは';e.settle();assert.equal(e.label.string,'こんにちは');assert(e.messages.filter(x=>x.type==='TEXT').length>=3);});
test('visible translation list is explicit bounded active-only and contains no settings',()=>{const e=makeEngine();e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,text:'화면 번역'}]});e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'v1'});let result=e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1);assert.equal(result.target,'한국어');assert.equal(result.items.length,1);assert.equal(result.items[0].source,'こんにちは');assert.equal(result.items[0].text,'화면 번역');assert(/^e\d+s\d+$/.test(result.items[0].key));assert(!JSON.stringify(result).includes('apiKey'));e.label.node.activeInHierarchy=false;e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'v2'});assert.equal(e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items.length,0);});
test('Off manual patch applies only known opaque IDs, cancels late result and does not request a model',()=>{const e=makeEngine();e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,text:'원래 번역'}]});e.send('CONFIG',{config:{enabled:true,configured:true,cacheEnabled:false,target:'한국어',cacheEpoch:'one',translateLatin:true}});e.settle();const pending=e.messages.filter(x=>x.type==='TEXT').at(-1).item;const before=e.messages.filter(x=>x.type==='TEXT').length;e.send('MANUAL_PATCH',{ids:[pending.cacheId],text:'직접 수정'});assert.equal(e.label.string,'직접 수정');e.send('RESULT',{results:[{id:pending.id,text:'늦은 자동 번역'}]});assert.equal(e.label.string,'직접 수정');for(let i=0;i<5;i++)e.label.string='こんにちは';e.settle();assert.equal(e.label.string,'직접 수정');assert.equal(e.messages.filter(x=>x.type==='TEXT').length,before);e.send('MANUAL_PATCH',{ids:['not-an-engine-id'],text:'잘못된 수정'});assert.equal(e.label.string,'직접 수정');});
test('cacheOnly wins over cache Off in MAIN and no regeneration is emitted for a cached occurrence',()=>{const e=makeEngine();e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,text:'보존 번역'}]});e.send('CONFIG',{config:{enabled:true,configured:true,cacheEnabled:false,cacheOnly:true,target:'한국어',cacheEpoch:'one',translateLatin:true}});const item=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;e.send('RESULT',{results:[{id:item.id,text:'보존 번역'}]});e.settle();const before=e.messages.filter(x=>x.type==='TEXT').length;e.label.string='こんにちは';e.settle();assert.equal(e.label.string,'보존 번역');assert.equal(e.messages.filter(x=>x.type==='TEXT').length,before);});
test('editor keeps active translated labels despite unreliable camera opacity and component flags',()=>{const e=makeEngine();e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,text:'표시 번역'}]});e.label.enabledInHierarchy=false;e.scene.opacity=0;e.window.cc.Canvas=class{};e.scene.getComponent=Type=>Type===e.window.cc.Canvas?{}:null;e.scene.getBoundingBoxToWorld=()=>({x:0,y:0,width:100,height:100});e.label.node.getBoundingBoxToWorld=()=>({x:120,y:-300,width:10,height:0});e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'v1'});assert.equal(e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items.length,1);e.label.node.activeInHierarchy=false;e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'v2'});assert.equal(e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items.length,0);});
test('game reassigning its already translated label cannot erase the exact original for editing',()=>{const e=makeEngine();e.enable();const item=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:item.id,text:'안녕하세요'}]});e.label.string=e.label.string;e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'v1'});const row=e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items[0];assert.equal(row.source,'こんにちは');assert.equal(row.text,'안녕하세요');const before=e.messages.filter(x=>x.type==='TEXT').length;e.settle();assert.equal(e.messages.filter(x=>x.type==='TEXT').length,before);});
test('canonical aliases use the newest accepted wording when the next recording starts',()=>{for(const cacheEnabled of [false,true]){
 const e=makeEngine({typewriter:true});class Backlog extends e.window.cc.RichText{}
 const name=e.window.cc.js.getClassName;e.window.cc.js.getClassName=c=>c instanceof Backlog?'AdvRichBackLogText':name(c);
 const other=new Backlog();other.node={activeInHierarchy:true,_components:[other],children:[],parent:e.scene};e.scene.children.push(other.node);
 other.string='別の文章';e.enable(false,{cacheEnabled});
 const first=e.messages.find(x=>x.type==='CANDIDATE'&&x.item.source==='こんにちは。').item;
 e.send('RESULT',{results:[{id:first.id,text:'처음 번역',cacheSource:first.source}]});
 const wrapped='<size=24>こんにちは。</size>';other.string=wrapped;
 const second=e.messages.filter(x=>x.type==='CANDIDATE'&&x.item.source===wrapped).at(-1).item;
 e.send('RESULT',{results:[{id:second.id,text:'다시 번역',cacheSource:first.source}]});
 e.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000002',requestId:'d2'});
 assert.deepEqual(e.messages.filter(x=>x.type==='RECORD_TEXT').map(x=>x.item.text),['다시 번역'],'record insertion order cannot reintroduce an older alias translation');
 assert.equal(e.label.string,'다');assert.equal(other.string,'<size=24>다시 번역</size>');
 e.refresh();e.label.setDispLength(2);other.string=wrapped;
 assert.equal(e.label.string,'다');assert.equal(other.string,'<size=24>다시 번역</size>');e.label.setDispLength(6);assert.equal(e.label.string,'다시 번역');
}});
test('a pending canonical alias keeps its own newer result in a mixed result batch',()=>{
 const e=makeEngine({typewriter:true});e.enable(false);
 const first=e.messages.find(x=>x.type==='CANDIDATE').item;class Backlog extends e.window.cc.RichText{}
 const name=e.window.cc.js.getClassName;e.window.cc.js.getClassName=c=>c instanceof Backlog?'AdvRichBackLogText':name(c);
 const other=new Backlog();other.node={activeInHierarchy:true,_components:[other],children:[],parent:e.scene};e.scene.children.push(other.node);
 const wrapped='<size=24>こんにちは。</size>';other.string=wrapped;
 const second=e.messages.filter(x=>x.type==='CANDIDATE'&&x.item.source===wrapped).at(-1).item;
 e.send('RESULT',{results:[{id:first.id,text:'먼저 읽은 번역',cacheSource:first.source},{id:second.id,text:'나중에 저장된 번역',cacheSource:first.source}]});
 assert.equal(e.label.string,'나');assert.equal(other.string,'<size=24>나중에 저장된 번역</size>');
 e.refresh();e.label.setDispLength(2);other.string=wrapped;
 assert.equal(e.label.string,'나중에');assert.equal(other.string,'<size=24>나중에 저장된 번역</size>');e.label.setDispLength(6);assert.equal(e.label.string,'나중에 저장된 번역');
});
test('resolved canonical typewriter peers synchronize full wording using their own original progress',()=>{for(const cacheEnabled of [false,true]){
 const e=makeEngine({typewriter:true});e.enable(false,{cacheEnabled});const first=e.messages.find(x=>x.type==='CANDIDATE').item;
 e.send('RESULT',{results:[{id:first.id,text:'이전 번역',cacheSource:first.source}]});
 const other=new e.label.constructor();other.node={activeInHierarchy:true,_components:[other],children:[],parent:e.scene};e.scene.children.push(other.node);
 other.setCustomText('こん\nにちは。',5);e.refresh();const second=e.messages.filter(x=>x.type==='CANDIDATE'&&x.item.source==='こん\nにちは。').at(-1).item;
 e.send('RESULT',{results:[{id:second.id,text:'가나다라마바사아자차카타',cacheSource:first.source}]});
 assert.equal(e.label.string,'가나');assert.equal(other.string,'가나다라마바사아');
 const requests=e.messages.filter(x=>x.type==='CANDIDATE').length;e.label.setDispLength(3);e.refresh();
 assert.equal(e.label.string,'가나다라마바');assert.equal(other.string,'가나다라마바사아');
 e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'peers'});const rows=e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items;
 assert.equal(rows.length,1);assert.equal(rows[0].source,first.source);assert.equal(rows[0].text,'가나다라마바사아자차카타');
 e.label.setDispLength(6);assert.equal(e.label.string,'가나다라마바사아자차카타');assert.equal(other.string,'가나다라마바사아');
 other.setDispLength(7);assert.equal(other.string,'가나다라마바사아자차카타');assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,requests);
}});
test('Off manual typewriter pins survive a pending canonical peer result at different progress',()=>{
 const e=makeEngine({typewriter:true});e.enable(false,{cacheEnabled:false});const first=e.messages.find(x=>x.type==='CANDIDATE').item;
 e.send('RESULT',{results:[{id:first.id,text:'처음 번역',cacheSource:first.source}]});e.label.setDispLength(2);
 const other=new e.label.constructor();other.node={activeInHierarchy:true,_components:[other],children:[],parent:e.scene};e.scene.children.push(other.node);
 other.setCustomText('こん\nにちは。',5);e.refresh();const second=e.messages.filter(x=>x.type==='CANDIDATE'&&x.item.source==='こん\nにちは。').at(-1).item;
 e.send('MANUAL_PATCH',{ids:[first.cacheId],text:'수동으로 고친 대사'});assert.equal(e.label.string,'수동으');
 e.send('RESULT',{results:[{id:second.id,text:'가나다라마바사아자차카타',cacheSource:first.source},{id:first.id,text:'늦은 자동 번역'}]});
 assert.equal(e.label.string,'수동으');assert.equal(other.string,'가나다라마바사아');
 e.label.setDispLength(3);e.refresh();assert.equal(e.label.string,'수동으로 ');assert.equal(other.string,'가나다라마바사아');
 e.label.setDispLength(6);assert.equal(e.label.string,'수동으로 고친 대사');other.setDispLength(7);assert.equal(other.string,'가나다라마바사아자차카타');
 e.settle();assert.equal(e.messages.filter(x=>x.type==='CANDIDATE').length,2);assert.equal(e.messages.filter(x=>x.type==='TEXT').length,0);
});
test('backlog literal and canonical nickname rows personalize UI without changing editor or capture values',()=>{for(const canonical of [false,true]){
 const e=makeEngine();class Backlog extends e.window.cc.RichText{}const className=e.window.cc.js.getClassName;
 e.window.cc.js.getClassName=c=>c instanceof Backlog?'AdvRichBackLogText':className(c);
 const other=new Backlog();other.node={activeInHierarchy:true,_components:[other],children:[],parent:e.scene};e.scene.children.push(other.node);
 const raw='<size=24>アレン、レオンと10%上昇。</size>',source=canonical?raw.replace('アレン','{USER}'):raw,text='<size=24>'+(canonical?'{USER}':'アレン')+'님, レオン과 10% 상승.</size>';
 other.string=raw;e.enable(false,{playerName:'アレン',displayName:'별명'});const item=e.messages.find(x=>x.type==='CANDIDATE'&&x.item.source===raw).item;
 e.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});e.send('RESULT',{results:[{id:item.id,text,cacheSource:source}]});
 assert.equal(other.string,'<size=24>별명님, レオン과 10% 상승.</size>');
 e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'names'});let rows=e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items;
 assert.equal(rows.length,1);assert.equal(rows[0].source,source);assert.equal(rows[0].text,text);
 const manual='<size=24>アレン님, 직접 고친 10%.</size>';e.send('MANUAL_PATCH',{ids:[item.cacheId],text:manual});
 assert.equal(other.string,'<size=24>별명님, 직접 고친 10%.</size>');e.send('VISIBLE_TRANSLATIONS_REQUEST',{requestId:'manual'});
 rows=e.messages.filter(x=>x.type==='VISIBLE_TRANSLATIONS').at(-1).items;assert.equal(rows[0].source,source);assert.equal(rows[0].text,manual);
 const captures=e.messages.filter(x=>x.type==='RECORD_TEXT');assert.deepEqual(captures.map(x=>x.item.source),[source,source]);assert.deepEqual(captures.map(x=>x.item.text),[text,manual]);
 const speaker=new Backlog();speaker.node={activeInHierarchy:true,_components:[speaker],children:[],parent:e.scene};e.scene.children.push(speaker.node);speaker.string='アレン';
 const name=e.messages.filter(x=>x.type==='CANDIDATE'&&x.item.source==='アレン').at(-1).item;e.send('RESULT',{results:[{id:name.id,text:'アレン',cacheSource:'アレン'}]});assert.equal(speaker.string,'별명');
}});
test('configured nickname never rewrites an unbound name merely appearing in a translation',()=>{
 const e=makeEngine();e.enable(false,{playerName:'アレン',displayName:'별명'});const item=e.messages.find(x=>x.type==='CANDIDATE').item;
 e.send('RESULT',{results:[{id:item.id,text:'アレン과 함께'}]});assert.equal(e.label.string,'アレン과 함께');
});
test('Off canonical aliases record new translations but never re-record an older unchanged redraw',()=>{
 const e=makeEngine({typewriter:true});e.enable(false,{cacheEnabled:false});
 const first=e.messages.find(x=>x.type==='CANDIDATE').item,canonical=first.source;
 e.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});
 e.send('RESULT',{results:[{id:first.id,text:'처음 번역',cacheSource:canonical}]});
 class Backlog extends e.window.cc.RichText{}
 const name=e.window.cc.js.getClassName;e.window.cc.js.getClassName=c=>c instanceof Backlog?'AdvRichBackLogText':name(c);
 const other=new Backlog();other.node={activeInHierarchy:true,_components:[other],children:[],parent:e.scene};e.scene.children.push(other.node);
 const wrapped='<size=24>こんにちは。</size>';other.string=wrapped;e.refresh();
 const second=e.messages.filter(x=>x.type==='CANDIDATE'&&x.item.source===wrapped).at(-1).item;
 e.send('RESULT',{results:[{id:second.id,text:'다시 번역',cacheSource:canonical}]});
 const captures=()=>e.messages.filter(x=>x.type==='RECORD_TEXT');
 assert.deepEqual(captures().map(x=>x.item.text),['처음 번역','다시 번역']);
 const before=captures().length;e.refresh();e.label.setDispLength(2);other.string=wrapped;e.refresh();
 assert.equal(captures().length,before,'native typing and scans must not resend the old canonical wording');
 e.send('MANUAL_PATCH',{ids:[second.cacheId],text:'직접 고친 번역'});
 assert.equal(captures().at(-1).item.text,'직접 고친 번역','an actual edit remains a new recorded translation');
 const afterEdit=captures().length;e.refresh();e.label.setDispLength(3);other.string=wrapped;
 assert.equal(captures().length,afterEdit,'redraws cannot overwrite a newly recorded manual translation either');
});
test('recording Start captures current/new applied translations, deduplicates and stops without AI requests',()=>{const e=makeEngine();e.enable();const first=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:first.id,text:'안녕하세요'}]});const n=e.messages.filter(x=>x.type==='TEXT').length;const id='dist:00000000-0000-4000-8000-000000000001';e.send('RECORDING_STATE',{active:true,id,requestId:'d1'});let rows=e.messages.filter(x=>x.type==='RECORD_TEXT');assert.equal(rows.length,1);assert.equal(rows[0].item.source,'こんにちは');assert.equal(rows[0].item.text,'안녕하세요');for(let i=0;i<3;i++)e.label.string=e.label.string;assert.equal(e.messages.filter(x=>x.type==='RECORD_TEXT').length,1);e.send('RECORDING_STATE',{active:false,id:null,requestId:'d2'});e.label.string='別の文';const other=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;e.send('RESULT',{results:[{id:other.id,text:'다른 문장'}]});assert.equal(e.messages.filter(x=>x.type==='RECORD_TEXT').length,1);assert.equal(e.messages.filter(x=>x.type==='TEXT').length,n);assert(e.messages.some(x=>x.type==='RECORDING_ACK'&&x.requestId==='d2'));});
test('recording captures synchronous MAIN memory reuse immediately, without another scan or AI',()=>{const e=makeEngine();e.enable();const one=e.messages.find(x=>x.type==='TEXT').item;e.send('RESULT',{results:[{id:one.id,text:'안녕하세요'}]});e.label.string='別の文';const two=e.messages.filter(x=>x.type==='CANDIDATE').at(-1).item;e.send('RESULT',{results:[{id:two.id,text:'다른 문장'}]});e.label.string='こんにちは';const n=e.messages.filter(x=>x.type==='TEXT').length;e.send('RECORDING_STATE',{active:true,id:'dist:00000000-0000-4000-8000-000000000001',requestId:'d1'});e.label.string='別の文';const rows=e.messages.filter(x=>x.type==='RECORD_TEXT');assert.equal(rows.length,2);assert.equal(rows[1].item.source,'別の文');assert.equal(rows[1].item.text,'다른 문장');assert.equal(e.messages.filter(x=>x.type==='TEXT').length,n);});
test('all JavaScript parses and manifest has no dangerous general permissions',()=>{for(const name of ['main.js','content.js','game-remote.js','distribution-client.js','options.js','popup.js']){const p=path.join(root,name);if(fs.existsSync(p))new vm.Script(fs.readFileSync(p,'utf8'),{filename:name});}for(const name of ['core.mjs','cache.mjs','cache-store.mjs','reliability.mjs','network-client.mjs','background.mjs'])new vm.SourceTextModule(fs.readFileSync(path.join(root,name),'utf8'));const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));assert.deepEqual(manifest.permissions,['storage','offscreen']);assert.equal(manifest.background.type,'module');assert.equal(manifest.action.default_popup,'popup.html');assert(!manifest.options_page&&!manifest.options_ui);});
console.log(`\n${passed} offline tests passed. No live AI calls were made.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
