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

Write-Host "-- tauri build (release)"
npx tauri build --no-bundle
if ($LASTEXITCODE) { throw "tauri build failed" }

$exe = "src-tauri\target\release\nax-notepad.exe"
if (-not (Test-Path $exe)) { throw "Build did not produce $exe" }
Write-Host "   $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB)"

if ($SkipInstaller) { return }

$iscc = Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 7\ISCC.exe"
if (-not (Test-Path $iscc)) {
    throw "Inno Setup 7 not found at $iscc. Install it with: winget install JRSoftware.InnoSetup.7"
}
New-Item -ItemType Directory -Force artifacts | Out-Null
Write-Host "-- Inno Setup"
& $iscc "/DAppVersion=$version" "installer\Nax-Notepad.iss"
if ($LASTEXITCODE) { throw "ISCC failed" }
Get-ChildItem artifacts\Nax-Notepad-Setup-*.exe | ForEach-Object { Write-Host "   $($_.FullName)" -ForegroundColor Green }
