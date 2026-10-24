'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { FrameDecoder, encodeFrame, validateRequest, safeError, ProtocolError } = require('./protocol.cjs');
const ALLOWED_ORIGIN = 'chrome-extension://mfoolamgailfmmpddefkpnbfiecleefi';
function validateOrigin(origin) { return origin === ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN + '/'; }
function parseArgs(argv) {
  let origin, storageDirectory, parentWindow;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--storage-dir' && storageDirectory === undefined) {
      storageDirectory = argv[++i];
      if (typeof storageDirectory !== 'string' || !path.isAbsolute(storageDirectory)) throw new ProtocolError('INVALID_REQUEST');
    } else if (validateOrigin(arg) && origin === undefined) origin = arg;
    else if (/^(?:--parent-window=)?\d+$/.test(arg) && parentWindow === undefined) parentWindow = arg;
    else throw new ProtocolError('FORBIDDEN');
  }
  if (!origin) throw new ProtocolError('FORBIDDEN');
  if (!storageDirectory) throw new ProtocolError('INVALID_REQUEST');
  return { origin, storageDirectory: path.resolve(storageDirectory) };
}
async function acquireLock(storageDirectory) {
  if (!path.isAbsolute(storageDirectory)) throw new ProtocolError('STORAGE_ERROR');
  await fs.mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(storageDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProtocolError('STORAGE_ERROR');
  const resolved = await fs.realpath(storageDirectory);
  if (path.resolve(resolved).toLowerCase() !== path.resolve(storageDirectory).toLowerCase()) throw new ProtocolError('STORAGE_ERROR');
  if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new ProtocolError('STORAGE_ERROR');
  const lockPath = path.join(storageDirectory, 'native-host.lock');
  const token = crypto.randomBytes(32).toString('hex');
  let handle;
  try { handle = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) { throw new ProtocolError(error.code === 'EEXIST' ? 'BUSY' : 'STORAGE_ERROR'); }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
  catch { await handle.close(); await fs.unlink(lockPath).catch(() => {}); throw new ProtocolError('STORAGE_ERROR'); }
  await handle.close();
  // Never steal an existing lock. Even an apparently dead PID may be reused.
  return async () => {
    try { const current = JSON.parse(await fs.readFile(lockPath, 'utf8')); if (current.pid === process.pid && current.token === token) await fs.unlink(lockPath); } catch {}
  };
}
function publicStatus(value) {
  // Only local account metadata. Never pass SDK response objects or credentials through.
  const out = {};
  for (const key of ['available','loggedIn','authenticated','loginPending','connected','ready','planEnabled']) if (typeof value?.[key] === 'boolean') out[key] = value[key];
  for (const key of ['selectedProfileId','activeProfileId','profileId']) if (typeof value?.[key] === 'string' && value[key].length <= 128) out[key] = value[key];
  if (typeof value?.state === 'string' && ['logged_out','logged_in','login_pending','ready','unavailable','authenticated','unauthenticated'].includes(value.state)) out.state = value.state;
  if (Array.isArray(value?.profiles)) out.profiles = value.profiles.slice(0,100).map(p => {
    const item = {};
    for (const key of ['id','name','label','email','displayName']) if (typeof p?.[key] === 'string') item[key] = p[key].slice(0,256);
    for (const key of ['selected','active','authenticated','loggedIn','connected','planEnabled']) if (typeof p?.[key] === 'boolean') item[key] = p[key];
    return item;
  });
  if (typeof value?.errorCode === 'string') out.errorCode = safeError({ code: value.errorCode }).code;
  return out;
}
async function runHost(options) {
  const { input, output, origin, storageDirectory } = options;
  input.pause?.();
  let closed = false, service, servicePromise, releaseLock, loginPending = false, loginTask, loginError, active;
  const queue = [], pending = new Map(), operations = new Set();
  let authGeneration = 0, mutationBusy = false;
  let shutdownPromise;
  const write = response => {
    if (closed || output.destroyed || output.writableEnded) return;
    if (output.writableLength > 8 * 1024 * 1024) { void shutdown(); return; }
    let bytes;
    try { bytes = encodeFrame(response); }
    catch { bytes = encodeFrame({ id: response.id, ok: false, error: safeError({ code: 'RESPONSE_TOO_LARGE' }) }); }
    try { output.write(bytes); } catch { void shutdown(); }
  };
  const fail = (id, error) => write({ id, ok: false, error: safeError(error) });
  async function getService() {
    if (!servicePromise) servicePromise = (async () => {
      const factory = options.createService || (await import('./service.mjs')).createService;
      const adapter = options.protect && options.unprotect ? options : require('./windows/dpapi.cjs');
      const created = await factory({ storageDirectory, protect: adapter.protect, unprotect: adapter.unprotect, ...(typeof adapter.openBrowser === 'function' ? {openBrowser:adapter.openBrowser} : {}) });
      service = created;
      if (closed) throw new ProtocolError('CANCELLED');
      return created;
    })();
    return servicePromise;
  }
  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    input.pause?.();
    input.destroy?.();
    for (const job of pending.values()) job.controller?.abort();
    queue.length = 0;
    shutdownPromise = (async () => {
      // Keep the lock until cancellation/disposal finishes; never unlock a live refresh.
      if (servicePromise) { try { await servicePromise; } catch {} }
      if (service) { try { await service.cancelLogin(); } catch {} }
      if (loginTask) { try { await loginTask; } catch {} }
      await Promise.allSettled([...operations]);
      if (active?.settled) { try { await active.settled; } catch {} }
      if (service) { try { if (service.close) await service.close(); } catch {} }
      if (releaseLock) await releaseLock();
      output.end?.();
    })();
    return shutdownPromise;
  }
  const complete = (job, result, error) => {
    if (!pending.has(job.id)) return;
    pending.delete(job.id);
    if (error) fail(job.id, error); else write({ id: job.id, ok: true, result });
  };
  function pump() {
    if (active || closed || mutationBusy || !queue.length) return;
    const job = queue.shift(); active = job;
    job.settled = (async () => {
      try {
        if (job.authGeneration !== authGeneration || job.controller.signal.aborted || closed) throw new ProtocolError('CANCELLED');
        const svc = await getService();
        if (job.authGeneration !== authGeneration || job.controller.signal.aborted || closed) throw new ProtocolError('CANCELLED');
        const result = await svc.translate(job.params, job.controller.signal);
        if (job.authGeneration !== authGeneration || job.controller.signal.aborted) throw new ProtocolError('CANCELLED');
        if (typeof result !== 'string') throw new ProtocolError('INTERNAL_ERROR');
        complete(job, result);
      } catch (error) { complete(job, undefined, job.authGeneration !== authGeneration || job.controller.signal.aborted ? new ProtocolError('CANCELLED') : error); }
      finally { active = undefined; pump(); }
    })();
  }
  async function dispatch(value) {
    let req;
    try { req = validateRequest(value); }
    catch (error) { fail(typeof value?.id === 'string' && value.id.length <= 128 ? value.id : '', error); return; }
    const { id, method, params } = req;
    if (pending.has(id)) { fail(id, new ProtocolError('DUPLICATE_ID')); return; }
    if (method === 'CANCEL') {
      const target = pending.get(params.targetId);
      if (target?.controller) {
        target.controller.abort();
        const index = queue.indexOf(target);
        if (index >= 0) { queue.splice(index,1); complete(target, undefined, new ProtocolError('CANCELLED')); }
      }
      write({ id, ok: true, result: { cancelled: Boolean(target?.controller) } }); return;
    }
    if (pending.size >= 64) { fail(id, new ProtocolError('BUSY')); return; }
    const job = { ...req };
    if (method === 'TRANSLATE') {
      if (mutationBusy || queue.length + (active ? 1 : 0) >= 8) { fail(id, new ProtocolError('BUSY')); return; }
      job.authGeneration = authGeneration;
      job.controller = new AbortController(); pending.set(id, job); queue.push(job); pump(); return;
    }
    const mutatesIdentity = ['LOGIN_START', 'SELECT_PROFILE', 'LOGOUT'].includes(method);
    let loginOwnsMutation = false;
    if (mutatesIdentity) {
      if (mutationBusy || (method === 'LOGIN_START' && loginPending)) { fail(id, new ProtocolError('BUSY')); return; }
      // This boundary MUST run before the first await, including service creation.
      // Old-account jobs can never be inferred or delivered under a new identity.
      mutationBusy = true;
      authGeneration++;
      active?.controller.abort();
      for (const stale of queue.splice(0)) {
        stale.controller.abort();
        complete(stale, undefined, new ProtocolError('CANCELLED'));
      }
    }
    pending.set(id, job);
    try {
      const svc = await getService();
      if (closed) return;
      let result;
      switch (method) {
        case 'STATUS': { const status = publicStatus(await svc.status()); result = { ...status, ...(loginError && !status.errorCode ? { errorCode: loginError } : {}), loginPending: typeof status.loginPending === 'boolean' ? status.loginPending : loginPending }; break; }
        case 'LOGIN_START':
          if (loginPending) throw new ProtocolError('BUSY');
          loginPending = true; loginError = undefined;
          // The browser receives its acknowledgement without waiting for OAuth.
          loginOwnsMutation = true;
          loginTask = Promise.resolve().then(() => { if (!closed) return svc.startLogin(params); }).catch(error => { loginError = safeError(error).code; }).finally(() => { loginPending = false; mutationBusy = false; pump(); });
          result = { pending: true }; break;
        case 'LOGIN_CANCEL': await svc.cancelLogin(); loginPending = false; loginError = undefined; result = { cancelled: true }; break;
        case 'SELECT_PROFILE': await svc.selectProfile(params.id); result = { selected: true }; break;
        case 'LOGOUT': await svc.logout(params.id); result = { loggedOut: true }; break;
        case 'MODELS': {
          const models = await svc.models();
          result = Array.isArray(models) ? models.filter(m => typeof m?.id === 'string' && typeof m?.name === 'string').slice(0,256).map(m => ({ id: m.id.slice(0,256), name: m.name.slice(0,256) })) : [];
          break;
        }
      }
      complete(job, result);
    } catch (error) { complete(job, undefined, error); }
    finally {
      if (mutatesIdentity && !loginOwnsMutation) { mutationBusy = false; pump(); }
    }
  }
  const decoder = new FrameDecoder(value => {
    if (!closed) {
      const operation = dispatch(value);
      operations.add(operation);
      void operation.finally(() => operations.delete(operation));
    }
  }, error => { fail('', error); void shutdown(); });
  input.on('data', chunk => decoder.push(chunk));
  input.on('end', () => { decoder.end(); void shutdown(); });
  input.on('error', () => { void shutdown(); });
  output.on('error', () => { void shutdown(); });
  try {
    if (!validateOrigin(origin)) throw new ProtocolError('FORBIDDEN');
    releaseLock = await (options.acquireLock || acquireLock)(storageDirectory);
  } catch (error) { fail('', error); await shutdown(); return { shutdown }; }
  // Input is resumed only once origin and lock validation have completed.
  if (closed) { await releaseLock(); return { shutdown }; }
  input.resume?.();
  return { shutdown };
}
async function main(argv = process.argv.slice(2)) {
  process.stdin.pause();
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { process.stdout.write(encodeFrame({ id: '', ok: false, error: safeError(error) })); process.exitCode = 1; process.stdin.destroy(); return; }
  const host = await runHost({ input: process.stdin, output: process.stdout, ...parsed });
  process.once('SIGTERM', () => { void host.shutdown(); });
  process.once('SIGINT', () => { void host.shutdown(); });
}
module.exports = { runHost, acquireLock, validateOrigin, parseArgs, publicStatus };
if (require.main === module) main().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
