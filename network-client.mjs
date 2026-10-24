/* Network transport for MV3. Parent must validate host permission BEFORE calling.
 * Requires permission "offscreen", minimum_chrome_version "116", and the three
 * bundled offscreen/worker files. Background listeners must ignore our target.
 * No persistence, provider retries, remote scripts, or offscreen close calls.
 */
const creationPromises = new WeakMap();
const POLL_MS = 800, MAX_INPUT = 1024 * 1024;
const allowedHeaders = new Set(['authorization','content-type','x-goog-api-key','x-api-key','anthropic-version','anthropic-dangerous-direct-browser-access']);
function networkError(code, extra = {}) {
  const messages = {TIMEOUT:'Network request timed out.', NETWORK:'Network request failed.', CANCELLED:'Network request cancelled.', INVALID_REQUEST:'Invalid network request.', INVALID_RESPONSE:'Server returned invalid JSON.', RESPONSE_TOO_LARGE:'Server response exceeds the size limit.', BUSY:'Network request capacity reached.', CONTEXT_LOST:'Network worker is unavailable.', NOT_FOUND:'Network job is no longer available.'};
  const e = new Error(messages[code] || (/^HTTP\d{3}$/.test(code) ? 'Server returned HTTP ' + code.slice(4) + '.' : 'Network request failed.'));
  e.code = code;
  if (Number.isInteger(extra.httpStatus)) e.httpStatus = extra.httpStatus;
  if (Number.isFinite(extra.retryAfterMs)) e.retryAfterMs = extra.retryAfterMs;
  const status = e.httpStatus ?? (/^HTTP\d{3}$/.test(code) ? Number(code.slice(4)) : 0);
  e.retryable = ['TIMEOUT','NETWORK','INVALID_RESPONSE','CONTEXT_LOST','NOT_FOUND','BUSY'].includes(code) || [408,425,429].includes(status) || (status >= 500 && status <= 599);
  return e;
}
function bounded(promise, ms, signal) {
  return new Promise((resolve,reject) => {
    let finished = false;
    const done = (fn,value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort',onAbort); fn(value);
    };
    const onAbort = () => done(reject,networkError('CANCELLED'));
    const timer = setTimeout(() => done(reject,networkError('TIMEOUT')),Math.max(0,ms));
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(promise).then(v => done(resolve,v),() => done(reject,networkError('CONTEXT_LOST')));
  });
}
function prepare(url,options,timeoutMs,deadlineAt) {
  if (typeof url !== 'string' || url.length > 16384 || url.includes('#') || !options || typeof options !== 'object' || Array.isArray(options)) throw networkError('INVALID_REQUEST');
  let parsed;
  try { parsed = new URL(url); } catch { throw networkError('INVALID_REQUEST'); }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.hash) throw networkError('INVALID_REQUEST');
  if (Object.keys(options).some(k => !['method','headers','body','signal'].includes(k))) throw networkError('INVALID_REQUEST');
  const method = options.method === undefined ? 'GET' : options.method;
  if (method !== 'GET' && method !== 'POST') throw networkError('INVALID_REQUEST');
  const headers = {};
  let entries;
  if (options.headers === undefined) entries = [];
  else if (typeof Headers !== 'undefined' && options.headers instanceof Headers) entries = [...options.headers.entries()];
  else if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) entries = Object.entries(options.headers);
  else throw networkError('INVALID_REQUEST');
  for (const [name,value] of entries) {
    const lower = name.toLowerCase();
    if (!allowedHeaders.has(lower) || lower in headers || typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)) throw networkError('INVALID_REQUEST');
    headers[lower] = value;
  }
  if (options.body !== undefined) {
    if (method !== 'POST' || typeof options.body !== 'string') throw networkError('INVALID_REQUEST');
    try { JSON.parse(options.body); } catch { throw networkError('INVALID_REQUEST'); }
  }
  const request = {url:parsed.href,method,headers,timeoutMs,deadlineAt};
  if (options.body !== undefined) request.body = options.body;
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_INPUT) throw networkError('INVALID_REQUEST');
  return request;
}
export function createNetworkClient(chromeApi = globalThis.chrome) {
  const active = new Map();
  async function ensureDocument() {
    if (!chromeApi?.offscreen?.hasDocument || !chromeApi?.offscreen?.createDocument || !chromeApi?.runtime?.sendMessage) throw networkError('CONTEXT_LOST');
    let creating = creationPromises.get(chromeApi);
    if (!creating) {
      creating = (async () => {
        if (await chromeApi.offscreen.hasDocument()) return;
        try {
          await chromeApi.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS'],justification:'Host a dedicated Worker for bounded translation network requests.'});
        } catch {
          // Another trusted extension context may have won the creation race.
          if (!await chromeApi.offscreen.hasDocument()) throw networkError('CONTEXT_LOST');
        }
      })();
      creationPromises.set(chromeApi,creating);
      void creating.finally(() => { if (creationPromises.get(chromeApi) === creating) creationPromises.delete(chromeApi); }).catch(() => {});
    }
    await creating;
  }
  function send(message,deadline,signal) {
    if (signal?.aborted) return Promise.reject(networkError('CANCELLED'));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(networkError('TIMEOUT'));
    try { return bounded(chromeApi.runtime.sendMessage({target:'network-offscreen',...message}),Math.min(2000,remaining),signal); }
    catch { return Promise.reject(networkError('CONTEXT_LOST')); }
  }
  async function startup(message,deadline,signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await bounded(ensureDocument(),Math.min(2000,deadline - Date.now()),signal);
        const reply = await send(message,deadline,signal);
        if (reply && ['pending','done','error'].includes(reply.status) && reply.error?.code !== 'CONTEXT_LOST') return reply;
      } catch (e) {
        if (signal?.aborted || Date.now() >= deadline || e.code === 'CANCELLED') throw e;
      }
      if (attempt < 2) await bounded(new Promise(r => setTimeout(r,100 * (attempt + 1))),deadline - Date.now(),signal);
    }
    throw networkError('CONTEXT_LOST');
  }
  function quiet(message) { void send(message,Date.now()+2000).catch(() => {}); }
  async function jsonFetch(url,options = {},timeoutMs = 180000) {
    const started = Date.now();
    if (!Number.isFinite(timeoutMs)) throw networkError('INVALID_REQUEST');
    timeoutMs = Math.min(240000,Math.max(1000,Math.floor(timeoutMs)));
    const deadline = started + timeoutMs;
    const request = prepare(url,options,timeoutMs,deadline);
    if (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) throw networkError('INVALID_REQUEST');
    const controller = new AbortController();
    const callerAbort = () => controller.abort();
    if (options.signal?.aborted) throw networkError('CANCELLED');
    options.signal?.addEventListener('abort',callerAbort,{once:true});
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const jobId = [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
    active.set(jobId,controller);
    let settled = false;
    try {
      let state = await startup({type:'NET_START',jobId,request},deadline,controller.signal);
      while (true) {
        if (controller.signal.aborted) throw networkError('CANCELLED');
        if (Date.now() >= deadline) throw networkError('TIMEOUT');
        if (state?.status === 'done') { settled = true; return state.data; }
        if (state?.status === 'error') {
          settled = true;
          throw networkError(typeof state.error?.code === 'string' ? state.error.code : 'NETWORK',state.error || {});
        }
        if (state?.status !== 'pending') throw networkError('CONTEXT_LOST');
        await bounded(new Promise(r => setTimeout(r,Math.min(POLL_MS,deadline - Date.now()))),deadline - Date.now(),controller.signal);
        // A missing context gets bounded reconnect attempts, never an automatic
        // provider re-START: NOT_FOUND is returned as a retryable failed attempt.
        state = await startup({type:'NET_POLL',jobId},deadline,controller.signal);
      }
    } finally {
      active.delete(jobId);
      options.signal?.removeEventListener('abort',callerAbort);
      quiet({type:settled ? 'NET_FORGET' : 'NET_CANCEL',jobId});
    }
  }
  async function cancelAll() {
    for (const controller of active.values()) controller.abort();
    try {
      if (await bounded(chromeApi.offscreen.hasDocument(),2000)) await send({type:'NET_CANCEL_ALL'},Date.now()+2000);
    } catch { /* Local calls are cancelled even if the document disappeared. */ }
  }
  return {jsonFetch,cancelAll};
}
