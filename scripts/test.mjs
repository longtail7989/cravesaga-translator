#!/usr/bin/env node
// Offline only. No login, live providers, browser profile, or installed extension.
import {spawnSync} from 'node:child_process';
import {readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
 'auto-advance.cjs', 'backlog.cjs', 'story-policy.cjs',
 'cache.cjs', 'chatgpt-ui.cjs', 'chatgpt-worker.cjs', 'cli-removal.cjs',
 'distribution-broker.cjs', 'distribution-client.cjs', 'distribution-store.cjs',
 'distribution-ui.cjs', 'editor-ui.cjs', 'editor.cjs', 'latency.cjs',
 'names.cjs', 'network.cjs', 'popup-transfer.cjs', 'popup.cjs', 'relay-off.cjs',
 'remote-ui.cjs', 'retry.cjs', 'run.cjs', 'subscription-ui.cjs', 'worker.cjs'
];
// These exported fixture suites execute inside worker.cjs with its mock worker.
const embedded = ['cache-off.cjs', 'merge-policy.cjs'];
const expected = [...suites, ...embedded].sort();
const actual = readdirSync(path.join(root,'tests')).filter(f => f.endsWith('.cjs') && f !== 'serve.cjs').sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error('CJS suite inventory changed; update scripts/test.mjs explicitly');
const worker = readFileSync(path.join(root,'tests/worker.cjs'),'utf8');
for (const file of embedded) if (!worker.includes('tests/' + file)) throw Error('Missing embedded suite: ' + file);
// Windows runners may expose TEMP through an 8.3 alias such as RUNNER~1.
// Keep one canonical scratch identity for isolated Windows test storage.
const scratch = realpathSync.native(mkdtempSync(path.join(os.tmpdir(),'crave-ai-offline-')));
let failed = 0;
try {
 const home = path.join(scratch,'home'); mkdirSync(home);
 const env = {...process.env, CRAVE_AI_ROOT:root, HOME:home, USERPROFILE:home,
  APPDATA:path.join(home,'AppData','Roaming'), LOCALAPPDATA:path.join(home,'AppData','Local'),
  TMP:scratch, TEMP:scratch, TMPDIR:scratch};
 // Drop accidental provider credentials and inherited Node preloads.
 for (const key of Object.keys(env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|AUTHORIZATION)/i.test(key) || key === 'NODE_OPTIONS') delete env[key];
 // Propagate only these controlled path flags to child fixtures, never caller-provided preloads.
 env.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main';
 const entries = suites.map(f => 'tests/' + f);
 for (const file of entries) {
  console.log('\n=== ' + file + ' ===');
  // Direct file execution preserves __dirname; node:test runs without --test discovery.
  // This also works in constrained environments where --test cannot stat ancestors.
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', '--experimental-vm-modules', path.join(root,file)];
  const result = spawnSync(process.execPath,args,{cwd:scratch,env,stdio:'inherit',timeout:120000});
  if (result.error || result.status !== 0) { failed++; console.error('FAILED ' + file, result.error?.message || result.signal || result.status); }
 }
} finally { rmSync(scratch,{recursive:true,force:true}); }
console.log('\n' + (failed ? 'FAILED: ' + failed + ' entrypoint(s)' : 'PASS: ' + expected.length + ' offline extension CJS suites (' + suites.length + ' entrypoints + ' + embedded.length + ' embedded worker suites).'));
if (failed) process.exitCode = 1;
