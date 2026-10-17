param(
 [Parameter(Mandatory=$true)][string]$Compiler,
 [Parameter(Mandatory=$true)][string]$WinDivertDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\..\tools\network-shaper'
if(Test-Path $OutputDirectory){throw 'Use a fresh owned build directory'}
New-Item -ItemType Directory $OutputDirectory | Out-Null
& $Compiler /nologo /std:c++20 /EHsc /W4 /WX /utf-8 /I "$WinDivertDirectory\include" "$source\main.cpp" /Fe:"$OutputDirectory\network-shaper.exe" /Fo:"$OutputDirectory\network-shaper.obj" /link "$WinDivertDirectory\x64\WinDivert.lib" ws2_32.lib
if($LASTEXITCODE -ne 0){throw "Shaper build failed: $LASTEXITCODE"}
& $Compiler /nologo /std:c++20 /EHsc /W4 /WX /utf-8 "$source\test_scheduler.cpp" /Fe:"$OutputDirectory\test-scheduler.exe" /Fo:"$OutputDirectory\test-scheduler.obj"
if($LASTEXITCODE -ne 0){throw "Scheduler test build failed: $LASTEXITCODE"}
& "$OutputDirectory\test-scheduler.exe"
if($LASTEXITCODE -ne 0){throw 'Scheduler tests failed'}
Copy-Item "$WinDivertDirectory\x64\WinDivert.dll","$WinDivertDirectory\x64\WinDivert64.sys" $OutputDirectory
Get-FileHash "$OutputDirectory\network-shaper.exe","$OutputDirectory\WinDivert.dll","$OutputDirectory\WinDivert64.sys" -Algorithm SHA256 | ConvertTo-Json
