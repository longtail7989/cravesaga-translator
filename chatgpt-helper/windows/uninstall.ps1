[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='Medium')]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CraveAITranslator\chatgpt-helper'),
  [switch]$RemoveFiles,
  [string]$ApplicationRoot
)
. (Join-Path $PSScriptRoot 'common.ps1')
Set-ApplicationScope $ApplicationRoot
$target = Assert-SafePath $InstallDir
Assert-OwnedInstall $target
Assert-NoReparseTree $target
$manifestPath = Join-Path $target ($HostName + '.json')
$registrations = @((Get-Registration Registry32), (Get-Registration Registry64))
foreach ($reg in $registrations) { if ($reg.Exists -and $reg.Value -ne $manifestPath) { throw 'Registration no longer belongs to this install. Refusing removal.' } }
if (-not $PSCmdlet.ShouldProcess($target, 'Back up own registration and optionally files; unregister only own HKCU host')) { return }
$backup = Join-Path (Split-Path $target -Parent) ('chatgpt-helper.uninstall-backup.' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup | Out-Null
Protect-Directory $backup
Write-Json (Join-Path $backup 'registry-before.json') $registrations
if ($RemoveFiles) { Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'install') -Recurse -Force }
try {
  foreach ($reg in $registrations) { if ($reg.Exists) { Set-Registration $reg $null } }
  if ($RemoveFiles) { Remove-Item -LiteralPath $target -Recurse -Force }
} catch {
  foreach ($reg in $registrations) { if ($reg.Exists) { Set-Registration $reg $reg.Value } }
  throw
}
Write-Output "Own HKCU native-host registration removed. Backup: $backup. Without -RemoveFiles, helper and protected state remain. Backups are not purged automatically."
