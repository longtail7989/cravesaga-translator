// Node-only bounded mock smoke test. Never opens a browser or real IndexedDB.
// Run with BENCH_ROOT pointing to this directory, piping this file to node.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const {webcrypto} = require('node:crypto');
const root = process.env.BENCH_ROOT;
assert(root, 'Set BENCH_ROOT to tests/benchmark');
const generatorSource = fs.readFileSync(path.join(root, 'generator.worker.js'), 'utf8');
const runnerOriginal = fs.readFileSync(path.join(root, 'runner.mjs'), 'utf8');
new vm.Script(generatorSource);
function workerContext(send) {
  const self = {postMessage: send};
  vm.runInNewContext(generatorSource, {self, performance}); return self;
}
let generated;
const gen = workerContext(data => { generated = data; });
gen.onmessage({data: {type: 'init', id: 1, seed: 123}});
gen.onmessage({data: {type: 'batch', id: 2, count: 256}});
assert.equal(generated.items.length, 256);
const first = JSON.stringify(generated.items);
const seen = new Set();
const protectedParts = text => text.match(/<[^>]*>|\{[^{}]*\}|\r\n|\r|\n|[+＋\-－]?[0-9０-９]+(?:[,，][0-9０-９]{3})*(?:[.．][0-9０-９]+)?(?:[%％])?/g) || [];
for (const item of generated.items) {
  assert.deepEqual(protectedParts(item.source), protectedParts(item.text));
  assert.equal(protectedParts(item.source).length, 1);
  assert(!seen.has(item.source)); seen.add(item.source);
  assert(item.source.length < 8192);
  assert(item.source !== item.text);
}
gen.onmessage({data: {type: 'init', id: 3, seed: 123}});
gen.onmessage({data: {type: 'batch', id: 4, count: 256}});
assert.equal(JSON.stringify(generated.items), first, 'deterministic seed');
function element() {
  return {disabled: false, value: 0, textContent: '', className: '', children: [], handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    append(node) { this.children.push(node); }, replaceChildren() { this.children = []; }};
}
async function scenario(mode) {
  const nodes = new Map(['start', 'stop', 'results', 'progress', 'status', 'detail', 'metrics'].map(id => [id, element()]));
  const document = {getElementById: id => nodes.get(id), createElement: element};
  const window = {addEventListener() {}}; const databases = new Map();
  const byteSize = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
  const makeCacheEntry = async item => ({id: 'v3:' + item.source.slice(0, 9), source: item.source, text: item.text, target: item.target, context: item.context, createdAt: 1700000000000, updatedAt: 1700000000000, time: 1700000000000});
  let requestedStop = false, maxLive = 0, fallbackDeletes = 0;
  const createCacheStore = (idb, {databaseName}) => {
    assert.match(databaseName, /^crave-ai-bench-[a-f0-9]+-(200|500|700)$/);
    if (!databases.has(databaseName)) databases.set(databaseName, new Map());
    maxLive = Math.max(maxLive, databases.size);
    const records = databases.get(databaseName);
    return {
      async count() { return records.size; },
      async _database() {
        return {version: 4, transaction(storeName, mode) {
          assert.equal(storeName, 'translations'); assert.equal(mode, 'readonly');
          return {objectStore(name) {
            assert.equal(name, 'translations');
            return {count() {
              const request = {};
              queueMicrotask(() => { request.result = records.size; request.onsuccess?.(); });
              return request;
            }};
          }};
        }};
      },
      async put(items) {
        await new Promise(resolve => setImmediate(resolve));
        if (mode === 'quota') throw Object.assign(new Error('Native disk quota exhausted'), {name: 'QuotaExceededError'});
        if (mode === 'fallback') throw new Error('Synthetic migration failure');
        for (const item of items) records.set(item.source, await makeCacheEntry({...item, target: '한국어'}));
        if (mode === 'cancel' && !requestedStop) { requestedStop = true; nodes.get('stop').handlers.click(); }
      },
      async lookup(item) { return records.get(item.source) || null; },
      async warm() { const entries = []; let bytes = 0; for (const entry of [...records.values()].reverse()) { const item = {source: entry.source, context: entry.context, target: entry.target, text: entry.text}; const n = byteSize(item); if (entries.length === 2000 || bytes + n > 2097152) break; entries.push(item); bytes += n; } return {entries, bytes, remaining: records.size - entries.length}; },
      async deleteOldest(count) { let deleted = 0; for (const key of records.keys()) { if (deleted === count) break; records.delete(key); deleted++; } return {deleted, cacheCount: records.size}; },
      async close() { if (mode === 'fallback') throw Error('Synthetic rejected ready promise'); },
      async destroy() { if (mode === 'fallback') throw Error('Synthetic rejected destroy'); databases.delete(databaseName); }
    };
  };
  class WorkerMock {
    constructor() { this.self = workerContext(data => queueMicrotask(() => this.onmessage?.({data: structuredClone(data)}))); }
    postMessage(data) { queueMicrotask(() => this.self.onmessage({data})); }
    terminate() { this.onmessage = null; }
  }
  const indexedDB = {async databases() { return [...databases.keys()].map(name => ({name})); }, deleteDatabase(name) { const request = {}; setImmediate(() => { fallbackDeletes++; databases.delete(name); request.onsuccess?.(); }); return request; }};
  let source = runnerOriginal.replace("import.meta.url", "'file:///benchmark/runner.mjs'")
    .replace("import('./candidate/cache-store.mjs')", 'Promise.resolve(__store)')
    .replace("import('./candidate/cache.mjs')", 'Promise.resolve(__cache)')
    // Only in the VM copy: 6/15/21 logical MB, enough to verify deletion of 1000.
    .replace('requestedMB * 1000000', 'requestedMB * 30000');
  const context = vm.createContext({document, window, navigator: {storage: {async estimate() { return {usage: 1000000, quota: mode === 'headroom' ? 1000001 : 1e12}; }}}, indexedDB, performance, crypto: webcrypto, Worker: WorkerMock, URL, Uint8Array, __store: {createCacheStore}, __cache: {makeCacheEntry, byteSize}});
  new vm.Script(source).runInContext(context);
  const returned = nodes.get('start').handlers.click();
  assert.equal(returned, undefined, 'click must not return the long-running job');
  await window.__benchPromise;
  const result = window.__benchState;
  assert(result.cleanupComplete, JSON.stringify(result.error));
  assert.equal(result.ownedDatabases.length, 0);
  assert.equal(databases.size, 0);
  assert(maxLive <= 1, 'destroy each database before next');
  assert.equal(JSON.parse(nodes.get('results').textContent).phase, result.phase);
  if (mode === 'success') {
    assert(result.completed && result.allPassed, JSON.stringify(result.results.map(r => r.error)));
    assert.equal(result.results.length, 3);
    for (const r of result.results) { assert.equal(r.hits.operations, 1000); assert.equal(r.misses.operations, 200); assert(r.deletion.verified); assert.equal(r.mapHot.operations, 100000); assert(r.overshootWithinOneBatch); assert.equal(r.schemaVersion, 4); assert.equal(r.nativeCountAfterPopulate, r.records); assert.equal(r.nativeCountAfterDeletion, r.records - 1000); assert(Number.isFinite(r.nativeCountAuditMs)); }
    // Verify rerun support, still no real database access.
    nodes.get('start').handlers.click(); await window.__benchPromise; assert(window.__benchState.allPassed);
  } else if (mode === 'cancel') assert(result.cancelled && !result.completed);
  else if (mode === 'quota') assert(result.results.every(r => r.status === 'native-storage-failure'));
  else if (mode === 'headroom') assert(result.results.every(r => r.status === 'blocked-low-headroom' && r.cleanup.notCreated));
  else if (mode === 'fallback') assert.equal(fallbackDeletes, 3);
  console.log(mode + ': PASS; phase=' + result.phase + '; cleanup=' + result.cleanupComplete);
}
(async () => { for (const mode of ['success', 'cancel', 'quota', 'headroom', 'fallback']) await scenario(mode); console.log('Generator determinism, numeric preservation, syntax and mock runner smoke checks passed. These are NOT browser performance results.'); })().catch(error => { console.error(error); process.exitCode = 1; });
