'use strict';
// Direct native application API. No interpreter, child process, or policy changes.
const path = require('node:path');
const PREFIX = Buffer.from('dpapi-current-user:v1:', 'ascii');
const ENTROPY = Buffer.from('com.crave_ai_translator.chatgpt:oauth-state:v1', 'utf8');
const LIMIT = 1024 * 1024;
let native;
let launchBrowser;
function binding() {
  if (native) return native;
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 native DPAPI required; no plaintext fallback.');
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root) || /[\r\n]/.test(root)) throw new Error('Invalid Windows system root.');
  const koffi = require('./vendor/koffi/index.cjs');
  if (koffi.version !== '3.3.4') throw new Error('Pinned native DPAPI dependency mismatch.');
  const crypt = koffi.load(path.win32.join(root, 'System32', 'Crypt32.dll'));
  const kernel = koffi.load(path.win32.join(root, 'System32', 'Kernel32.dll'));
  koffi.struct('CRAVE_DATA_BLOB_V1', { cbData: 'uint32_t', pbData: 'void *' });
  const protect = crypt.func('int __stdcall CryptProtectData(CRAVE_DATA_BLOB_V1 *input, void *description, CRAVE_DATA_BLOB_V1 *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ CRAVE_DATA_BLOB_V1 *output)');
  const unprotect = crypt.func('int __stdcall CryptUnprotectData(CRAVE_DATA_BLOB_V1 *input, void *description, CRAVE_DATA_BLOB_V1 *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ CRAVE_DATA_BLOB_V1 *output)');
  const localFree = kernel.func('void * __stdcall LocalFree(void *memory)');
  native = { koffi, protect, unprotect, localFree }; return native;
}
function bytes(value, maximum = LIMIT) {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected OAuth state bytes.');
  if (!value.length || value.length > maximum) throw new Error('Invalid OAuth state size.');
  return Buffer.from(value);
}
function invoke(operation, input) {
  const api = binding(), owned = [], output = { cbData: 0, pbData: null };
  function allocate(data) {
    const pointer = api.koffi.alloc('uint8_t', data.length);
    if (!pointer) throw new Error('Native DPAPI allocation failed.');
    const view = new Uint8Array(api.koffi.view(pointer, data.length));
    owned.push({ pointer, view }); view.set(data);
    return { cbData: data.length, pbData: pointer };
  }
  try {
    const data = allocate(input), entropy = allocate(ENTROPY);
    // CRYPTPROTECT_UI_FORBIDDEN=1, no LOCAL_MACHINE flag: CurrentUser scope.
    if (!api[operation](data, null, entropy, null, null, 1, output)) throw new Error('Windows CurrentUser DPAPI operation failed; no plaintext fallback.');
    if (!Number.isInteger(output.cbData) || output.cbData < 1 || output.cbData > LIMIT + 4096 || !output.pbData) throw new Error('Invalid native DPAPI response.');
    return Buffer.from(new Uint8Array(api.koffi.view(output.pbData, output.cbData)));
  } finally {
    // DPAPI output is wiped and LocalFree'd, never freed by the Koffi allocator.
    try {
      if (output.pbData) {
        try { if (Number.isInteger(output.cbData) && output.cbData > 0 && output.cbData <= LIMIT + 4096) new Uint8Array(api.koffi.view(output.pbData, output.cbData)).fill(0); }
        finally { api.localFree(output.pbData); }
      }
    } finally {
      for (const item of owned) { try { item.view.fill(0); } finally { api.koffi.free(item.pointer); } }
    }
  }
}
function ciphertext(value) {
  const envelope = bytes(value, (LIMIT + 4096) * 2);
  if (envelope.length <= PREFIX.length || !envelope.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('Unprotected or unsupported OAuth state rejected.');
  const text = envelope.subarray(PREFIX.length).toString('utf8');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4) throw new Error('Invalid protected OAuth state.');
  const result = Buffer.from(text, 'base64');
  if (result.toString('base64') !== text || result.length > LIMIT + 4096) throw new Error('Invalid protected OAuth state.');
  return result;
}
function protectSync(value) {
  const input = bytes(value, LIMIT - 4096);
  try { return Buffer.concat([PREFIX, Buffer.from(invoke('protect', input).toString('base64'), 'ascii')]); }
  finally { input.fill(0); }
}
function unprotectSync(value) {
  const input = ciphertext(value);
  try { return invoke('unprotect', input); } finally { input.fill(0); }
}
// Promise hooks use the bounded synchronous native call. No subprocess lifetime.
async function protect(value) { return protectSync(value); }
async function unprotect(value) { return unprotectSync(value); }
async function openBrowser(value) {
  // OAuth URL is intentionally never logged or interpolated into a command.
  let url;
  try {
    if (typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)) throw new Error();
    url = new URL(value);
    if (url.origin !== 'https://auth.openai.com' || url.username || url.password) throw new Error();
  } catch { throw new Error('Authorization browser URL rejected.'); }
  const api = binding();
  if (!launchBrowser) {
    const shell = api.koffi.load(path.win32.join(process.env.SystemRoot, 'System32', 'Shell32.dll'));
    launchBrowser = shell.func('intptr_t __stdcall ShellExecuteW(void *window, str16 operation, str16 file, str16 parameters, str16 directory, int show)');
  }
  // Native ShellExecute API, not cmd.exe, a shell command string, or a spawn.
  const result = Number(launchBrowser(null, 'open', url.href, null, null, 1));
  if (!Number.isFinite(result) || result <= 32) throw new Error('Windows could not open the authorization browser.');
}
module.exports = { protect, unprotect, protectSync, unprotectSync, openBrowser };