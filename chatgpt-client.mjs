// Native host transport. OAuth credentials never cross this boundary.
import {appError} from './reliability.mjs';
export const CHATGPT_HOST='com.crave_ai_translator.chatgpt';
const METHODS=new Set(['STATUS','LOGIN_START','LOGIN_CANCEL','SELECT_PROFILE','LOGOUT','MODELS','TRANSLATE','CANCEL']);
const CODES=new Set(['NATIVE_RELOAD_REQUIRED','NATIVE_RELOAD_BUSY','AUTH_REQUIRED','PLAN_PERMISSION_REQUIRED','HELPER_UNAVAILABLE','NATIVE_PERMISSION_REQUIRED','LOGIN_FAILED','LOGIN_CANCELLED','LOGIN_TIMEOUT','NETWORK','TIMEOUT','RATE_LIMIT','QUOTA','INVALID_RESPONSE','INVALID_REQUEST','OUTPUT_LIMIT','RESPONSE_TOO_LARGE','CANCELLED','BUSY','STORAGE','STORAGE_UNSAFE','STORAGE_FAILED','HTTP_401','HTTP_403','HTTP_429']);
const MAX=1024*1024;
export function publicChatGPTState(value={}) {
  const profiles=[];
  if(Array.isArray(value.profiles))for(const p of value.profiles.slice(0,20)){
    if(!p||typeof p.id!=='string'||!p.id||p.id.length>200||profiles.some(x=>x.id===p.id))continue;
    const item={id:p.id,connected:p.connected===true,planEnabled:p.planEnabled===true};
    if(typeof p.email==='string'&&p.email.length<=320)item.email=p.email;
    if(typeof p.label==='string'&&p.label.length<=200)item.label=p.label;
    profiles.push(item);
  }
  const available=value.available===true,connected=available&&value.connected===true;
  const state={available,connected,planEnabled:connected&&value.planEnabled===true,loginPending:available&&value.loginPending===true,profiles};
  if(typeof value.activeProfileId==='string'&&profiles.some(p=>p.id===value.activeProfileId))state.activeProfileId=value.activeProfileId;
  if(CODES.has(value.errorCode))state.errorCode=value.errorCode;
  return state;
}
function nativeError(raw) {
  let code=CODES.has(raw?.code)?raw.code:'HELPER_UNAVAILABLE';
  if(code==='BUSY')code='RATE_LIMIT';
  if(code==='INVALID_REQUEST')code='BAD_REQUEST';
  if(['LOGIN_FAILED','LOGIN_CANCELLED','LOGIN_TIMEOUT','STORAGE_UNSAFE','STORAGE_FAILED','STORAGE'].includes(code))code='AUTH_REQUIRED';
  return appError(code,undefined,['NETWORK','TIMEOUT','RATE_LIMIT'].includes(code));
}
export function createChatGPTClient(api=globalThis.chrome) {
  let port=null,connecting=null,sequence=0;
  let state=publicChatGPTState(),dead=false;
  const pending=new Map();
  const hasPermission=async()=>{try{return await api.permissions.contains({permissions:['nativeMessaging']});}catch{return false;}};
  function failAll(code='HELPER_UNAVAILABLE') {
    state=publicChatGPTState({errorCode:code});
    for(const job of [...pending.values()])job.finish(nativeError({code}));
  }
  function receive(message) {
    if(!message||typeof message!=='object'||Array.isArray(message)||typeof message.id!=='string')return;
    const job=pending.get(message.id);if(!job)return;
    try{if(new TextEncoder().encode(JSON.stringify(message)).byteLength>MAX)throw appError('RESPONSE_TOO_LARGE');}
    catch{job.finish(appError('RESPONSE_TOO_LARGE'));return;}
    if(message.ok!==true){job.finish(nativeError(message.error));return;}
    job.finish(null,message.result);
  }
  async function connect() {
    if(dead)throw appError('HELPER_UNAVAILABLE');
    if(port)return port;
    if(connecting)return connecting;
    connecting=(async()=>{
      if(!await hasPermission())throw appError('NATIVE_PERMISSION_REQUIRED');
      if(typeof api.runtime.connectNative!=='function')throw appError('NATIVE_RELOAD_REQUIRED');
      let next;try{next=api.runtime.connectNative(CHATGPT_HOST);}catch{throw appError('HELPER_UNAVAILABLE');}
      if(!next?.onMessage?.addListener||!next?.onDisconnect?.addListener||typeof next.postMessage!=='function')throw appError('HELPER_UNAVAILABLE');
      next.onMessage.addListener(receive);
      next.onDisconnect.addListener(()=>{void api.runtime.lastError;if(port===next){port=null;failAll();}});
      port=next;return next;
    })().finally(()=>{connecting=null;});
    return connecting;
  }
  async function request(method,params={},timeoutMs=20000,signal) {
    if(!METHODS.has(method)||!params||typeof params!=='object'||Array.isArray(params))throw appError('BAD_REQUEST');
    if(signal?.aborted)throw appError('CANCELLED');
    if(pending.size>=64)throw appError('RATE_LIMIT',undefined,true);
    const p=await connect();if(signal?.aborted)throw appError('CANCELLED');
    const id='n'+(++sequence)+'-'+crypto.randomUUID();
    const message={id,method,params};
    if(new TextEncoder().encode(JSON.stringify(message)).byteLength>MAX)throw appError('BAD_REQUEST');
    return new Promise((resolve,reject)=>{
      let finished=false;
      const cancel=()=>{try{p.postMessage({id:'cancel-'+(++sequence),method:'CANCEL',params:{targetId:id}});}catch{}};
      const abort=()=>{cancel();finish(appError('CANCELLED'));};
      const timer=setTimeout(()=>{cancel();finish(appError('TIMEOUT',undefined,true));},Math.max(1000,Math.min(300000,timeoutMs)));
      function finish(error,value){if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);if(error)reject(error);else resolve(value);}
      pending.set(id,{id,method,finish,cancel});signal?.addEventListener('abort',abort,{once:true});
      try{p.postMessage(message);}catch{finish(appError('HELPER_UNAVAILABLE'));}
      if(signal?.aborted)abort();
    });
  }
  async function status() {
    try{state=publicChatGPTState(await request('STATUS'));}
    catch(error){state=publicChatGPTState({errorCode:CODES.has(error?.code)?error.code:'HELPER_UNAVAILABLE'});}
    return state;
  }
  async function auth(method,params={}) {
    if(!['LOGIN_START','LOGIN_CANCEL','SELECT_PROFILE','LOGOUT'].includes(method))throw appError('BAD_REQUEST');
    try{await request(method,params);return await status();}
    catch(error){state=publicChatGPTState({...state,errorCode:CODES.has(error?.code)?error.code:'LOGIN_FAILED'});return state;}
  }
  async function ready(){const value=await status();if(!value.available)throw appError(value.errorCode==='NATIVE_PERMISSION_REQUIRED'?'NATIVE_PERMISSION_REQUIRED':'HELPER_UNAVAILABLE');if(!value.connected||value.loginPending)throw appError('AUTH_REQUIRED');if(!value.planEnabled)throw appError('PLAN_PERMISSION_REQUIRED');return value;}
  async function models(){await ready();const rows=await request('MODELS');if(!Array.isArray(rows)||rows.length>2000)throw appError('INVALID_RESPONSE');const seen=new Set();return rows.filter(x=>x&&typeof x.id==='string'&&x.id.length>0&&x.id.length<=200&&!seen.has(x.id)&&seen.add(x.id)).map(x=>({id:x.id,name:typeof x.name==='string'?x.name.slice(0,200):x.id}));}
  async function translate(config,prompt,checkpoint=async()=>{}) {
    await checkpoint();await ready();await checkpoint();
    const text=await request('TRANSLATE',{model:config.model,system:prompt.system,user:prompt.user},(Number(config.requestTimeoutSeconds)||180)*1000);
    await checkpoint();if(typeof text!=='string'||!text.trim()||text.length>900000)throw appError('INVALID_RESPONSE');return text;
  }
  async function cancelAll(){for(const job of [...pending.values()])if(job.method==='TRANSLATE'){job.cancel();job.finish(appError('CANCELLED'));}}
  function dispose(){dead=true;try{port?.disconnect();}catch{}port=null;failAll();}
  return {request,status,auth,models,translate,cancelAll,dispose,snapshot:()=>publicChatGPTState(state)};
}
