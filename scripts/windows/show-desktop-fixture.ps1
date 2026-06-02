param([ValidateRange(20, 180)][int]$DurationSeconds = 60)
# Run in an interactive PowerShell window, enlarge its font and keep it visible.
# This only prints local command results; no remote input is injected.
$ErrorActionPreference = 'Stop'
Write-Host 'WINDOWS DESKTOP - LIVE POWERSHELL'
Write-Host 'PS> 6 * 7'
Write-Host (6 * 7)
Write-Host 'Readable: AaZz 0123456789 ./_-+=[]{}'
for ($frame = 0; $frame -lt $DurationSeconds; $frame++) {
    Write-Host ('desktop test {0:D4} : 6 * 7 = {1}' -f $frame, (6 * 7))
    Start-Sleep -Seconds 1
}
