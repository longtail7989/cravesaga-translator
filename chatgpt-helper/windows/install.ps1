# No changes unless invoked without -WhatIf. Does not authenticate or start the host.
[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='Medium')]
param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CraveAITranslator\chatgpt-helper'),
  [switch]$Upgrade,
  [string]$ApplicationRoot
)
. (Join-Path $PSScriptRoot 'common.ps1')
Set-ApplicationScope $ApplicationRoot
$target = Assert-SafePath $InstallDir
$source = Assert-SafePath (Split-Path $PSScriptRoot -Parent)
if ($target -eq $source -or $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source and installation paths must not overlap.' }
if ($target -match '[^\x20-\x7E]' -or $NodePath -match '[^\x20-\x7E]') { throw 'Batch launcher currently requires ASCII installation and Node paths.' }
$node = [IO.Path]::GetFullPath($NodePath)
if (-not [IO.Path]::IsPathRooted($NodePath) -or $node -match '[%!^&|<>"\r\n]' -or [IO.Path]::GetFileName($node) -ne 'node.exe' -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Provide a fixed absolute node.exe path, not a shim or CLI.' }
# Query only the explicitly selected local Node binary. Clear ambient JS injection.
$oldOptions = $env:NODE_OPTIONS; $oldNodePath = $env:NODE_PATH
try {
  $env:NODE_OPTIONS = ''; $env:NODE_PATH = ''
  $version = & $node --version
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.(\d+)\.(\d+)') { throw 'Could not verify Node version.' }
  if ([version]$version.TrimStart('v') -lt [version]'22.12.0') { throw 'Node 22.12 or newer is required by the SDK.' }
} finally { $env:NODE_OPTIONS = $oldOptions; $env:NODE_PATH = $oldNodePath }
if (-not (Test-Path -LiteralPath (Join-Path $source 'host.cjs') -PathType Leaf)) { throw 'Release is incomplete: host.cjs missing. No installation performed.' }
Assert-NoReparseTree $source
# Explicit pinned runtime payload: never deploy downloads, caches, examples or auth tests.
$sdkRelative = 'sdk\openai-sign-in-with-chatgpt-devkit-0a36fef'
$payload = @('host.cjs', 'protocol.cjs', 'service.mjs', 'windows\common.ps1', 'windows\install.ps1', 'windows\uninstall.ps1', 'windows\dpapi.cjs', 'windows\README.md', 'windows\vendor\koffi', 'windows\vendor\PINNED-KOFFI.json', 'windows\vendor\npm-metadata.json', 'windows\vendor\LICENSE-KOFFI.txt', 'sdk\PINNED-SOURCE.json', 'sdk\README.md', "$sdkRelative\LICENSE", "$sdkRelative\THIRD_PARTY_NOTICES.md", "$sdkRelative\README.md", "$sdkRelative\packages\local\package.json", "$sdkRelative\packages\local\LICENSE", "$sdkRelative\packages\local\dist")
foreach ($dependency in @('jose', 'openai', 'proper-lockfile', 'graceful-fs', 'retry', 'signal-exit')) { $payload += "$sdkRelative\node_modules\$dependency" }
foreach ($relative in $payload) { if (-not (Test-Path -LiteralPath (Join-Path $source $relative))) { throw "Release payload missing: $relative" } }
$manifestPath = Join-Path $target ($HostName + '.json')
$registrations = @((Get-Registration Registry32), (Get-Registration Registry64))
$exists = Test-Path -LiteralPath $target
if ($exists) { Assert-OwnedInstall $target; Assert-NoReparseTree $target; if (-not $Upgrade) { throw 'Own installation exists; use -Upgrade to back up and replace.' }; foreach ($lock in @('.native-host.lock','.translator-service.lock')) { if (Test-Path -LiteralPath (Join-Path $target ('state\'+$lock))) { throw 'Helper lock exists. Close the helper before upgrading; never overwrite a live session.' } } }
foreach ($reg in $registrations) { if ($reg.Exists -and (-not $exists -or $reg.Value -ne $manifestPath)) { throw 'Native-host registry name collision. Nothing changed.' } }
# Chromium key has precedence over Chrome fallback. Do not silently override it.
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try { $shadow = $base.OpenSubKey("Software\Chromium\NativeMessagingHosts\$HostName"); if ($shadow) { $shadow.Dispose(); throw 'Chromium-specific host registration shadows Chrome fallback; manual review required.' } } finally { $base.Dispose() }
}
if (-not $PSCmdlet.ShouldProcess($target, 'Copy user-scoped helper, apply owner ACL, back up own state, register HKCU native host')) { return }
$parent = Split-Path $target -Parent
$backup = Join-Path $parent ('chatgpt-helper.backup.' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $parent -Force | Out-Null
New-Item -ItemType Directory -Path $backup | Out-Null
Protect-Directory $backup
Write-Json (Join-Path $backup 'registry-before.json') $registrations
if ($exists) { Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'install') -Recurse -Force }
$created = $false
try {
  if ($exists) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Directory -Path $target | Out-Null; $created = $true
  Protect-Directory $target
  foreach ($relative in $payload) {
    $destination = Join-Path $target $relative
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination -Recurse -Force
  }
  # State is retained only from the backed-up owned install, never from source release.
  $oldState = Join-Path $backup 'install\state'
  if (Test-Path -LiteralPath $oldState) { Copy-Item -LiteralPath $oldState -Destination $target -Recurse -Force }
  $state = Join-Path $target 'state'; New-Item -ItemType Directory -Path $state -Force | Out-Null; Protect-Directory $state
  $launcher = "@echo off`r`nsetlocal`r`nset `"NODE_OPTIONS=`"`r`nset `"NODE_PATH=`"`r`nset `"NODE_DEBUG=`"`r`nset `"NODE_DEBUG_NATIVE=`"`r`nset `"OPENAI_LOG=`"`r`nset `"DEBUG=`"`r`nset `"OPENAI_API_KEY=`"`r`nset `"OPENAI_BASE_URL=`"`r`nset `"OPENAI_ORG_ID=`"`r`nset `"OPENAI_PROJECT_ID=`"`r`n`"$node`" `"$(Join-Path $target 'host.cjs')`" --storage-dir `"$state`" %*`r`nexit /b %ERRORLEVEL%`r`n"
  [IO.File]::WriteAllText((Join-Path $target 'launch-chatgpt.bat'), $launcher, (New-Object Text.UTF8Encoding($false)))
  Write-Json $manifestPath @{ name=$HostName; description='Crave AI Translator ChatGPT helper'; path=(Join-Path $target 'launch-chatgpt.bat'); type='stdio'; allowed_origins=@($AllowedOrigin) }
  Write-Json (Join-Path $target '.crave-install.json') @{ host=$HostName; sid=$CurrentSid.Value; target=$target; node=$node; version=1; backup=$backup }
  foreach ($reg in $registrations) { Set-Registration $reg $manifestPath }
  Write-Output "Installed user-scoped helper at $target. Backup: $backup. Browser launch/auth not tested or performed."
} catch {
  $failure = $_
  foreach ($reg in $registrations) { if ($reg.Exists) { Set-Registration $reg $reg.Value } else { Set-Registration $reg $null } }
  if ($created -and (Test-Path -LiteralPath $target)) { Remove-Item -LiteralPath $target -Recurse -Force }
  if ($exists) { Copy-Item -LiteralPath (Join-Path $backup 'install') -Destination $target -Recurse -Force; Protect-Directory $target }
  throw $failure
}
