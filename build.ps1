# Builds Nax-Notepad in release mode and packages it with Inno Setup 7.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1 [-SkipInstaller] [-AllowDirty]
# A release is built only from committed code that passes the tests. -AllowDirty builds from
# uncommitted changes for a local try-out; such a build must not be published.
param(
    [switch]$SkipInstaller,
    [switch]$AllowDirty
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) { $env:Path = "$cargoBin;$env:Path" }

foreach ($tool in @("node", "npm", "cargo")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not installed. Node: winget install OpenJS.NodeJS ; Rust: winget install Rustlang.Rustup"
    }
}

$version = (Get-Content package.json | ConvertFrom-Json).version
Write-Host "== Nax-Notepad $version ==" -ForegroundColor Cyan

# The version lives in three files; they must agree, or the update check and the installer lie.
$confVersion = (Get-Content src-tauri\tauri.conf.json | ConvertFrom-Json).version
$cargoVersion = (Select-String -Path src-tauri\Cargo.toml -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
if ($confVersion -ne $version -or $cargoVersion -ne $version) {
    throw "Version mismatch: package.json $version, tauri.conf.json $confVersion, Cargo.toml $cargoVersion"
}

if (-not $AllowDirty) {
    # Untracked files count too: the build would compile a new source file that was never added.
    $changes = git status --porcelain
    if ($LASTEXITCODE) { throw "git status failed" }
    if ($changes) { throw "The working tree has uncommitted changes. Commit them first, or pass -AllowDirty for a local build that is not published." }
}

if (-not (Test-Path node_modules)) {
    Write-Host "-- npm install"
    npm install
    if ($LASTEXITCODE) { throw "npm install failed" }
}

Write-Host "-- tests"
npx tsc --noEmit
if ($LASTEXITCODE) { throw "type check failed" }
npm test
if ($LASTEXITCODE) { throw "frontend tests failed" }
Push-Location src-tauri
try {
    cargo test --lib
    if ($LASTEXITCODE) { throw "backend tests failed" }
} finally {
    Pop-Location
}

# Release binaries must not contain local paths: panic messages of dependencies name their source
# files under the user profile (cargo registry). Remap that prefix. The encoded form keeps a path
# with spaces in one argument.
$env:CARGO_ENCODED_RUSTFLAGS = "--remap-path-prefix=$($env:USERPROFILE)=~"

Write-Host "-- tauri build (release)"
npx tauri build --no-bundle
if ($LASTEXITCODE) { throw "tauri build failed" }

$exe = "src-tauri\target\release\nax-notepad.exe"
if (-not (Test-Path $exe)) { throw "Build did not produce $exe" }
Write-Host "   $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB)"
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$binary = $latin1.GetString([System.IO.File]::ReadAllBytes((Resolve-Path $exe).Path))
foreach ($needle in @($env:USERPROFILE, $env:USERPROFILE.Replace("\", "/"), $env:USERPROFILE.Replace("\", "\\"))) {
    if ($binary.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "$exe contains the local profile path; it must not be published."
    }
}
New-Item -ItemType Directory -Force artifacts | Out-Null

# Portable package: portable.txt next to the program keeps settings, session and the browser
# profile in a "data" folder beside it instead of %APPDATA%.
Write-Host "-- portable zip"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "nax-notepad-portable-$version"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $exe (Join-Path $stage "nax-notepad.exe")
Copy-Item LICENSE, README.md $stage
Set-Content -Path (Join-Path $stage "portable.txt") -Encoding UTF8 -Value @(
    "Nax-Notepad portable mode.",
    "While this file is next to nax-notepad.exe, settings, session and unsaved text are stored in the data folder here.",
    "Delete this file to use %APPDATA%\Nax-Notepad instead."
)
$zip = "artifacts\Nax-Notepad-$version-portable.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Remove-Item -Recurse -Force $stage
Write-Host "   $((Resolve-Path $zip).Path)" -ForegroundColor Green

if ($SkipInstaller) { return }

$iscc = Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 7\ISCC.exe"
if (-not (Test-Path $iscc)) {
    throw "Inno Setup 7 not found at $iscc. Install it with: winget install JRSoftware.InnoSetup.7"
}

Write-Host "-- Inno Setup"
& $iscc "/DAppVersion=$version" "installer\Nax-Notepad.iss"
if ($LASTEXITCODE) { throw "ISCC failed" }
Get-ChildItem artifacts\Nax-Notepad-Setup-*.exe | ForEach-Object { Write-Host "   $($_.FullName)" -ForegroundColor Green }
