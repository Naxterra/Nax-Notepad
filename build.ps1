# Builds Nax-Notepad in release mode and packages it with Inno Setup 7.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1 [-SkipInstaller]
param(
    [switch]$SkipInstaller
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

if (-not (Test-Path node_modules)) {
    Write-Host "-- npm install"
    npm install
    if ($LASTEXITCODE) { throw "npm install failed" }
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
