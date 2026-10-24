Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$HostName = 'com.crave_ai_translator.chatgpt'
$AllowedOrigin = 'chrome-extension://mfoolamgailfmmpddefkpnbfiecleefi/'
$RegistrySubkey = "Software\Google\Chrome\NativeMessagingHosts\$HostName"
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$script:ApplicationScopeRoot = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
function Set-ApplicationScope([string]$Root) {
  if ([string]::IsNullOrEmpty($Root)) { return }
  if (-not [IO.Path]::IsPathRooted($Root) -or $Root -match '[%!^&|<>"\r\n]') { throw 'Invalid application root.' }
  $directory = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Root).TrimEnd('\'))
  if (-not $directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Application root must be an existing real directory.' }
  $owner = [IO.FileSystemAclExtensions]::GetAccessControl($directory).GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $CurrentSid.Value) { throw 'Application root must belong to the current Windows user.' }
  $script:ApplicationScopeRoot = $directory.FullName.TrimEnd('\')
}
function Assert-SafePath([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path) -or $Path -match '[%!^&|<>"\r\n]') { throw 'Absolute shell-safe path required.' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $profile = $script:ApplicationScopeRoot + '\'
  if (-not $full.StartsWith($profile, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path must be beneath the selected user-owned application root.' }
  $walk = $full
  while ($walk) {
    if (Test-Path -LiteralPath $walk) {
      if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse-point path rejected.' }
    }
    if ($walk -eq $script:ApplicationScopeRoot) { break }
    $walk = [IO.Path]::GetDirectoryName($walk)
  }
  return $full
}
function Protect-Directory([string]$Path) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($CurrentSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  foreach ($sid in @($CurrentSid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
  $actual = [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($Path))
  $allowed = @($CurrentSid.Value,'S-1-5-18')
  $unexpected = @($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed })
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value -or $unexpected.Count) { throw 'Private directory ACL verification failed.' }
}
function Write-Json([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
}
function Get-Registration([Microsoft.Win32.RegistryView]$View) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $View)
  try {
    $key = $base.OpenSubKey($RegistrySubkey)
    if (-not $key) { return [pscustomobject]@{ View=$View.ToString(); Exists=$false; Value=$null } }
    try {
      if ($key.SubKeyCount -ne 0 -or $key.ValueCount -ne 1 -or $key.GetValueNames()[0] -ne '' -or $key.GetValueKind('') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'Unexpected native-host registry contents; refusing collision.' }
      return [pscustomobject]@{ View=$View.ToString(); Exists=$true; Value=$key.GetValue('') }
    } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Set-Registration($Snapshot, [string]$ManifestPath) {
  $view = [Microsoft.Win32.RegistryView][Enum]::Parse([Microsoft.Win32.RegistryView], $Snapshot.View)
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try {
    if ([string]::IsNullOrEmpty($ManifestPath)) { $base.DeleteSubKeyTree($RegistrySubkey, $false) }
    else { $key = $base.CreateSubKey($RegistrySubkey); try { $key.SetValue('', $ManifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() } }
  } finally { $base.Dispose() }
}
function Assert-OwnedInstall([string]$Target) {
  $markerPath = Join-Path $Target '.crave-install.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Existing directory is not a recognized helper installation.' }
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  if ($marker.host -ne $HostName -or $marker.sid -ne $CurrentSid.Value -or $marker.target -ne $Target) { throw 'Existing installation ownership marker does not match.' }
  if ((Get-Acl -LiteralPath $Target).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value) { throw 'Existing installation has different owner.' }
}
function Assert-NoReparseTree([string]$Folder) {
  foreach ($entry in Get-ChildItem -LiteralPath $Folder -Recurse -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse-point content rejected.' }
  }
}
