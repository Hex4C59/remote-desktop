param(
    [string]$SourceRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

$buildDirectory = Join-Path $SourceRoot 'build\windows-probe'
$executable = Join-Path $buildDirectory 'Release\windows_desktop_probe.exe'
$logPath = Join-Path $buildDirectory 'interactive-probe.log'
if (-not (Test-Path $executable)) { throw 'Build windows_desktop_probe first.' }

# Keep native stderr in the log even when the probe returns a failure code.
$ErrorActionPreference = 'Continue'
& $executable --capture 2>&1 | Tee-Object -FilePath $logPath
$probeExitCode = $LASTEXITCODE
"exit_code=$probeExitCode" | Tee-Object -FilePath $logPath -Append
Write-Output "Log saved: $logPath"
exit $probeExitCode
