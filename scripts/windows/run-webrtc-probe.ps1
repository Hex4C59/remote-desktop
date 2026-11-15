param(
    [Parameter(Mandatory = $true)][string]$Sender,
    [ValidateSet('pattern', 'desktop')][string]$Source = 'pattern',
    [string]$OutputRoot,
    [ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$DeviceSerial
)
$ErrorActionPreference = 'Stop'
if (-not $OutputRoot) {
    $OutputRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'build\interop'
}
$adbTarget=if ($DeviceSerial) { @('-s',$DeviceSerial) } else { @('-d') }
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
    & adb @adbTarget shell am force-stop $package
    Check-Adb
    # Preserve any previous answer for diagnosis, avoiding stale signaling.
    & adb @adbTarget shell "if [ -f $phoneAnswer ]; then mv $phoneAnswer $phoneAnswer.$runId.previous; fi"
    Check-Adb
    $senderArguments = "`"$offerPath`" `"$answerPath`""
    if ($Source -eq 'desktop') { $senderArguments += ' desktop' }
    $senderProcess = Start-Process -FilePath $Sender -ArgumentList $senderArguments `
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
    & adb @adbTarget shell am start -W -n "$package/.ProbeActivity" --es offer_b64 $offer
    Check-Adb
    $appPid = (& adb @adbTarget shell pidof $package).Trim()
    Check-Adb
    if ($appPid -notmatch '^\d+$') { throw 'No single Android probe process found.' }
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
        $phoneLog = (& adb @adbTarget logcat -d "--pid=$appPid" -s 'RemoteDesktopProbe:I' '*:S') -join "`n"
        Check-Adb
        if ($phoneLog.Contains('answer_ready=true')) { break }
        if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for Android answer.' }
        Start-Sleep -Milliseconds 500
    }
    & adb @adbTarget pull $phoneAnswer (Join-Path $runDirectory 'answer.pending')
    Check-Adb
    Move-Item (Join-Path $runDirectory 'answer.pending') $answerPath
    if ($Source -eq 'desktop') {
        # Screenshots are evidence for visual review, never a substitute for it.
        foreach ($sample in 1..2) {
            Start-Sleep -Seconds 7
            if ($senderProcess.HasExited) { throw 'Sender exited before visual sampling.' }
            $phoneImage = "/sdcard/Android/data/$package/files/desktop-$sample.png"
            & adb @adbTarget shell screencap -p $phoneImage
            Check-Adb
            & adb @adbTarget pull $phoneImage (Join-Path $runDirectory "desktop-$sample.png")
            Check-Adb
        }
    }
    if (!$senderProcess.WaitForExit(60000)) { throw 'Sender did not finish in time.' }
    $senderProcess.Refresh()
    $phoneLog = (& adb @adbTarget logcat -d "--pid=$appPid" -s 'RemoteDesktopProbe:I' '*:S') -join "`n"
    Check-Adb
    [IO.File]::WriteAllText((Join-Path $runDirectory 'android.log'), $phoneLog)
    $rendered = $phoneLog.Contains('first_frame_rendered=true')
    $echoed = $phoneLog.Contains('data_received=echo:probe:1')
    $senderLog = Get-Content (Join-Path $runDirectory 'sender.log') -Raw
    $dimensions = [regex]::Match($senderLog, 'desktop_frame=true[^\r\n]*output_width=(\d+) output_height=(\d+)')
    $desktopObserved = $Source -ne 'desktop' -or (
        $senderLog.Contains('source=desktop') -and $dimensions.Success -and
        $phoneLog.Contains(('frame_size={0}x{1} rotation=' -f $dimensions.Groups[1].Value, $dimensions.Groups[2].Value)))
    $automatedPassed = $senderProcess.ExitCode -eq 0 -and $rendered -and $echoed -and $desktopObserved
    $result = [ordered]@{
        run_id = $runId
        source = $Source
        sender_exit_code = $senderProcess.ExitCode
        first_frame_rendered = $rendered
        echo_received = $echoed
        automated_checks_passed = $automatedPassed
        visual_review = $(if ($Source -eq 'desktop') { 'required: compare desktop changes and terminal text in both screenshots' } else { 'not required for pattern smoke' })
        passed = $(if ($Source -eq 'desktop' -and $automatedPassed) { $null } else { $automatedPassed })
    }
    $result | ConvertTo-Json | Tee-Object -FilePath (Join-Path $runDirectory 'result.json')
    if (!$automatedPassed) { throw 'Interoperability criteria were not met. Inspect run logs.' }
} finally {
    if ($appPid) {
        $diagnosticLog = (& adb @adbTarget logcat -d "--pid=$appPid" -s 'RemoteDesktopProbe:I' '*:S') -join "`n"
        [IO.File]::WriteAllText((Join-Path $runDirectory 'android.log'), $diagnosticLog)
    }
    Write-Output "run_directory=$runDirectory"
    if ($senderProcess -and !$senderProcess.HasExited) { Stop-Process -Id $senderProcess.Id }
    & adb @adbTarget shell am force-stop $package
}
