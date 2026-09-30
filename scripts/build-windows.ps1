<#
.SYNOPSIS
  Builds the pgsql-erd Windows executables with electron-builder.

.DESCRIPTION
  Installs dependencies, runs the unit tests and builds the requested targets
  into .\dist:
    installer  dist\pgsql-erd-Setup-<version>.exe   (NSIS installer, registers .pgerd)
    portable   dist\pgsql-erd-<version>-portable.exe (single .exe, no install)
    dir        dist\win-unpacked\pgsql-erd.exe       (unpacked app, fastest to build)
    all        installer + portable (default)

.EXAMPLE
  .\scripts\build-windows.ps1
  .\scripts\build-windows.ps1 -Target portable -SkipTests
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'installer', 'portable', 'dir')]
  [string]$Target = 'all',
  [switch]$SkipTests,
  [switch]$SkipInstall,
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-Step([string]$Title, [scriptblock]$Command) {
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Title failed (exit code $LASTEXITCODE)" }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found on PATH. Install Node.js 20 or newer from https://nodejs.org/'
}
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required (found $(node --version))." }

if ($Clean -and (Test-Path dist)) {
  Write-Host '==> Removing dist' -ForegroundColor Cyan
  Remove-Item -Recurse -Force dist
}

if (-not $SkipInstall) { Invoke-Step 'Installing dependencies' { npm ci } }
if (-not $SkipTests) { Invoke-Step 'Running tests' { npm test } }

$script = @{
  all       = 'dist:win'
  installer = 'dist:win:installer'
  portable  = 'dist:win:portable'
  dir       = 'dist:win:dir'
}[$Target]
Invoke-Step "Building ($Target)" { npm run $script }

Write-Host ''
Write-Host 'Built:' -ForegroundColor Green
Get-ChildItem dist -Filter *.exe | ForEach-Object {
  '  {0}  ({1:N1} MB)' -f $_.FullName, ($_.Length / 1MB)
}
if (Test-Path dist\win-unpacked\pgsql-erd.exe) {
  '  {0}' -f (Resolve-Path dist\win-unpacked\pgsql-erd.exe)
}
