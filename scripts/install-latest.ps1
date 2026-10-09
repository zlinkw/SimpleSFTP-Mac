$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageInfo = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$extensionId = "$($packageInfo.publisher).$($packageInfo.name)"
$targetVersion = [version]$packageInfo.version
$targetPackage = Join-Path $projectRoot "simple-sftp-$targetVersion.vsix"
$temporaryRoot = [System.IO.Path]::TrimEndingDirectorySeparator([System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).ProviderPath))
$lockPath = Join-Path $temporaryRoot 'simple-sftp-install.lock'
if ((Split-Path -Parent $lockPath) -ne $temporaryRoot) { throw 'Unsafe install lock parent' }
if (Test-Path -LiteralPath $lockPath) {
  if ((Get-Item -LiteralPath $lockPath).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Unsafe install lock link' }
}
# OS-held fixed slot; release closes the descriptor, never deletes the file.
$heldLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  $installedRow = @(& code --list-extensions --show-versions) | Where-Object { $_ -match ('^' + [regex]::Escape($extensionId) + '@') } | Select-Object -First 1
  if ($LASTEXITCODE -ne 0) { throw 'Could not list installed extensions' }
  if ($installedRow) {
    $installedText = ($installedRow -split '@', 2)[1]
    if ($installedText -notmatch '^\d+\.\d+\.\d+$') { throw "Installed version needs explicit review: $installedText" }
    $installedVersion = [version]$installedText
    if ($installedVersion -eq $targetVersion) { Write-Output "$extensionId@$targetVersion already installed; skipped"; return }
    if ($installedVersion -gt $targetVersion) { throw 'Refusing extension downgrade' }
  }
  if (!(Test-Path -LiteralPath $targetPackage -PathType Leaf)) { throw "Missing VSIX: $targetPackage" }
  & code --install-extension $targetPackage
  if ($LASTEXITCODE -ne 0) { throw 'Extension installation failed' }
  $verifiedRow = @(& code --list-extensions --show-versions) | Where-Object { $_ -eq "$extensionId@$targetVersion" }
  if ($LASTEXITCODE -ne 0 -or !$verifiedRow) { throw 'Installed version verification failed' }
  Write-Output "$extensionId@$targetVersion installed once; Reload Window required"
} finally { $heldLock.Dispose() }
