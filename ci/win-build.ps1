param(
    [string]$RepoUrl,
    [string]$Branch = "main",
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + $env:USERPROFILE + "\.cargo\bin"
}

function Add-ToPath([string]$PathEntry) {
    if (-not $PathEntry -or -not (Test-Path $PathEntry)) {
        return
    }

    $existing = $env:PATH -split ';' | Where-Object { $_ }
    if ($existing -notcontains $PathEntry) {
        $env:PATH = $PathEntry + ";" + $env:PATH
    }
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

    throw "Python was not found. win-install-deps.ps1 must run successfully before win-build.ps1."
}

function Invoke-Step([string]$Name, [scriptblock]$Action) {
    Write-Host "=== $Name ==="
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Refresh-Path
Add-ToPath (Join-Path $env:USERPROFILE ".cargo\bin")
Add-ToPath "C:\Program Files\Git\cmd"
Add-ToPath "C:\Program Files (x86)\NSIS"
Add-ToPath "C:\Program Files\NSIS"

$pythonExe = Get-PythonExe
Add-ToPath (Split-Path -Parent $pythonExe)
$env:PYTHON = $pythonExe
$env:npm_config_python = $pythonExe
[System.Environment]::SetEnvironmentVariable("PYTHON", $pythonExe, "Process")
[System.Environment]::SetEnvironmentVariable("npm_config_python", $pythonExe, "Process")
& $pythonExe --version

if (Test-Path C:\build\futo-notes) {
    Remove-Item -Recurse -Force C:\build\futo-notes
}

Invoke-Step "Cloning repo (branch: $Branch)" {
    # Disable credential manager to avoid wincredman errors
    git config --global credential.helper ""
    git clone --depth 1 --branch $Branch $RepoUrl C:\build\futo-notes
}

Set-Location C:\build\futo-notes

# The only place a Rust suite runs on Windows, and the only build that compiles
# the `#[cfg(not(unix))]` vault layer at all. A defect there reaches users
# without failing anything first: github#48 shipped one for three releases —
# the Windows implementation reported a missing parent FOLDER as an I/O error
# instead of absence, so every note a peer put in a folder this client did not
# have yet failed on every sync cycle, forever. The portable implementation is
# now compiled under test on Unix too (futo-notes-core's vault_fs contract
# tests), which is the fast guard; this step is the one that runs the shipped
# Windows build's own code against real Win32 error codes. It sits before the
# frontend build so it fails early, and needs no `dist/` because this crate
# does not embed the frontend.
#
# futo-notes-core ONLY, and the scope is load-bearing rather than a trim.
# This job deletes C:\build\futo-notes on entry, so nothing is cached: the
# release build below compiles the world from scratch, and a debug-profile test
# build shares none of it. Adding futo-notes-sync and futo-notes-store drags in
# ring, zstd, rusqlite and Tantivy for a second time — measured at 4.6x this
# crate's cold compile (13.3s -> 60.6s on a 32-core Linux box; 426M -> 2.5G of
# target/). On this VM that is ~20 extra minutes on a job whose baseline is 20
# and whose ceiling is 60, and pipeline 36527 duly died at exactly 3600s with
# server_timeout_running and an empty log. futo-notes-core is where the cfg
# branch lives and is the one crate free of C dependencies, which is also why
# the Linux-side `cargo check --target x86_64-pc-windows-msvc` in
# .gitlab-ci.yml covers exactly this crate. Widening either needs a measurement
# and a bigger budget, not a longer timeout (M15).
Invoke-Step "Rust tests (Windows)" {
    cargo test -p futo-notes-core
}

# .nvmrc only exists now that the repo is cloned; that is why win-install-deps
# installs fnm but no version. One native command per step: PowerShell 5.1
# ignores $ErrorActionPreference for native exit codes, so a failed `fnm use`
# followed by a passing `corepack` would leave $LASTEXITCODE at 0. -Width because
# the emitted line inlines the whole expanded PATH, and 5.1 wraps Out-String at
# the console width by default.
Invoke-Step "Loading the fnm environment" {
    fnm env --shell powershell | Out-String -Width 8192 | Invoke-Expression
}
Invoke-Step "Activating Node from .nvmrc" { fnm use --install-if-missing }
Invoke-Step "Enabling corepack" { corepack enable }
Invoke-Step "Pinning pnpm" { corepack prepare pnpm@10.29.2 --activate }

# Redundant with `fnm use` by design: activation here goes through
# Invoke-Expression of piped output, which is the one step no test covers.
$expectedNode = (Get-Content .nvmrc -Raw).Trim()
$activeNode = ((node --version) -replace '^v', '').Trim()
if ($activeNode -ne $expectedNode) {
    throw "Node $expectedNode is pinned in .nvmrc but $activeNode is active. The shipped Windows build must not be produced on an unpinned Node."
}
Write-Host "Node $activeNode | pnpm $(pnpm --version)"

Write-Host "=== Setting desktop version to $Version ==="
node scripts\desktop-version.mjs $Version
if ($LASTEXITCODE -ne 0) {
    throw "desktop version stamp failed with exit code $LASTEXITCODE"
}

Invoke-Step "Installing npm dependencies" {
    # The Windows desktop build only needs the root app, Tauri shell, and editor package.
    # Excluding the server workspace avoids native server-only deps like better-sqlite3.
    pnpm install --filter . --filter @futo-notes/tauri --filter @futo-notes/editor --frozen-lockfile
}

Invoke-Step "Building frontend" {
    pnpm run build
}

Set-Location apps\tauri
Invoke-Step "Building Tauri (Windows)" {
    cargo tauri build
}

Invoke-Step "Verifying the binary has no dynamic VC++ runtime dependency" {
    # The .cargo/config.toml `+crt-static` flag statically links the MSVC runtime
    # so the app launches on a clean Windows with no redistributable installed.
    # If a dependency ever silently forces the dynamic CRT back in, the .exe would
    # import VCRUNTIME140*/MSVCP140* and brick first launch on clean machines
    # again. dumpbin reads the import table; fail the build if those reappear.
    $exe = "..\..\target\release\futo-notes-tauri.exe"
    if (-not (Test-Path $exe)) { throw "Built exe not found at $exe" }

    # dumpbin ships with the MSVC toolchain but isn't on PATH; locate it via vswhere.
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found; cannot locate dumpbin" }
    $dumpbin = & $vswhere -latest -products * -find "**\dumpbin.exe" | Select-Object -First 1
    if (-not $dumpbin) { throw "dumpbin.exe not found via vswhere" }

    $deps = & $dumpbin /dependents $exe
    $bad = $deps | Select-String -Pattern 'VCRUNTIME140|MSVCP140' -CaseSensitive:$false
    if ($bad) {
        Write-Host ($bad | Out-String)
        throw "Binary still dynamically imports the VC++ runtime; crt-static is not taking effect. A clean Windows would fail to launch (MSVCP140_1.dll not found)."
    }
    Write-Host "OK: no VCRUNTIME140/MSVCP140 imports; CRT is statically linked."
}

Write-Host "=== Build artifacts ==="
Get-ChildItem -Recurse ..\..\target\release\bundle\nsis\ -ErrorAction Stop

Write-Host "=== Build complete ==="
