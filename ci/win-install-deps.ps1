$ErrorActionPreference = "Stop"

Write-Host "=== Installing build dependencies ==="

# Refresh PATH helper
function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:USERPROFILE + "\.cargo\bin"
}

function Get-PythonExe {
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        $resolved = (& py -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $resolved -and (Test-Path $resolved.Trim())) {
            return $resolved.Trim()
        }
    }

    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    $commandSource = $null
    if ($pythonCommand -and $pythonCommand.Source -notlike "*WindowsApps*") {
        $commandSource = $pythonCommand.Source
    }

    $candidates = @(
        $commandSource,
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
        "C:\Program Files\Python313\python.exe",
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python311\python.exe"
    ) | Where-Object { $_ }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

# Python (needed by node-gyp for native modules like better-sqlite3)
$pythonExe = Get-PythonExe
if (-not $pythonExe) {
    Write-Host "Installing Python..."
    winget install --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements -e
    Refresh-Path
    $pythonExe = Get-PythonExe
}
if (-not $pythonExe) {
    throw "Python installation succeeded, but python.exe could not be located"
}
$pythonDir = Split-Path -Parent $pythonExe
Write-Host "Using Python at $pythonExe"
$env:PATH = $pythonDir + ";" + $env:PATH
$env:PYTHON = $pythonExe
$env:npm_config_python = $pythonExe
[System.Environment]::SetEnvironmentVariable("PYTHON", $pythonExe, "User")
[System.Environment]::SetEnvironmentVariable("npm_config_python", $pythonExe, "User")
& $pythonExe --version

# Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Git..."
    winget install --id Git.Git --accept-source-agreements --accept-package-agreements -e
    Refresh-Path
}
git --version

# fnm, not a Node version: this script is scp'd to the VM alone and runs BEFORE
# the clone, so .nvmrc does not exist yet. win-build.ps1 activates the version
# (and pnpm, via corepack) after the clone.
if (-not (Get-Command fnm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing fnm..."
    winget install --id Schniz.fnm --accept-source-agreements --accept-package-agreements -e
    Refresh-Path
}
if (-not (Get-Command fnm -ErrorAction SilentlyContinue)) {
    throw "fnm installation reported success but fnm is not on PATH. A native command that fails does not throw under PowerShell 5.1, so this check is what makes the install real."
}
fnm --version

# fnm activates by creating a directory symlink, which needs
# SeCreateSymbolicLinkPrivilege — an elevated token or Developer Mode. This SSH
# session is not elevated unless the account is Administrator. Prove it HERE, at
# provisioning, because the same failure inside build:windows is allow_failure on
# merge requests and would only surface at tag time, after windows:sign is skipped
# and release:gate is already blocked.
fnm env --shell powershell | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "fnm is installed but 'fnm env' failed (exit $LASTEXITCODE). fnm needs permission to create a directory symlink: enable Developer Mode on this VM, or grant the build account SeCreateSymbolicLinkPrivilege."
}

# NSIS
if (-not (Get-Command makensis -ErrorAction SilentlyContinue)) {
    Write-Host "Installing NSIS..."
    winget install --id NSIS.NSIS --accept-source-agreements --accept-package-agreements -e
    Refresh-Path
}

# cargo-binstall (for fast binary installs)
if (-not (Get-Command cargo-binstall -ErrorAction SilentlyContinue)) {
    Write-Host "Installing cargo-binstall..."
    # Use the official installer script
    Set-ExecutionPolicy Unrestricted -Scope Process -Force
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.ps1" -OutFile install-binstall.ps1
    .\install-binstall.ps1
    Remove-Item install-binstall.ps1
    Refresh-Path
}

# tauri-cli
if (-not (Get-Command cargo-tauri -ErrorAction SilentlyContinue)) {
    Write-Host "Installing tauri-cli..."
    cargo binstall tauri-cli --no-confirm --locked
    Refresh-Path
}
cargo tauri --version

Write-Host "=== All dependencies installed ==="
