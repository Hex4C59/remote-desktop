param(
    [Parameter(Mandatory = $true)][string]$Sender,
    [string]$OutputRoot = 'D:\code\remote-desktop\build\interop'
)
$ErrorActionPreference = 'Stop'
$runId = [Guid]::NewGuid().ToString('N')
$runDirectory = Join-Path $OutputRoot $runId
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$offerPath = Join-Path $runDirectory 'offer.sdp'
$answerPath = Join-Path $runDirectory 'answer.sdp'
$package = 'dev.remotedesktop.probe'
$phoneAnswer = "/sdcard/Android/data/$package/files/answer.sdp"
$senderProcess = $null
$appPid = $null
function Check-Adb { if ($LASTEXITCODE -ne 0) { throw "ADB failed: $LASTEXITCODE" } }
try {
    & adb -d shell am force-stop $package
    Check-Adb
    # Preserve any previous answer for diagnosis, avoiding stale signaling.
    & adb -d shell "if [ -f $phoneAnswer ]; then mv $phoneAnswer $phoneAnswer.$runId.previous; fi"
    Check-Adb
    $senderProcess = Start-Process -FilePath $Sender -ArgumentList "`"$offerPath`" `"$answerPath`"" `
        -RedirectStandardOutput (Join-Path $runDirectory 'sender.log') `
        -RedirectStandardError (Join-Path $runDirectory 'sender-error.log') -PassThru
    $null = $senderProcess.Handle
    $deadline = (Get-Date).AddSeconds(90)
    while (!(Test-Path $offerPath)) {
        if ($senderProcess.HasExited) { throw 'Sender exited before writing offer.' }
        if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for offer.' }
        Start-Sleep -Milliseconds 500
    }
    # The producer closes the small SDP file immediately after writing it.
    Start-Sleep -Milliseconds 200
    $offer = [Convert]::ToBase64String([IO.File]::ReadAllBytes($offerPath))
    & adb -d shell am start -W -n "$package/.ProbeActivity" --es offer_b64 $offer
    Check-Adb
    $appPid = (& adb -d shell pidof $package).Trim()
    Check-Adb
    if ($appPid -notmatch '^\d+$') { throw 'No single Android probe process found.' }
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
        $phoneLog = (& adb -d logcat -d "--pid=$appPid" -s 'RemoteDesktopProbe:I' '*:S') -join "`n"
        Check-Adb
        if ($phoneLog.Contains('answer_ready=true')) { break }
        if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for Android answer.' }
        Start-Sleep -Milliseconds 500
    }
    & adb -d pull $phoneAnswer (Join-Path $runDirectory 'answer.pending')
    Check-Adb
    Move-Item (Join-Path $runDirectory 'answer.pending') $answerPath
    if (!$senderProcess.WaitForExit(60000)) { throw 'Sender did not finish in time.' }
    $senderProcess.Refresh()
    $phoneLog = (& adb -d logcat -d "--pid=$appPid" -s 'RemoteDesktopProbe:I' '*:S') -join "`n"
    Check-Adb
    [IO.File]::WriteAllText((Join-Path $runDirectory 'android.log'), $phoneLog)
    $rendered = $phoneLog.Contains('first_frame_rendered=true')
    $echoed = $phoneLog.Contains('data_received=echo:probe:1')
    $result = [ordered]@{
        run_id = $runId
        sender_exit_code = $senderProcess.ExitCode
        first_frame_rendered = $rendered
        echo_received = $echoed
        passed = ($senderProcess.ExitCode -eq 0 -and $rendered -and $echoed)
    }
    $result | ConvertTo-Json | Tee-Object -FilePath (Join-Path $runDirectory 'result.json')
    if (!$result.passed) { throw 'Interoperability criteria were not met. Inspect run logs.' }
} finally {
    if ($appPid) {
        $diagnosticLog = (& adb -d logcat -d "--pid=$appPid" -s 'RemoteDesktopProbe:I' '*:S') -join "`n"
        [IO.File]::WriteAllText((Join-Path $runDirectory 'android.log'), $diagnosticLog)
    }
    Write-Output "run_directory=$runDirectory"
    if ($senderProcess -and !$senderProcess.HasExited) { Stop-Process -Id $senderProcess.Id }
    & adb -d shell am force-stop $package
}
