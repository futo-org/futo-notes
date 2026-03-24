param(
    [string]$RepoUrl,
    [string]$Branch = "main",
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"

# Ensure PATH includes all tools
$env:PATH = $env:USERPROFILE + "\.cargo\bin;" + `
    "C:\Program Files\Git\cmd;" + `
    "C:\Program Files\nodejs;" + `
    "C:\Program Files (x86)\NSIS;" + `
    $env:PATH

Write-Host "=== Cloning repo (branch: $Branch) ==="
if (Test-Path C:\build\stonefruit) {
    Remove-Item -Recurse -Force C:\build\stonefruit
}
git clone --depth 1 --branch $Branch $RepoUrl C:\build\stonefruit
Set-Location C:\build\stonefruit

Write-Host "=== Setting version to $Version ==="
$conf = Get-Content apps\tauri\src-tauri\tauri.conf.json | ConvertFrom-Json
$conf.version = $Version
$conf | ConvertTo-Json -Depth 10 | Set-Content apps\tauri\src-tauri\tauri.conf.json

Write-Host "=== Installing npm dependencies ==="
pnpm install --frozen-lockfile

Write-Host "=== Building frontend ==="
pnpm run build

Write-Host "=== Building Tauri (Windows) ==="
Set-Location apps\tauri
cargo tauri build

Write-Host "=== Build artifacts ==="
Get-ChildItem -Recurse src-tauri\target\release\bundle\nsis\

Write-Host "=== Build complete ==="
