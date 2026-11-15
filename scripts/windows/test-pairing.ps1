param(
    [Parameter(Mandatory=$true)][string]$Address,
    [string]$OutputRoot,
    [ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$DeviceSerial
)
# Run on the interactive Windows desktop with a fresh sender --serve already
# running. ADB drives normal visible fields; no SDP or credential Intent extras.
$ErrorActionPreference = 'Stop'
if (-not $OutputRoot) {
    $OutputRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'build\pairing-tests'
}
$adbTarget=if ($DeviceSerial) { @('-s',$DeviceSerial) } else { @('-d') }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PairingTestWindow {
    public static IntPtr FindPairing() { return FindWindow("RemoteDesktopPairing", null); }
    public static IntPtr FindCode(IntPtr parent) { return FindWindowEx(parent, IntPtr.Zero, "EDIT", null); }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
}
'@
$run = Join-Path $OutputRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$deadline=(Get-Date).AddSeconds(15)
do {
    $window = [PairingTestWindow]::FindPairing()
    if ($window -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
$edit = [PairingTestWindow]::FindCode($window)
$text = New-Object Text.StringBuilder 128
[void][PairingTestWindow]::GetWindowText($edit, $text, 128)
$code = $text.ToString()
if ($code -notmatch '^[A-Za-z0-9_-]{64}$') { throw 'Fresh interactive pairing window not found.' }
$package='dev.remotedesktop.probe'
function Adb-Check { if ($LASTEXITCODE -ne 0) { throw 'ADB operation failed.' } }
function Read-Ui {
    & adb @adbTarget shell uiautomator dump /sdcard/pairing-ui.xml | Out-Null
    Adb-Check
    & adb @adbTarget pull /sdcard/pairing-ui.xml (Join-Path $run "ui.xml") | Out-Null
    Adb-Check
    try { return [xml][IO.File]::ReadAllText((Join-Path $run "ui.xml")) }
    catch { throw "Could not parse Android UI hierarchy." }
}
function Tap-Node($node) {
    $bounds = [regex]::Matches($node.bounds, '\d+')
    $x=([int]$bounds[0].Value+[int]$bounds[2].Value)/2
    $y=([int]$bounds[1].Value+[int]$bounds[3].Value)/2
    & adb @adbTarget shell input tap ([int]$x) ([int]$y) | Out-Null
    Adb-Check
}
function Connect-Phone([string]$credential) {
    & adb @adbTarget shell am force-stop $package
    & adb @adbTarget shell am start -W -n "$package/.ProbeActivity" | Out-Null
    Adb-Check
    Start-Sleep -Seconds 1
    $ui=Read-Ui
    $fields=$ui.SelectNodes('//node[@class="android.widget.EditText"]')
    if ($fields.Count -ne 2) { throw 'Expected address and pairing-code fields.' }
    Tap-Node $fields[0]
    & adb @adbTarget shell input text $Address
    & adb @adbTarget shell input keyevent 61
    & adb @adbTarget shell input text $credential *> $null
    Adb-Check
    & adb @adbTarget shell input keyevent 66
    $phoneProcess = (& adb @adbTarget shell pidof $package).Trim()
    Adb-Check
    if ($phoneProcess -notmatch '^\d+$') { throw 'Android process missing.' }
    return $phoneProcess
}
function Read-Log([string]$phoneProcess) {
    return ((& adb @adbTarget logcat -d "--pid=$phoneProcess" -s 'RemoteDesktopProbe:I' '*:S') -join "`n")
}
try {
    $first = if ($code.StartsWith('A')) {'B'} else {'A'}
    $badIdentity = $first + $code.Substring(1)
    $phoneProcess=Connect-Phone $badIdentity
    Start-Sleep -Seconds 6
    $identityLog=Read-Log $phoneProcess
    [IO.File]::WriteAllText((Join-Path $run 'wrong-identity.log'),$identityLog)
    if (!$identityLog.Contains('pairing_attempt_started=true') -or !$identityLog.Contains('pairing_transport_closed=true') -or $identityLog.Contains('pairing_authorized=true') -or $identityLog.Contains('first_frame_rendered=true')) { throw 'Identity mismatch rejection was not observed.' }
    $last = if ($code.EndsWith('A')) {'B'} else {'A'}
    $wrong=$code.Substring(0,63)+$last
    $phoneProcess=Connect-Phone $wrong
    Start-Sleep -Seconds 5
    $wrongLog=Read-Log $phoneProcess
    [IO.File]::WriteAllText((Join-Path $run 'wrong-code.log'),$wrongLog)
    if ($wrongLog.Contains('first_frame_rendered=true') -or $wrongLog.Contains('pairing_authorized=true') -or !$wrongLog.Contains('pairing_denied=true')) {
        throw 'Wrong-code rejection was not observed.'
    }
    $phoneProcess=Connect-Phone $code
    $deadline=(Get-Date).AddSeconds(35)
    do {
        Start-Sleep -Seconds 1
        $phoneLog=Read-Log $phoneProcess
    } until ($phoneLog.Contains('first_frame_rendered=true') -or (Get-Date) -gt $deadline)
    if (!$phoneLog.Contains('first_frame_rendered=true') -or !$phoneLog.Contains('data_received=echo:probe:1')) { throw 'Authorized desktop not rendered.' }
    foreach ($sample in 1..2) {
        Start-Sleep -Seconds 3
        & adb @adbTarget shell screencap -p /sdcard/pairing-desktop.png
        & adb @adbTarget pull /sdcard/pairing-desktop.png (Join-Path $run "desktop-$sample.png") | Out-Null
        Adb-Check
    }
    # Independent second control connection using the same valid code; it must
    # receive busy, never another offer. Validate the pinned TLS identity too.
    $raw=[Convert]::FromBase64String($code.Replace('-','+').Replace('_','/'))
    $expected=[BitConverter]::ToString($raw[0..31])
    $validation = {
        param($sender,$cert,$chain,$errors)
        $sha=[Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($sha.ComputeHash($cert.GetRawCertData())) -eq $expected }
        finally { $sha.Dispose() }
    }.GetNewClosure()
    $tcp=New-Object Net.Sockets.TcpClient
    $tcp.Connect('127.0.0.1',18443)
    $ssl=New-Object Net.Security.SslStream($tcp.GetStream(),$false,$validation)
    try {
        $ssl.ReadTimeout=5000; $ssl.WriteTimeout=5000
        $ssl.AuthenticateAsClient('remote-desktop')
        $header=New-Object byte[] 4
        for ($offset=0; $offset -lt 4;) {
            $count=$ssl.Read($header,$offset,4-$offset)
            if (!$count) { throw 'Second connection closed without status.' }; $offset+=$count
        }
        [Array]::Reverse($header)
        $length=[BitConverter]::ToInt32($header,0)
        if ($length -ne 4) { throw 'Second connection was not rejected as busy.' }
        $body=New-Object byte[] 4
        for ($offset=0; $offset -lt 4;) {
            $count=$ssl.Read($body,$offset,4-$offset)
            if (!$count) { throw 'Incomplete busy response.' }; $offset+=$count
        }
        if ([Text.Encoding]::UTF8.GetString($body) -ne 'busy') { throw 'Unexpected second-connection response.' }
    } finally { $ssl.Dispose(); $tcp.Dispose() }
    # Background the Activity while its TLS reader observes the close. Both
    # termination paths must be safe and leave the Android process uncrashed.
    & adb @adbTarget shell input keyevent 3
    Start-Sleep -Seconds 2
    $phoneLog=Read-Log $phoneProcess
    $crashes=(& adb @adbTarget logcat -d "--pid=$phoneProcess" -s 'AndroidRuntime:E' '*:S') -join "`n"
    $remainingProcess=((& adb @adbTarget shell pidof $package) -join '').Trim()
    if ($remainingProcess -ne $phoneProcess -or !$phoneLog.Contains('activity_stopped=true') -or $crashes.Contains('FATAL EXCEPTION')) { throw 'Background/disconnect cleanup failed.' }
    [IO.File]::WriteAllText((Join-Path $run 'android.log'),$phoneLog)
    if ($phoneLog.Contains($code) -or $wrongLog.Contains($code) -or $wrongLog.Contains($wrong) -or $identityLog.Contains($badIdentity)) { throw 'Credential appeared in application log.' }
    [ordered]@{ wrong_identity_rejected=$true; wrong_code_rejected=$true; authorized_video_rendered=$true; echo_received=$true; second_connection_rejected=$true; background_disconnect_no_java_crash=$true; background_process_survived=$true; plaintext_code_in_app_log=$false; visual_review='required'; run_directory=$run } | ConvertTo-Json | Tee-Object -FilePath (Join-Path $run 'result.json')
} finally {
    if ($phoneProcess) { [IO.File]::WriteAllText((Join-Path $run 'android-final.log'), (Read-Log $phoneProcess)) }
    & adb @adbTarget shell am force-stop $package
    $code=$null; $wrong=$null
    Write-Output "run_directory=$run"
}
