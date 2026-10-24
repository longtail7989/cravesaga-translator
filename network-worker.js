/* Local classic dedicated Worker. No extension APIs, imports, persistence, or logging. */
(() => {
  'use strict';
  const MAX_INPUT = 1024 * 1024, MAX_RESPONSE = 2000000;
  const MAX_PENDING = 4, MAX_DONE = 32, TTL = 300000;
  const jobs = new Map();
  const allowedHeaders = new Set(['authorization', 'content-type', 'x-goog-api-key', 'x-api-key', 'anthropic-version', 'anthropic-dangerous-direct-browser-access']);
  const messages = {INVALID_REQUEST:'Invalid network request.', BUSY:'Network request capacity reached.', NOT_FOUND:'Network job is no longer available.', TIMEOUT:'Network request timed out.', NETWORK:'Network request failed.', CANCELLED:'Network request cancelled.', INVALID_RESPONSE:'Server returned invalid JSON.', RESPONSE_TOO_LARGE:'Server response exceeds the size limit.'};
  const error = (code, extra = {}) => ({status:'error', error:{code, message:messages[code] || 'Network request failed.', ...extra}});
  const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
  function prune() {
    const now = Date.now();
    for (const [id, job] of jobs) if (job.result.status !== 'pending' && now - job.finishedAt >= TTL) jobs.delete(id);
    const done = [...jobs].filter(([,j]) => j.result.status !== 'pending');
    while (done.length > MAX_DONE) jobs.delete(done.shift()[0]);
  }
  function finish(job, result) {
    if (job.result.status !== 'pending') return;
    clearTimeout(job.timer);
    job.result = result;
    job.finishedAt = Date.now();
    job.controller = null;
    prune();
  }
  function cancel(job, code = 'CANCELLED') {
    if (job.result.status !== 'pending') return;
    const controller = job.controller;
    finish(job, error(code));
    controller.abort();
  }
  function validate(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw 0;
    if (Object.keys(request).some(k => !['url','method','headers','body','timeoutMs','deadlineAt'].includes(k))) throw 0;
    if (typeof request.url !== 'string' || request.url.length > 16384 || request.url.includes('#')) throw 0;
    const url = new URL(request.url);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) throw 0;
    const method = request.method === undefined ? 'GET' : request.method;
    if (method !== 'GET' && method !== 'POST') throw 0;
    const headers = {};
    if (request.headers !== undefined) {
      if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) throw 0;
      for (const [name,value] of Object.entries(request.headers)) {
        const lower = name.toLowerCase();
        if (!allowedHeaders.has(lower) || typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value) || lower in headers) throw 0;
        headers[lower] = value;
      }
    }
    if (request.body !== undefined && (method !== 'POST' || typeof request.body !== 'string')) throw 0;
    if (request.body !== undefined) { if (request.body.length > MAX_INPUT) throw 0; JSON.parse(request.body); }
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_INPUT) throw 0;
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 240000 || !Number.isFinite(request.deadlineAt)) throw 0;
    const remaining = Math.min(request.timeoutMs, request.deadlineAt - Date.now(), 240000);
    return {url:url.href, method, headers, body:request.body, remaining};
  }
  function retryAfter(response) {
    const value = response.headers.get('retry-after');
    if (!value) return {};
    const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(seconds) ? {retryAfterMs:Math.min(86400000, Math.max(0, Math.ceil(seconds)))} : {};
  }
  async function run(job, request) {
    try {
      const response = await fetch(request.url, {method:request.method, headers:request.headers, ...(request.body === undefined ? {} : {body:request.body}), redirect:'error', credentials:'omit', cache:'no-store', signal:job.controller.signal});
      if (job.result.status !== 'pending') return;
      if (!response.ok) {
        const result = error('HTTP' + response.status, {httpStatus:response.status, ...retryAfter(response)});
        if (response.body) void response.body.cancel().catch(() => {});
        finish(job,result); return;
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
        if (response.body) void response.body.cancel().catch(() => {});
        finish(job,error('RESPONSE_TOO_LARGE')); return;
      }
      if (!response.body) { finish(job,error('INVALID_RESPONSE')); return; }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (job.result.status !== 'pending') { void reader.cancel().catch(() => {}); return; }
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE) { void reader.cancel().catch(() => {}); finish(job,error('RESPONSE_TOO_LARGE')); return; }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
      catch { finish(job,error('INVALID_RESPONSE')); return; }
      finish(job,{status:'done',data});
    } catch { finish(job,error('NETWORK')); }
  }
  function handle(message) {
    prune();
    if (!message || typeof message !== 'object') return error('INVALID_REQUEST');
    if (message.type === 'NET_CANCEL_ALL') {
      for (const job of jobs.values()) cancel(job);
      return {status:'done',data:null};
    }
    if (!validId(message.jobId)) return error('INVALID_REQUEST');
    const job = jobs.get(message.jobId);
    if (message.type === 'NET_POLL') return job ? job.result : error('NOT_FOUND');
    if (message.type === 'NET_CANCEL') { if (job) cancel(job); return job ? job.result : error('NOT_FOUND'); }
    if (message.type === 'NET_FORGET') {
      if (job && job.result.status !== 'pending') jobs.delete(message.jobId);
      return {status:'done',data:null};
    }
    if (message.type !== 'NET_START') return error('INVALID_REQUEST');
    // Retried START is idempotent: never duplicate a provider request.
    if (job) return job.result;
    let request;
    try { request = validate(message.request); } catch { return error('INVALID_REQUEST'); }
    if (request.remaining <= 0) return error('TIMEOUT');
    if ([...jobs.values()].filter(j => j.result.status === 'pending').length >= MAX_PENDING) return error('BUSY');
    const next = {result:{status:'pending'}, controller:new AbortController(), timer:null, finishedAt:0};
    jobs.set(message.jobId,next);
    next.timer = setTimeout(() => cancel(next,'TIMEOUT'),request.remaining);
    void run(next,request);
    return next.result;
  }
  self.onmessage = event => {
    const message = event.data;
    if (!message || typeof message.requestId !== 'string') return;
    let result;
    try { result = handle(message); } catch { result = error('INVALID_REQUEST'); }
    self.postMessage({requestId:message.requestId,result});
  };
  setInterval(prune,30000);
})();
