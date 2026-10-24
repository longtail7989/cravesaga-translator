# Windows packaging and protected storage

Implementation only. No installation, registry write, SDK auth, browser connection, or real credential/keyring access was performed by this work.

## Files / runtime contract

- `install.ps1`: user-only stable copy, ownership marker, owner+SYSTEM ACL, backup of an existing owned install and both own HKCU registry views before mutation, rollback on installation errors. Refuses unknown existing directories/registrations, reparse points, source/target overlap, Chromium shadow registrations, unsafe CMD characters and non-ASCII launcher paths. No admin, HKLM writes, PATH edits, global npm/CLI install, scheduled task or autostart.
- `uninstall.ps1`: backs up registration and unregisters only matching own HKCU keys. Leaves files/state by default. `-RemoveFiles` first backs up the owned helper including protected state. Backups remain private; never auto-purged or auto-restored.
- `common.ps1`: shared path, ACL, marker and registry helpers. Intended to be shipped beside scripts.
- `dpapi.cjs`: CommonJS named exports `protect(bytes)`, `unprotect(bytes)` returning `Promise<Buffer>`; `protectSync(bytes)`, `unprotectSync(bytes)` return `Buffer`. Inputs are Uint8Array/Buffer, not strings. It does not read or write state files. Service must write only the protected return bytes atomically inside `<install>/state`, supply its own runtime exclusive lock, and fail closed if bridge fails. Never store the SDK plaintext first.
- `dpapi.cjs` now directly calls Windows DPAPI through pinned Koffi native FFI; it spawns no process, runs no PowerShell at runtime, and never changes or overrides script execution policy. The obsolete `dpapi-bridge.ps1` was removed. CurrentUser scope, `CRYPTPROTECT_UI_FORBIDDEN=1`, null prompt/reserved/description, fixed application entropy, no LOCAL_MACHINE flag. Crypt32.dll and Kernel32.dll are loaded by absolute System32 paths. Input plaintext is copied into bounded native allocations, wiped then Koffi-freed; DPAPI output is copied into the return Buffer, wiped in native memory then LocalFree'd. Public Promise hooks wrap the bounded synchronous native call. Protected envelope remains `dpapi-current-user:v1:<base64>` bytes.
- `openBrowser(url)` is an additional async export in `dpapi.cjs` for the SDK browser hook. It accepts only HTTPS origin `https://auth.openai.com` with no credentials/nonstandard port, rejects control characters and oversized input, and never logs the URL. It calls `ShellExecuteW` from absolute System32 Shell32.dll with the native `open` verb, null parameters/directory, and checks the native return value (>32). No cmd/shell command or child-process API is used. It does not run during storage initialization or tests unless explicitly called. No real browser launch was performed here.
- `test-browser-mock.cjs`: only mocked native browser calls, strict HTTPS allowlist/rejection and failed-API return checks, no real URLs or browser side effects.
- `test-native-mock.cjs`: mocked sync/async roundtrip, exact DLL paths/flags/entropy, allocation wiping/freeing on success and API failure, size bounds and no interpreter dependency.
- `test-dpapi-bytes.cjs`: actual synthetic-only sync/async/cross-mode, malformed/plaintext/empty/oversize/tamper checks. No OAuth, SDK auth, registry or browser calls.
- `vendor/PINNED-KOFFI.json` and `vendor/npm-metadata.json`: exact official npm metadata, tarball SHA512 and per-packaged-file SHA256 inventory. `vendor/LICENSE-KOFFI.txt` is the upstream MIT license from the official Koromix repository. Upstream packaged notices are retained. No npm install, lifecycle script, compiler or global package installation was invoked.

## Native dependency acquisition

Official packages pinned to 3.3.4:

- `https://registry.npmjs.org/koffi/-/koffi-3.3.4.tgz`: **302,759 bytes**, SHA512 `31Vr+LM+w1dEsNcOJtJWvYyUTjVc/SWOxNDZJxfhsBC6qZ5YVn98n5x1oBbDq5skxCbWD4SByJpNmq63fvg9Aw==`.
- `https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-3.3.4.tgz`: **401,224 bytes**, SHA512 `/SpehfYrO9DtkoB0ZOgGyco4GH4zwhEyFqgCm0x8lbzXnrKiwnHXWmPpfuXhFYohFvoSO5jlLQz/hc1fJ5G0AQ==`.

Both hashes matched exact official npm version metadata before extraction. Extraction rejected unsafe paths/links/special files; a second pass checked all **87 core + 5 native package files** against verified tarball contents. Packages plus the added upstream MIT license total **93 files / 2,801,454 bytes** (not counting metadata/pin JSON). The two downloaded tarballs remain provenance artifacts but are excluded from installer payload. Native package is exclusively `windows/vendor/koffi/node_modules/@koromix/koffi-win32-x64`; no machine/global install. Official API references: https://koffi.dev/load and https://koffi.dev/pointers . Only Windows x64 is packaged; unsupported platforms fail closed.

A synthetic protect/unprotect preflight must succeed before SDK authorization starts. Failure to execute the bridge, policy denial, a bad response or roundtrip mismatch must block login without writing plaintext. A host status canary can verify packaging before any auth, but is not itself proof of a DPAPI roundtrip.

DPAPI limits are per user on this Windows account. It does not defend against malware already running as that user, administrators/SYSTEM, process-memory inspection, or compromise of Windows profile/master keys. JS/SDK strings and OS pipe buffers cannot be reliably zeroed. The adapter wipes owned plaintext buffers where practical; caller owns returned plaintext lifetime. No plaintext fallback. Backups can include protected OAuth blobs and should remain access restricted.

## Invocation for later approved installation

The official SDK used by runtime requires **Node >=22.12**, stricter than the initial Node 20 baseline. An inspected local fixed executable is `C:\Users\<USER>\.aside\runtime\node\node.exe` and its version query returned `v26.5.0`. This is a runtime only, not Codex or Claude CLI. It is not copied or downloaded; launcher pins this absolute path. Choose another verified local Node.exe if needed.

From `chatgpt-helper/windows`, preview only:

```powershell
.\install.ps1 -NodePath 'C:\Users\<USER>\.aside\runtime\node\node.exe' -InstallDir 'C:\Users\<USER>\.aside\u\0\tools\crave-chatgpt-helper' -WhatIf
```

After separate approval, the same invocation without `-WhatIf` installs. Default destination when omitted is `%LOCALAPPDATA%\CraveAITranslator\chatgpt-helper`. An existing recognized own install additionally requires `-Upgrade`. The installer copies an explicit pinned runtime allowlist: host/protocol/service, Windows support, SDK pin/README, local SDK package manifest/LICENSE/dist, upstream licenses/notices, and the six local dependency packages jose/openai/proper-lockfile/graceful-fs/retry/signal-exit including their licenses. SDK downloads, npm caches, upstream tarball, examples, development sources and auth tests are excluded. It does not fetch packages and fails before modification if any required payload path is missing. State is excluded from source release and retained only from a previously owned installation. Do not run concurrent installers/uninstallers or upgrade while host is active. Runtime PID/nonce locking belongs to host/service, not these scripts.

```powershell
.\uninstall.ps1 -InstallDir 'C:\Users\<USER>\.aside\u\0\tools\crave-chatgpt-helper' -WhatIf
# Actual unregister, only after approval: omit -WhatIf.
# Optional -RemoveFiles preserves an owner-restricted backup before removing files.
```

The generated launcher contains only constant, validated absolute Node and host paths, clears NODE_OPTIONS and NODE_PATH, passes `--storage-dir "<install>\state"` before forwarding native Chrome origin/window arguments. It does not print status to stdout. Installation changes only HKCU `Software\Google\Chrome\NativeMessagingHosts\com.crave_ai_translator.chatgpt` (32/64 views) with default REG_SZ absolute manifest path. The manifest permits exactly `chrome-extension://mfoolamgailfmmpddefkpnbfiecleefi/`, type `stdio`, host name `com.crave_ai_translator.chatgpt`; no wildcard or other extension.

## Browser registration and batch-launch evidence

Inspected official sources:

1. Chrome native messaging docs: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging document Windows HKCU/HKLM `Software\Google\Chrome\NativeMessagingHosts\<host>` manifest registration, exact allowed_origins and 32-bit before 64-bit lookup.
2. Chromium source: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_win.cc (observed blob `bde1be53e4cc246c55c7a036ad6c84edb520fe0a`) explicitly checks `Software\Chromium\NativeMessagingHosts` for CHROMIUM_BRANDING, then falls back to `Software\Google\Chrome\NativeMessagingHosts`; HKCU is checked when user-level hosts are allowed, before HKLM. The same source launches non-.exe hosts through CMD; .exe may use direct launch.
3. Official Chrome extension sample batch host: https://raw.githubusercontent.com/GoogleChrome/chrome-extensions-samples/main/api-samples/nativeMessaging/host/native-messaging-example-host.bat contains `@echo off` followed by `python "%~dp0/native-messaging-example-host" %*`. Thus a Windows batch wrapper is officially demonstrated, not an invented executable requirement. Our launcher substitutes a fixed Node executable and fixed host path.

**Unknown:** Aside-specific compiled branding/version, vendor patches and enterprise native-messaging policy were not verified. A process executable metadata lookup was unavailable in this sandbox. We did not inspect login data, browser credential/user databases, or register a host to test discovery. Standard upstream Chromium fallback supports the Chrome key, but Aside success is conditional until a later authorized native connection. We do not claim live Aside integration works yet. If policy blocks CMD/batch, fail closed; a bounded alternative is a small reviewed/signed stdio-only .exe launcher with fixed Node/host paths and inherited pipes, built/tested separately. Do not ship a fabricated EXE or silently add extra registry brands.

## Validation in this environment

Parent reported WindowsPowerShell 5 `-File` invocation failed with UnauthorizedAccess under unchanged policy, while a .NET CurrentUser DPAPI synthetic API canary succeeded in normal parent PowerShell 7. The runtime script bridge was therefore removed, not bypassed or switched to another interpreter. Direct native API usage is the normal application storage implementation, not a script-policy workaround. Installer/uninstaller remain normal PowerShell scripts; no execution-policy changes are made.

Official package tarball SHA512 verification and all extracted-file content checks passed. The new native adapter and mock tests are supplied for validation. A synthetic native Node child attempt in this worker timed out at 20 seconds even with explicit process working directory; this worker does not claim live native adapter success. Parent must run the mock and actual synthetic `test-dpapi-bytes.cjs` using its working Node `-e` file loader, then the host status canary and storage roundtrip before any OAuth. Actual auth, installation, browser native connection and registry modification were not performed here. Never test using real OAuth credentials.

### 제한된 자동화 환경에서 설치가 차단된 경우

폴더 ACL 변경이 거부되면 설치는 완료되지 않은 것입니다. 기존의 공유 권한을 그대로 수용하거나 보호 저장을 생략하지 마세요. 사용자가 일반 Windows 세션에서 동봉된 `설치 시작.cmd`를 한 번 직접 실행해야 합니다. 이 런처는 관리자 승격이나 실행 정책 우회 없이 기존 PowerShell 7과 고정 Node 경로로 사용자 범위 설치를 실행합니다. 성공한 뒤 확장 아이콘에서 ChatGPT 로그인 버튼을 누르세요.

`-ApplicationRoot`는 자동화 환경의 별도 앱 폴더가 필요할 때만 사용하는 선택 항목이며, 실제 Windows 사용자 소유권을 확인한 경로만 허용합니다. 기본 설치에서는 사용자 프로필 경계를 유지합니다. 런타임의 토큰 암호화 및 브라우저 열기는 PowerShell을 사용하지 않습니다.
