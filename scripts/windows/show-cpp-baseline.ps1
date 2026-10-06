param([Parameter(Mandatory=$true)][string]$OutputDirectory)
# Dot-source in a fresh, logged-in classic PowerShell console. Ordinary remote
# text/key actions invoke these commands; this script does not inject input.
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BaselineDesktop {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
function global:Assert-BaselineForeground {
    if ([BaselineDesktop]::GetConsoleWindow() -eq [IntPtr]::Zero -or
        [BaselineDesktop]::GetConsoleWindow() -ne [BaselineDesktop]::GetForegroundWindow()) {
        throw 'The classic workload console must remain in the foreground.'
    }
}
Assert-BaselineForeground
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a fresh workload directory.' }
if (Get-Variable BaselineWorkload -Scope Global -ErrorAction SilentlyContinue) { throw 'Use a fresh console.' }
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'MSVC installation not found.' }
$dev=Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
$environment=& cmd.exe /s /c "`"`"$dev`" -no_logo -arch=x64 >nul && set`""
if ($LASTEXITCODE -ne 0) { throw 'Compiler environment initialization failed.' }
foreach ($line in $environment) {
    $pair=$line -split '=',2
    if ($pair.Length -eq 2 -and $pair[0] -in @('PATH','INCLUDE','LIB','LIBPATH')) {
        [Environment]::SetEnvironmentVariable($pair[0],$pair[1],'Process')
    }
}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$global:BaselineWorkload=@{Directory=[IO.Path]::GetFullPath($OutputDirectory);Cycle=0}
Set-Location -LiteralPath $global:BaselineWorkload.Directory
@'
#include <chrono>
#include <iostream>
#include <thread>
constexpr int revision = 0;
int main() {
  for (int tick = 0;; ++tick) {
    std::cout << "revision=" << revision << " tick=" << tick << std::endl;
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
}
'@ | Set-Content -LiteralPath 'sample.cpp' -Encoding ASCII
function global:Write-BaselineAudit([string]$Event,[int]$ExitCode=0) {
    [ordered]@{event=$Event;cycle=$global:BaselineWorkload.Cycle;exit_code=$ExitCode;
        observed_utc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress |
        Add-Content -LiteralPath (Join-Path $global:BaselineWorkload.Directory 'workload.jsonl') -Encoding UTF8
}
function global:browse_demo {
    Assert-BaselineForeground
    if ($global:BaselineWorkload.Cycle -ge 5) { throw 'Five cycles already started.' }
    $global:BaselineWorkload.Cycle++
    Write-BaselineAudit 'browsed'
    Get-ChildItem
}
function global:edit_demo([int]$Cycle) {
    Assert-BaselineForeground
    if ($Cycle -ne $global:BaselineWorkload.Cycle -or $Cycle -gt 5) { throw 'Unexpected workload cycle.' }
    $global:BaselineWorkload.Cycle=$Cycle
    (Get-Content -LiteralPath 'sample.cpp') -replace 'constexpr int revision = \d+;',"constexpr int revision = $Cycle;" |
        Set-Content -LiteralPath 'sample.cpp' -Encoding ASCII
    Write-BaselineAudit 'edited'
    Get-Content -LiteralPath 'sample.cpp'
}
function global:compile_demo {
    Assert-BaselineForeground
    Write-BaselineAudit 'compile_started'
    & cl.exe /nologo /EHsc /Fe:sample.exe sample.cpp
    $code=$LASTEXITCODE
    Write-BaselineAudit 'compile_finished' $code
    if ($code -ne 0) { throw 'Compilation failed; retain this attempt.' }
}
function global:run_demo {
    Assert-BaselineForeground
    Write-BaselineAudit 'run_started'
    try { & .\sample.exe }
    finally { Write-BaselineAudit 'run_returned' $LASTEXITCODE }
}
Write-BaselineAudit 'prepared'
Write-Host 'Ready. Use the controller to run browse_demo, edit_demo N, compile_demo, run_demo, and Ctrl+C.'
