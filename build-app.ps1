param(
  [switch]$SkipInstall = $false
)

# Builds the production frontend artifact (frontend/dist) that the resident
# FastAPI backend serves statically. Run this after changing frontend code —
# start-app.cmd / start-tray.cmd only auto-build when dist is MISSING, so an
# existing (stale) dist would otherwise keep serving the old UI.
#
# The Python backend needs no compilation/packaging, so unlike the Java
# reference projects there is no jar step — the only build output is dist.

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendDir = Join-Path $scriptRoot 'frontend'
$distDir = Join-Path $frontendDir 'dist'

if (-not (Test-Path $frontendDir)) { throw "Frontend directory not found: $frontendDir" }

Write-Host "Building frontend..."
Push-Location $frontendDir
try {
  if (-not $SkipInstall -and -not (Test-Path 'node_modules')) {
    Write-Host "node_modules not found — running npm install..."
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
} finally {
  Pop-Location
}

if (-not (Test-Path $distDir)) { throw "Build finished but dist not found: $distDir" }

Write-Host ""
Write-Host "==============================================="
Write-Host " Frontend artifact ready"
Write-Host "   Frontend: $distDir"
Write-Host " Launch with start-app.cmd (window) or start-tray.cmd (tray)"
Write-Host "==============================================="
