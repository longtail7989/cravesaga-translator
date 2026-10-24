// Generated from reliability.mjs for ISOLATED content scripts.
(()=>{'use strict';
// Retry policy contains no provider credentials or translated vocabulary.
const messages={TIMEOUT:'AI 응답 대기 시간이 초과되었습니다.',NETWORK:'AI 서버 연결이 일시적으로 끊겼습니다.',INVALID_RESPONSE:'AI 응답 형식이 올바르지 않습니다.',VALIDATION:'번역의 수치·태그 검증에 실패했습니다.',UNTRANSLATED:'AI가 일본어 원문을 그대로 반환했습니다.',OUTPUT_LIMIT:'AI 출력 토큰 상한으로 응답이 잘렸습니다.',CANCELLED:'설정 변경 또는 일시정지로 요청을 취소했습니다.',QUOTA:'사용자가 설정한 일일 한도에 도달했습니다.',RATE_LIMIT:'잠시 후 다시 요청합니다.',RETRY_LIMIT:'설정한 자동 재시도 횟수에 도달했습니다.',BAD_REQUEST:'연결 설정 또는 요청 내용을 확인하세요.',RESPONSE_TOO_LARGE:'AI 응답이 크기 제한을 초과했습니다.'};
function appError(code,message,retryable=false,extra={}){return Object.assign(new Error(message||messages[code]||messages.BAD_REQUEST),{code,retryable,...extra});}
function failure(error){let code=typeof error?.code==='string'?error.code:'';if(/^HTTP\d{3}$/.test(code))code=code.replace('HTTP','HTTP_');if(['CONTEXT_LOST','NOT_FOUND'].includes(code))code='NETWORK';if(code==='BUSY')code='RATE_LIMIT';if(code==='INVALID_REQUEST')code='BAD_REQUEST';const status=Number(error?.httpStatus)||0;if(!code&&status)code='HTTP_'+status;
 if(!code){const text=String(error?.message||'');if(/시간.*초과|timed?\s*out|timeout/i.test(text))code='TIMEOUT';else if(/fetch|network|연결.*끊/i.test(text))code='NETWORK';else if(/JSON|응답.*(?:형식|ID|일치|항목)/i.test(text))code='INVALID_RESPONSE';else if(/수치|태그|토큰.*보호|변수|길이/.test(text))code='VALIDATION';else code='BAD_REQUEST';}
 if(!Object.hasOwn(messages,code)&&!/^HTTP_\d{3}$/.test(code))code='BAD_REQUEST';
 const http=Number(/^HTTP_(\d{3})$/.exec(code)?.[1])||status;
 const transient=['TIMEOUT','NETWORK','INVALID_RESPONSE','VALIDATION','UNTRANSLATED','OUTPUT_LIMIT','RATE_LIMIT'].includes(code)||[408,425,429].includes(http)||http>=500;
 const message=messages[code]||(http===401||http===403?'AI 인증·접근 권한을 확인하세요.':http===429?'제공자의 요청 제한에 도달했습니다.':http>=500?'AI 서버에서 일시적인 오류가 발생했습니다.':'AI 요청이 거부되었습니다. 설정과 모델을 확인하세요.');
 return {code,message,retryable:typeof error?.retryable==='boolean'?error.retryable:transient,httpStatus:http,retryAfterMs:Math.max(0,Math.min(300000,Number(error?.retryAfterMs)||0)),quality:['INVALID_RESPONSE','VALIDATION','UNTRANSLATED','OUTPUT_LIMIT'].includes(code)};
}
function retryDelay(attempt,retryAfterMs=0,random=0.5){const base=Math.min(60000,2000*2**Math.min(10,Math.max(0,attempt-1)));return Math.max(Math.min(300000,Math.max(0,retryAfterMs)),Math.round(base*(0.8+Math.max(0,Math.min(1,random))*0.4)));}
function shouldRetry(info,attempt,{retryLimit=0,qualityFailures=0,active=true,enabled=true,cacheOnly=false}={}){if(!active||!enabled||cacheOnly||!info?.retryable)return false;if(retryLimit>0&&attempt>retryLimit)return false;if(info.quality&&qualityFailures>=3)return false;return true;}
function unchangedJapanese(source,text,target){return /^(?:한국어|ko|korean)$/i.test(String(target).trim())&&typeof source==='string'&&typeof text==='string'&&/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(source.replace(/<[^<>]*>/g,''))&&source===text;}

window[Symbol.for('crave-ai-retry-policy.v1')]={failure,retryDelay,shouldRetry};
})();
