const TARGET = '한국어';
const SIZES = Object.freeze([200, 500, 700]);
const BATCH = 256, SAMPLE_LIMIT = 1024, HIT_LOOKUPS = 1000, MISS_LOOKUPS = 200;
const SETTINGS = Object.freeze({target: TARGET, provider: 'benchmark-local', model: 'synthetic', endpoint: ''});
const $ = id => document.getElementById(id);
let running = false, stopRequested = false;
let createCacheStore, makeCacheEntry, byteSize;
let state = freshState();
function freshState() {
  return {version: 1, phase: 'idle', progress: {dataset: null, percent: 0, records: 0, logicalBytes: 0},
    active: false, completed: false, cancelled: false, cleanupComplete: true, cleanupBlocked: false,
    ownedDatabases: [], results: [], error: null,
    methodology: {decimalMB: 1000000, sizesMB: [...SIZES], batchRecords: BATCH, sampleLimit: SAMPLE_LIMIT,
      logicalBytes: 'Sum of byteSize(normalized makeCacheEntry(record)) UTF-8 JSON bytes, including metadata; put recomputes IDs/timestamps with the same serialized widths.',
      storage: 'navigator.storage.estimate origin-wide approximate usage; delta is not exact physical DB size; compression/index overhead may differ.',
      populate: 'Wall time includes Worker generation/wait, clone, validation, precomputed hashing/JSON accounting, put rehash/validation/transactions, sampling, and progress updates. Not pure I/O.',
      indexed: 'Sequential CacheStore.lookup, differing context from stored context; hashing and validation included; no hot Map in this path.',
      warm: 'CacheStore.warm latest target records, at most 2000 entries and 2 MiB of warm-item JSON.',
      heap: 'Optional approximate main-document JS heap; excludes Worker and is not retained-cache memory.',
      headroom: 'Conservative safety check requires target * 1.35 + 64 MiB free when estimate is available; not an application cache cap.',
      limitations: 'Synthetic high-entropy Unicode is not a natural-language compression model. No cold OS-cache guarantees. Abrupt document/process termination cannot guarantee cleanup.'}};
}
function publish(message) {
  window.__benchState = state;
  $('results').textContent = JSON.stringify(state, null, 2);
  $('progress').value = state.progress.percent || 0;
  if (message) $('status').textContent = message;
  const p = state.progress;
  $('detail').textContent = p.dataset ? p.dataset + ' MB · ' + state.phase + ' · ' + p.records.toLocaleString() + ' records · ' + (p.logicalBytes / 1e6).toFixed(3) + ' logical MB' : state.phase;
  renderMetrics();
}
function renderMetrics() {
  const container = $('metrics'); container.replaceChildren();
  for (const result of state.results) {
    const box = document.createElement('section'); box.className = 'result';
    const title = document.createElement('h3'); title.textContent = result.requestedMB + ' MB: ' + result.status; box.append(title);
    const table = document.createElement('table');
    const rows = [
      ['Actual logical size / records', (result.logicalBytes / 1e6).toFixed(3) + ' MB / ' + result.records.toLocaleString()],
      ['Open empty / reopen connection', fmt(result.openEmptyMs, 'ms') + ' / ' + fmt(result.reopenMs, 'ms')],
      ['Populate wall (includes generate/build/put)', fmt(result.populateSeconds, 's')],
      ['Warm latest, ≤2000 / ≤2 MiB', fmt(result.warm?.ms, 'ms') + (result.warm ? ' / ' + result.warm.entries + ' entries' : '')],
      ['Indexed hits p50 / p95', fmt(result.hits?.p50Ms, 'ms') + ' / ' + fmt(result.hits?.p95Ms, 'ms')],
      ['Indexed misses p50 / p95', fmt(result.misses?.p50Ms, 'ms') + ' / ' + fmt(result.misses?.p95Ms, 'ms')],
      ['Hot Map aggregate / approximate ns per get', fmt(result.mapHot?.totalMs, 'ms') + ' / ' + fmt(result.mapHot?.nsPerGet, 'ns')],
      ['Delete oldest 1000 / count drop verified', fmt(result.deletion?.ms, 'ms') + ' / ' + (result.deletion?.verified ?? 'not yet')],
      ['Approximate origin usage delta', result.storageUsageDeltaBytes == null ? 'unavailable' : (result.storageUsageDeltaBytes / 1e6).toFixed(3) + ' MB'],
      ['Owned DB cleanup', result.cleanup?.deleted ? 'deleted' : result.cleanup?.notCreated ? 'not created' : 'pending']
    ];
    for (const [label, value] of rows) { const tr = document.createElement('tr'); for (const text of [label, value]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); } table.append(tr); }
    box.append(table); container.append(box);
  }
}
function fmt(value, unit) { return Number.isFinite(value) ? value.toFixed(unit === 'ns' ? 1 : 3) + ' ' + unit : 'not measured'; }
function fail(code, message) { return Object.assign(new Error(message), {code}); }
function checkStop() { if (stopRequested) throw fail('ABORTED', 'Stopped by user; awaiting owned database cleanup.'); }
function summary(error) {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || error || 'Unknown error').replace(/[\r\n]/g, ' ').slice(0, 400);
  let category = error?.code || 'BENCHMARK_ERROR';
  if (name === 'QuotaExceededError' || /quota|disk.*full|insufficient.*space|not enough.*space/i.test(message)) category = 'NATIVE_STORAGE_CAPACITY';
  else if (['UnknownError', 'NotReadableError'].includes(name)) category = 'NATIVE_STORAGE_IO';
  return {name, category, message};
}
async function storageEstimate() {
  try {
    if (!navigator.storage?.estimate) return {available: false};
    const value = await navigator.storage.estimate();
    return {available: true, usage: value.usage ?? null, quota: value.quota ?? null, approximate: true};
  } catch (error) { return {available: false, error: summary(error)}; }
}
function heapEstimate() {
  const m = performance.memory;
  return m ? {usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit, approximate: true, excludesWorker: true} : null;
}
function generator() {
  const worker = new Worker(new URL('./generator.worker.js', import.meta.url));
  let id = 0; const pending = new Map();
  worker.onmessage = ({data}) => { const task = pending.get(data.id); if (!task) return; pending.delete(data.id); data.error ? task.reject(Object.assign(new Error(data.error.message), {name: data.error.name})) : task.resolve(data); };
  worker.onerror = event => { for (const task of pending.values()) task.reject(fail('GENERATOR_ERROR', event.message || 'Local Worker failed')); pending.clear(); };
  return {
    request(type, extra = {}) { return new Promise((resolve, reject) => { const key = ++id; pending.set(key, {resolve, reject}); worker.postMessage({id: key, type, ...extra}); }); },
    close() { worker.terminate(); for (const task of pending.values()) task.reject(fail('ABORTED', 'Generator terminated')); pending.clear(); }
  };
}
function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return {operations: n, totalMs: values.reduce((a, b) => a + b, 0), p50Ms: sorted[Math.ceil(n * .50) - 1], p95Ms: sorted[Math.ceil(n * .95) - 1], minMs: sorted[0], maxMs: sorted[n - 1]};
}
function ownedName(name) { if (!state.ownedDatabases.includes(name) || !/^crave-ai-bench-[a-f0-9]+-(200|500|700)$/.test(name)) throw fail('OWNERSHIP_GUARD', 'Refused access to a non-owned benchmark database'); }
function trackedFactory(name, connections) {
  ownedName(name);
  return {open(requested, version) { if (requested !== name) throw fail('OWNERSHIP_GUARD', 'Unexpected database open'); const request = indexedDB.open(requested, version); request.addEventListener('success', () => connections.add(request.result)); return request; },
    deleteDatabase(requested) { if (requested !== name) throw fail('OWNERSHIP_GUARD', 'Unexpected database deletion'); return indexedDB.deleteDatabase(requested); }};
}
async function rawDelete(name) {
  ownedName(name);
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error || fail('CLEANUP_FAILED', 'Database deletion failed')); request.onblocked = () => reject(fail('CLEANUP_BLOCKED', 'Owned benchmark deletion blocked by an open connection. Do not start another run.')); });
}
async function cleanup(store, name, connections, result) {
  state.phase = 'cleanup'; state.cleanupComplete = false; publish('Deleting owned temporary database…');
  const t = performance.now(); const warnings = [];
  try { if (store) await store.close(); } catch (e) { warnings.push(summary(e)); }
  for (const connection of connections) { try { connection.close(); } catch (e) { warnings.push(summary(e)); } }
  let destroyed = false;
  try { if (store) { await store.destroy(); destroyed = true; } } catch (e) { warnings.push(summary(e)); }
  if (!destroyed) await rawDelete(name);
  if (typeof indexedDB.databases === 'function') {
    const remaining = await indexedDB.databases();
    if (remaining.some(db => db.name === name)) throw fail('CLEANUP_FAILED', 'Deleted benchmark database still listed');
  }
  result.cleanup = {deleted: true, ms: performance.now() - t, warnings};
  state.ownedDatabases = state.ownedDatabases.filter(value => value !== name);
  state.cleanupComplete = state.ownedDatabases.length === 0;
}
async function runDataset(requestedMB, runId) {
  const targetBytes = requestedMB * 1000000;
  const result = {requestedMB, targetLogicalBytes: targetBytes, seed: (0x5a17b00b ^ requestedMB) >>> 0, status: 'preflight', records: 0, logicalBytes: 0, cleanup: {notCreated: true}};
  state.results.push(result); state.phase = 'preflight'; state.progress = {dataset: requestedMB, percent: 0, records: 0, logicalBytes: 0}; publish('Checking approximate storage headroom…');
  result.storageBefore = await storageEstimate(); checkStop();
  const required = Math.ceil(targetBytes * 1.35 + 64 * 1024 * 1024);
  result.headroom = {requiredBytes: required, approximate: true};
  if (Number.isFinite(result.storageBefore.quota) && Number.isFinite(result.storageBefore.usage)) {
    result.headroom.availableBytes = result.storageBefore.quota - result.storageBefore.usage;
    if (result.headroom.availableBytes < required) { result.status = 'blocked-low-headroom'; result.error = {category: 'LOW_HEADROOM', message: 'Safety preflight skipped this dataset; not a measured performance failure.'}; return; }
  }
  const name = 'crave-ai-bench-' + runId + '-' + requestedMB;
  result.databaseName = name; result.cleanup = {deleted: false};
  state.ownedDatabases.push(name); state.cleanupComplete = false;
  let store, gen; const connections = new Set(); const factory = trackedFactory(name, connections);
  try {
    checkStop(); state.phase = 'open-empty'; publish('Opening empty temporary database…');
    let t = performance.now(); store = createCacheStore(factory, {databaseName: name});
    const emptyCount = await store.count(); result.openEmptyMs = performance.now() - t;
    if (emptyCount !== 0) throw fail('NOT_EMPTY', 'Owned temporary database was not empty');
    gen = generator(); await gen.request('init', {seed: result.seed});
    const samples = []; let oldest = null;
    const random = prng(result.seed ^ 0x12345678);
    const work = {workerGenerationMs: 0, workerRoundTripMs: 0, normalizationAndByteAccountingMs: 0, putCallMs: 0, batches: 0, categories: {name: 0, effect: 0, profile: 0}, maxBatchLogicalBytes: 0};
    result.populateBreakdown = work; result.heapBeforePopulate = heapEstimate();
    const populateStart = performance.now();
    state.phase = 'populate'; result.status = 'populating';
    while (result.logicalBytes < targetBytes) {
      checkStop(); t = performance.now(); const batch = await gen.request('batch', {count: BATCH});
      work.workerRoundTripMs += performance.now() - t; work.workerGenerationMs += batch.generationMs;
      checkStop(); t = performance.now(); let batchBytes = 0;
      for (let offset = 0; offset < batch.items.length; offset += 32) {
        const entries = await Promise.all(batch.items.slice(offset, offset + 32).map(item => makeCacheEntry({...item, target: TARGET})));
        for (const entry of entries) batchBytes += byteSize(entry);
      }
      work.normalizationAndByteAccountingMs += performance.now() - t;
      checkStop(); t = performance.now(); await store.put(batch.items, SETTINGS); work.putCallMs += performance.now() - t;
      for (const item of batch.items) {
        work.categories[item.category]++; result.records++;
        if (!oldest) oldest = {source: item.source, text: item.text, context: item.context};
        if (result.records === 1) continue;
        const sample = {source: item.source, text: item.text, context: item.context};
        if (samples.length < SAMPLE_LIMIT - 1) samples.push(sample);
        else { const slot = Math.floor(random() * (result.records - 1)); if (slot < samples.length) samples[slot] = sample; }
      }
      result.logicalBytes += batchBytes; work.batches++; work.maxBatchLogicalBytes = Math.max(work.maxBatchLogicalBytes, batchBytes);
      result.populateSeconds = (performance.now() - populateStart) / 1000;
      state.progress = {dataset: requestedMB, percent: Math.min(100, result.logicalBytes / targetBytes * 100), records: result.records, logicalBytes: result.logicalBytes};
      publish('Populating ' + requestedMB + ' MB temporary dataset…');
    }
    result.populateSeconds = (performance.now() - populateStart) / 1000;
    result.overshootBytes = result.logicalBytes - targetBytes;
    result.overshootWithinOneBatch = result.overshootBytes <= work.maxBatchLogicalBytes;
    gen.close(); gen = null; checkStop();
    result.status = 'measuring';
    result.countAfterPopulate = await store.count();
    if (result.countAfterPopulate !== result.records) throw fail('COUNT_MISMATCH', 'Inserted count does not match generated unique records');
    const auditDB = await store._database(); result.schemaVersion = auditDB.version;
    let auditStart = performance.now();
    result.nativeCountAfterPopulate = await new Promise((resolve,reject)=>{const tx=auditDB.transaction('translations','readonly'),r=tx.objectStore('translations').count();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    result.nativeCountAuditMs = performance.now()-auditStart;
    if(result.nativeCountAfterPopulate!==result.records)throw fail('NATIVE_COUNT_MISMATCH','Actual native IndexedDB rows disagree with metadata count');
    result.storageAfterPopulate = await storageEstimate();
    if (Number.isFinite(result.storageAfterPopulate.usage) && Number.isFinite(result.storageBefore.usage)) result.storageUsageDeltaBytes = result.storageAfterPopulate.usage - result.storageBefore.usage;
    result.heapAfterPopulate = heapEstimate();
    state.phase = 'reopen'; publish('Reopening connection to populated database…');
    await store.close(); checkStop(); t = performance.now(); store = createCacheStore(factory, {databaseName: name});
    result.countAfterReopen = await store.count(); result.reopenMs = performance.now() - t;
    if (result.countAfterReopen !== result.records) throw fail('REOPEN_COUNT', 'Reopened count mismatch');
    state.phase = 'warm'; publish('Warming latest 2000 entries / 2 MiB maximum…'); checkStop();
    t = performance.now(); const warm = await store.warm(TARGET); const warmMs = performance.now() - t;
    const warmBytes = warm.entries.reduce((total, item) => total + byteSize(item), 0);
    result.warm = {ms: warmMs, entries: warm.entries.length, bytes: warmBytes, reportedBytes: warm.bytes, remaining: warm.remaining, maxEntries: 2000, maxBytes: 2 * 1024 * 1024};
    if (warm.entries.length > 2000 || warmBytes > 2 * 1024 * 1024) throw fail('WARM_BOUNDS', 'CacheStore.warm exceeded its documented bounds');
    state.phase = 'indexed-hits'; publish('Checking 1000 indexed source-only hits with changed contexts…');
    const hitTimings = [];
    for (let i = 0; i < HIT_LOOKUPS; i++) {
      checkStop(); const sample = samples[Math.floor(random() * samples.length)];
      t = performance.now(); const found = await store.lookup({source: sample.source, context: 'different lookup context ' + i}, SETTINGS); hitTimings.push(performance.now() - t);
      if (!found || found.text !== sample.text || found.source !== sample.source) throw fail('HIT_MISMATCH', 'Source-only indexed lookup missed or returned an incorrect translation');
      if (i % 100 === 0) publish();
    }
    result.hits = {...distribution(hitTimings), allVerified: true, changedContexts: true};
    state.phase = 'indexed-misses'; publish('Checking 200 indexed misses…'); const missTimings = [];
    for (let i = 0; i < MISS_LOOKUPS; i++) {
      checkStop(); const source = '未登録の仮想冒険者 ・ missing ・ ' + String(i).padStart(9, '0');
      t = performance.now(); const found = await store.lookup({source, context: 'different missing context'}, SETTINGS); missTimings.push(performance.now() - t);
      if (found) throw fail('MISS_MISMATCH', 'Synthetic missing source unexpectedly found');
      if (i % 50 === 0) publish();
    }
    result.misses = {...distribution(missTimings), allVerified: true};
    state.phase = 'map-hot-get'; publish('Measuring 100000 hot in-memory Map gets…'); checkStop();
    const hot = new Map(warm.entries.map(item => [item.source, item])); const keys = [...hot.keys()];
    if (!keys.length) throw fail('EMPTY_WARM', 'No entries returned by warm');
    const operations = 100000; let checksum = 0;
    t = performance.now(); for (let i = 0; i < operations; i++) checksum += hot.get(keys[i % keys.length]).text.length;
    const totalMs = performance.now() - t;
    result.mapHot = {operations, totalMs, nsPerGet: totalMs * 1e6 / operations, getsPerSecond: totalMs > 0 ? operations * 1000 / totalMs : null, checksum, includesLoopAndKeySelection: true};
    hot.clear(); warm.entries.length = 0;
    state.phase = 'delete-oldest'; publish('Deleting oldest 1000 records and verifying…'); checkStop();
    const beforeDelete = await store.count(); const oldestBefore = await store.lookup({source: oldest.source, context: 'oldest precheck different'}, SETTINGS);
    if (!oldestBefore || oldestBefore.text !== oldest.text) throw fail('OLDEST_PRECHECK', 'Oldest insertion sample did not exist before deletion');
    t = performance.now(); const deleted = await store.deleteOldest(1000); const deleteMs = performance.now() - t;
    const afterDelete = await store.count(); const oldestAfter = await store.lookup({source: oldest.source, context: 'oldest postcheck different'}, SETTINGS);
    const auditDeleteDB=await store._database();
    result.nativeCountAfterDeletion=await new Promise((resolve,reject)=>{const tx=auditDeleteDB.transaction('translations','readonly'),r=tx.objectStore('translations').count();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    if(result.nativeCountAfterDeletion!==afterDelete)throw fail('NATIVE_DELETE_COUNT','Actual IndexedDB rows disagree after deletion');
    result.deletion = {ms: deleteMs, requested: 1000, reported: deleted, beforeCount: beforeDelete, afterCount: afterDelete, countDrop: beforeDelete - afterDelete, oldestSampleMiss: !oldestAfter, verified: beforeDelete - afterDelete === 1000 && !oldestAfter};
    if (!result.deletion.verified) throw fail('DELETE_VERIFICATION', 'Oldest deletion failed count-drop or oldest-sample check');
    result.status = 'passed';
  } catch (error) {
    result.error = summary(error);
    result.status = result.error.category === 'ABORTED' ? 'aborted' : ['NATIVE_STORAGE_CAPACITY', 'NATIVE_STORAGE_IO'].includes(result.error.category) ? 'native-storage-failure' : 'failed';
    if (result.status === 'aborted') state.cancelled = true;
  } finally {
    if (gen) gen.close();
    if (result.status !== 'passed') {
      // A failing put may commit some of its internal transactions. Do not label
      // fully completed-batch byte accounting as the exact failed-dataset size.
      result.logicalBytesAccountingComplete = false;
      result.logicalBytesNote = 'Bytes cover successfully completed batches only; a failed put may have partially committed extra records.';
      if (store) { try { result.countAtFailure = await store.count(); } catch (error) { result.countAtFailureError = summary(error); } }
      result.storageAtFailure = await storageEstimate();
      if (Number.isFinite(result.storageAtFailure.usage) && Number.isFinite(result.storageBefore.usage)) result.storageUsageDeltaBytes = result.storageAtFailure.usage - result.storageBefore.usage;
    } else result.logicalBytesAccountingComplete = true;
    try { await cleanup(store, name, connections, result); }
    catch (error) { result.cleanup = {deleted: false, error: summary(error)}; state.cleanupBlocked = true; state.error = summary(error); result.status = 'cleanup-failed'; }
    result.storageAfterCleanup = await storageEstimate(); publish();
  }
}
async function runAll() {
  try {
    state.phase = 'load-candidate'; publish('Loading local candidate modules…');
    [{createCacheStore}, {makeCacheEntry, byteSize}] = await Promise.all([import('./candidate/cache-store.mjs'), import('./candidate/cache.mjs')]);
    checkStop();
    const token = new Uint8Array(12); crypto.getRandomValues(token);
    const runId = [...token].map(x => x.toString(16).padStart(2, '0')).join('');
    state.runId = runId; state.startedAt = new Date().toISOString();
    for (const size of SIZES) { checkStop(); await runDataset(size, runId); if (state.cleanupBlocked) break; }
    checkStop();
    state.completed = !state.cleanupBlocked && state.results.length === SIZES.length;
    state.allPassed = state.completed && state.results.every(result => result.status === 'passed');
    state.phase = state.cleanupBlocked ? 'cleanup-blocked' : state.allPassed ? 'completed' : 'completed-with-failures-or-skips';
  } catch (error) {
    const safe = summary(error); state.error = safe;
    if (safe.category === 'ABORTED') { state.cancelled = true; state.phase = 'cancelled'; const last = state.results.at(-1); if (last?.status === 'preflight') { last.status = 'aborted'; last.error = safe; } }
    else state.phase = 'failed';
  } finally {
    running = false; state.active = false; state.finishedAt = new Date().toISOString();
    state.cleanupComplete = state.ownedDatabases.length === 0;
    $('start').disabled = !state.cleanupComplete; $('stop').disabled = true;
    publish(state.cancelled ? 'Stopped. ' + (state.cleanupComplete ? 'All owned temporary databases deleted.' : 'Cleanup requires attention.') : state.allPassed ? 'All three datasets passed. All owned temporary databases deleted.' : 'Run ended: ' + state.phase + '. Inspect results and cleanup flags.');
  }
  return state;
}
$('start').addEventListener('click', () => {
  if (running || !state.cleanupComplete) return;
  running = true; stopRequested = false; state = freshState(); state.active = true;
  $('start').disabled = true; $('stop').disabled = false; publish('Starting…');
  window.__benchPromise = runAll();
});
$('stop').addEventListener('click', () => { if (!running) return; stopRequested = true; state.stopRequested = true; $('stop').disabled = true; publish('Stop requested. Waiting for current bounded operation, then cleanup…'); });
window.addEventListener('beforeunload', event => { if (running || !state.cleanupComplete) { event.preventDefault(); event.returnValue = ''; } });
publish();
