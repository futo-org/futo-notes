$ErrorActionPreference = "Stop"

Write-Host "=== Installing build dependencies ==="

# Refresh PATH helper
function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:USERPROFILE + "\.cargo\bin"
}

# Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Git..."
    winget install --id Git.Git --accept-source-agreements --accept-package-agreements -e
    Refresh-Path
}
git --version

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Node.js..."
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements -e
    Refresh-Path
}
node --version

# pnpm
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pnpm..."
    npm install -g pnpm@10.29.2
    Refresh-Path
}
pnpm --version

# NSIS
if (-not (Get-Command makensis -ErrorAction SilentlyContinue)) {
    Write-Host "Installing NSIS..."
    winget install --id NSIS.NSIS --accept-source-agreements --accept-package-agreements -e
    Refresh-Path
}

# tauri-cli (cargo-binstall should already be available since Rust is on the template)
if (-not (Get-Command cargo-tauri -ErrorAction SilentlyContinue)) {
    Write-Host "Installing tauri-cli..."
    cargo binstall tauri-cli --no-confirm --locked
    Refresh-Path
}
cargo tauri --version

Write-Host "=== All dependencies installed ==="
