# Build release\ToDoList into a single exe
#   powershell -ExecutionPolicy Bypass -File packaging\single-exe\build.ps1
#
# Output: release\ToDoList.exe
# Requires: built-in tar and csc (.NET Framework 4.x)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$release = Join-Path $root "..\release\ToDoList"
$work = $PSScriptRoot
$payload = Join-Path $work "payload.zip"
$exe = Join-Path $root "..\release\ToDoList.exe"

if (-not (Test-Path (Join-Path $release "node.exe"))) {
    throw "Missing $release - run: node scripts/package-portable.mjs"
}

# sync latest launcher
Copy-Item (Join-Path $root "packaging\launcher\launch.mjs") (Join-Path $release "launcher\launch.mjs") -Force
Copy-Item (Join-Path $root "packaging\launcher\data-root.mjs") (Join-Path $release "launcher\data-root.mjs") -Force
Copy-Item (Join-Path $root "packaging\launcher\launcher-data-flow.mjs") (Join-Path $release "launcher\launcher-data-flow.mjs") -Force

# Refresh app/dist and app/dist-server from the repo first. Without this the
# exe keeps shipping whatever build happened to be copied into release last
# time, and UI fixes silently never reach the installer.
$appDir = Join-Path $release "app"
foreach ($name in @("dist", "dist-server", "licenses")) {
    $target = Join-Path $appDir $name
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Copy-Item (Join-Path $root $name) $target -Recurse -Force
}
foreach ($file in @("package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md")) {
    $source = Join-Path $root $file
    if (Test-Path $source) { Copy-Item $source (Join-Path $appDir $file) -Force }
}
Write-Host "refreshed app/dist and app/dist-server from the repo"

Write-Host "Packing payload.zip (excluding runtime data) ..."
if (Test-Path $payload) { Remove-Item $payload -Force }
& tar -a -c -f $payload -C $release --exclude "ToDoList-data" --exclude "*.log" .
if (-not (Test-Path $payload)) { throw "tar failed" }

# 安全闸：安装包里绝不能出现数据库/配置
$leak = & tar -tf $payload | Select-String -Pattern "app\.sqlite|ToDoList-data/config\.json"
if ($leak) { throw "payload contains runtime data: $leak" }
$payloadMb = [math]::Round((Get-Item $payload).Length / 1MB, 1)
Write-Host "payload ready: $payloadMb MB"

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found" }

Write-Host "Compiling single exe (large resource, may take minutes) ..."
if (Test-Path $exe) { Remove-Item $exe -Force }
& $csc /nologo /target:exe /platform:anycpu /optimize+ `
    "/out:$exe" `
    "/resource:$payload,payload.zip" `
    /r:System.IO.Compression.dll `
    /r:System.IO.Compression.FileSystem.dll `
    (Join-Path $work "Launcher.cs")
if ($LASTEXITCODE -ne 0) { throw "csc failed (exit $LASTEXITCODE)" }

$exeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ""
Write-Host "Done: $exe"
Write-Host "Size: $exeMb MB"
