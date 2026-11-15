param(
    [Parameter(Mandatory=$true)][string]$Address,
    [Parameter(Mandatory=$true)][string]$Sender,
    [string]$OutputRoot,
    [switch]$TextOnly,
    [ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$DeviceSerial
)
# Run in the logged-in interactive Windows session (a scheduled task using
# LogonType Interactive also works), with one USB-authorized Android device.
# ADB operates only the normal UI. The terminal is an independent OS observer.
$ErrorActionPreference = 'Stop'
if (-not $OutputRoot) {
    $OutputRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'build\terminal-tests'
}
$adbTarget=if ($DeviceSerial) { @('-s',$DeviceSerial) } else { @('-d') }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TerminalTestWindows {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    public static IntPtr FindPairing() { return FindWindow("RemoteDesktopPairing",null); }
    public static IntPtr FindCode(IntPtr parent) { return FindWindowEx(parent,IntPtr.Zero,"EDIT",null); }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls,string title);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent,IntPtr after,string cls,string title);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder text,int length);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool SetPhysicalCursorPos(int x,int y);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPhysicalPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
    [DllImport("user32.dll")] public static extern bool IsProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
# Match the fixture's physical coordinate observations on the primary display.
if (![TerminalTestWindows]::IsProcessDPIAware() -and ![TerminalTestWindows]::SetProcessDPIAware()) { throw 'Cannot establish DPI-aware input observation.' }
$run = Join-Path $OutputRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$package = 'dev.remotedesktop.probe'
$senderProcess = $null; $fixtureProcess = $null; $phoneProcess = $null; $geometry = $null; $wrong = $null
$foregroundPid = $null
$script:ownsPhone = $false
function Check-Adb { if ($LASTEXITCODE -ne 0) { throw 'ADB operation failed.' } }
function Read-Ui {
    & adb @adbTarget shell uiautomator dump /sdcard/terminal-ui.xml | Out-Null; Check-Adb
    & adb @adbTarget pull /sdcard/terminal-ui.xml (Join-Path $run 'ui.xml') | Out-Null; Check-Adb
    return [xml][IO.File]::ReadAllText((Join-Path $run 'ui.xml'))
}
function Read-Bounds($node) {
    $values=[regex]::Matches($node.bounds, '-?\d+')
    if ($values.Count -ne 4) { throw 'Android element bounds unavailable.' }
    return @{ left=[int]$values[0].Value; top=[int]$values[1].Value; right=[int]$values[2].Value; bottom=[int]$values[3].Value }
}
function Tap([int]$x,[int]$y) { & adb @adbTarget shell input tap $x $y | Out-Null; Check-Adb }
function Tap-Node($node) {
    $bounds=Read-Bounds $node
    Tap (($bounds.left+$bounds.right)/2) (($bounds.top+$bounds.bottom)/2)
}
function Connect-Phone([string]$credential) {
    $script:ownsPhone = $true
    & adb @adbTarget shell am force-stop $package | Out-Null; Check-Adb
    & adb @adbTarget shell am start -W -n "$package/.ProbeActivity" | Out-Null; Check-Adb
    Start-Sleep -Seconds 1
    $ui=Read-Ui
    $fields=$ui.SelectNodes('//node[@class="android.widget.EditText"]')
    if ($fields.Count -lt 2) { throw 'Expected normal address and pairing-code fields.' }
    Tap-Node $fields[0]
    & adb @adbTarget shell input text $Address | Out-Null; Check-Adb
    & adb @adbTarget shell input keyevent 61 | Out-Null; Check-Adb
    & adb @adbTarget shell input text $credential *> $null; Check-Adb
    & adb @adbTarget shell input keyevent 66 | Out-Null; Check-Adb
    $androidPid=((& adb @adbTarget shell pidof $package) -join '').Trim(); Check-Adb
    if ($androidPid -notmatch '^\d+$') { throw 'Android process missing.' }
    return $androidPid
}
function Read-PhoneLog {
    $lines=(& adb @adbTarget logcat -d "--pid=$phoneProcess" -s 'RemoteDesktopProbe:I' '*:S') -join "`n"; Check-Adb
    if (($code -and $lines.Contains($code)) -or ($wrong -and $lines.Contains($wrong))) { throw 'Pairing credential appeared in application logs.' }
    return $lines
}
function Save-PhoneImage([string]$name) {
    & adb @adbTarget shell screencap -p /sdcard/terminal-desktop.png | Out-Null; Check-Adb
    & adb @adbTarget pull /sdcard/terminal-desktop.png (Join-Path $run "$name.png") | Out-Null; Check-Adb
}
function Find-Control([string]$description) {
    $ui=Read-Ui
    $node=$ui.SelectSingleNode("//node[@content-desc='$description']")
    if (!$node) { throw "Normal Android UI control missing: $description" }
    return $node
}
function Assert-TerminalForeground {
    $foreground=[TerminalTestWindows]::GetForegroundWindow().ToInt64()
    if (!$geometry -or $foreground -ne $geometry.window) {
        [ordered]@{time=(Get-Date).ToString('o');expected_window=$geometry.window;observed_window=$foreground} |
            ConvertTo-Json | Set-Content (Join-Path $run 'foreground-loss.json')
        throw 'Windows terminal lost foreground; no input sent'
    }
}
function Tap-Control([string]$description) {
    $node=Find-Control $description
    $bounds=Read-Bounds $node
    if ($node.enabled -ne 'true' -or $node.clickable -ne 'true' -or
        $bounds.right -le $bounds.left -or $bounds.bottom -le $bounds.top -or
        $node.GetAttribute('visible-to-user') -eq 'false') {
        throw "Normal Android UI control is not enabled and visible: $description"
    }
    $window=$node
    while ($window.ParentNode.Name -eq 'node') { $window=$window.ParentNode }
    $windowBounds=Read-Bounds $window
    if ($bounds.left -lt $windowBounds.left -or $bounds.top -lt $windowBounds.top -or
        $bounds.right -gt $windowBounds.right -or $bounds.bottom -gt $windowBounds.bottom) {
        throw "Normal Android UI control is outside its visible window: $description"
    }
    Assert-TerminalForeground
    Tap-Node $node
}
function Send-AndroidText([string]$value) {
    # Pass the shell command on stdin, preserving embedded double quotes even
    # with Windows PowerShell 5's legacy native argument serialization.
    for ($offset=0; $offset -lt $value.Length; $offset+=64) {
        $chunk=$value.Substring($offset,[Math]::Min(64,$value.Length-$offset))
        $escaped=$chunk.Replace(' ','%s').Replace("'","'\''")
        $start=New-Object Diagnostics.ProcessStartInfo
        $start.FileName='adb'; $start.Arguments=($adbTarget -join ' ')+' shell -T sh'
        $start.UseShellExecute=$false; $start.CreateNoWindow=$true
        $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
        $process=[Diagnostics.Process]::Start($start)
        try {
            $process.StandardInput.WriteLine("input text '$escaped'")
            $process.StandardInput.Close()
            if (!$process.WaitForExit(15000)) { $process.Kill(); throw 'ADB text entry timed out.' }
            if ($process.ExitCode -ne 0) { throw ('ADB text entry failed: '+$process.StandardError.ReadToEnd()) }
        } finally { $process.Dispose() }
        # Give the real IME/UI thread time to consume long hardware key bursts.
        Start-Sleep -Milliseconds 150
    }
}
function Send-TerminalText([string]$value) {
    Assert-TerminalForeground
    if ($value.Length -gt 256 -or $value -match '[^ -~]' -or $value.Contains('%s')) { throw 'Unsupported acceptance text.' }
    Tap-Control 'Terminal text'
    # adb shell interprets this as one POSIX shell command; quote every shell
    # metacharacter and encode spaces for Android input text's normal UI path.
    Send-AndroidText $value
    $draftUi=Read-Ui
    $draft=$draftUi.SelectSingleNode('//node[@content-desc="Terminal text"]')
    if (!$draft -or $draft.enabled -ne 'true') { throw 'Authorized session ended or terminal input became disabled while typing the Android draft.' }
    if ($draft.text -cne $value) { throw 'Android terminal draft differs from the requested printable ASCII text.' }
    $captureDraftLayout = !$script:capturedDraftLayout
    if ($captureDraftLayout) {
        $draftSurface=$draftUi.SelectSingleNode('//node[@content-desc="Remote desktop video" or contains(@class,"SurfaceView")]')
        if (!$draftSurface) { throw 'Desktop disappeared while typing in the Android draft.' }
        $draftBounds=Read-Bounds $draftSurface
        if ($draftBounds.bottom-$draftBounds.top -lt 100) { throw 'Desktop is too small while editing the Android draft.' }
        $draftUi.Save((Join-Path $run 'draft-before-send.xml'))
        Save-PhoneImage 'draft-ime-open'
    }
    # Send must be reachable without using Back to dismiss the real keyboard.
    # Screenshots establish whether an IME was actually visible on this device.
    Tap-Control 'Send text'
    if ($captureDraftLayout) {
        $sentUi=Read-Ui
        $sentUi.Save((Join-Path $run 'draft-after-send.xml'))
        Save-PhoneImage 'draft-after-send'
        $script:capturedDraftLayout=$true
    }
}
function Read-ResultLines { return [IO.File]::ReadAllText((Join-Path $geometry.work_directory 'result-lines.txt')) }
function Wait-Result([string]$value) {
    $deadline=(Get-Date).AddSeconds(12)
    do { Start-Sleep -Milliseconds 200; $observed=Read-ResultLines } until ($observed.Contains($value) -or (Get-Date) -gt $deadline)
    if (!$observed.Contains($value)) { throw "Actual Windows terminal result missing: $value" }
}
function Assert-Released {
    foreach ($key in @(1,8,9,13,16,17,18,37,38,39,40,67)) {
        if (([TerminalTestWindows]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { throw "Windows key $key remains physically pressed." }
    }
}
function Read-ConsoleText {
    if (Test-Path (Join-Path $run 'observer-error.txt')) { throw (Get-Content (Join-Path $run 'observer-error.txt') -Raw) }
    $stream=[IO.File]::Open((Join-Path $run 'console-text.txt'),[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader=New-Object IO.StreamReader($stream)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Assert-NoTerminalInput([string]$scenario,[string]$before) {
    Start-Sleep -Milliseconds 600
    if ((Read-ConsoleText) -cne $before) { throw "$scenario changed the independent Windows console buffer." }
    Assert-Released
}
function Send-Command([string]$command) { Send-TerminalText $command; Tap-Control 'Enter' }
function Wait-File([string]$name) {
    $path=Join-Path $geometry.work_directory $name
    $deadline=(Get-Date).AddSeconds(12)
    while (!(Test-Path $path)) {
        if ((Get-Date) -gt $deadline) { throw "Windows shell did not create $name." }
        Start-Sleep -Milliseconds 200
    }
    return $path
}
try {
    if ([TerminalTestWindows]::FindPairing() -ne [IntPtr]::Zero) { throw 'Close the existing pairing sender before this test.' }
    $fixtureScript=Join-Path $PSScriptRoot 'show-terminal-fixture.ps1'
    $fixtureProcess=Start-Process -FilePath "$env:WINDIR\System32\conhost.exe" -ArgumentList "powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File `"$fixtureScript`" -OutputDirectory `"$run`"" -PassThru
    $deadline=(Get-Date).AddSeconds(20)
    while (!(Test-Path (Join-Path $run 'fixture.json'))) {
        if (Test-Path (Join-Path $run 'fixture-error.txt')) { throw (Get-Content (Join-Path $run 'fixture-error.txt') -Raw) }
        if ((Get-Date) -gt $deadline) { throw 'Dedicated interactive PowerShell terminal did not start.' }
        Start-Sleep -Milliseconds 250
    }
    $geometry=Get-Content (Join-Path $run 'fixture.json') -Raw | ConvertFrom-Json
    $senderProcess=Start-Process -FilePath $Sender -ArgumentList '--serve' -RedirectStandardOutput (Join-Path $run 'sender.log') -RedirectStandardError (Join-Path $run 'sender-error.log') -PassThru
    $null=$senderProcess.Handle
    $deadline=(Get-Date).AddSeconds(20)
    do {
        $window=[TerminalTestWindows]::FindPairing()
        if ($window -ne [IntPtr]::Zero) { break }
        if ($senderProcess.HasExited -or (Get-Date) -gt $deadline) { throw 'Fresh interactive pairing window not found.' }
        Start-Sleep -Milliseconds 200
    } while ($true)
    $edit=[TerminalTestWindows]::FindCode($window)
    $text=New-Object Text.StringBuilder 128
    [void][TerminalTestWindows]::GetWindowText($edit,$text,128)
    $code=$text.ToString()
    if ($code -notmatch '^[A-Za-z0-9_-]{64}$') { throw 'Pairing code unavailable in the normal Windows UI.' }
    if (!$TextOnly) {
        $last=if ($code.EndsWith('A')) { 'B' } else { 'A' }
        $wrong=$code.Substring(0,63)+$last
        $phoneProcess=Connect-Phone $wrong
        $deadline=(Get-Date).AddSeconds(10)
        do { Start-Sleep -Milliseconds 300; $wrongLog=Read-PhoneLog } until ($wrongLog.Contains('pairing_denied=true') -or (Get-Date) -gt $deadline)
        if (!$wrongLog.Contains('pairing_denied=true') -or $wrongLog.Contains('pairing_authorized=true') -or $wrongLog.Contains('first_frame_rendered=true')) { throw 'Incorrect credential was not rejected before desktop access.' }
        $deniedUi=Read-Ui
        if ($deniedUi.SelectSingleNode('//node[@content-desc="Terminal text" and @enabled="true"]')) { throw 'Terminal draft enabled before authorization.' }
        $deniedSurface=$deniedUi.SelectSingleNode('//node[contains(@class,"SurfaceView")]')
        if (!$deniedSurface) { throw 'Unauthenticated desktop surface missing.' }
        $before=Read-ConsoleText
        Tap-Node $deniedSurface
        Send-AndroidText 'UNAUTHORIZED'
        & adb @adbTarget shell input keyevent 66 | Out-Null; Check-Adb
        Assert-NoTerminalInput 'Incorrect pairing credential' $before
        Save-PhoneImage 'wrong-pairing'
        [IO.File]::WriteAllText((Join-Path $run 'wrong-pairing.log'),$wrongLog)
    }
    $phoneProcess=Connect-Phone $code
    $deadline=(Get-Date).AddSeconds(40)
    do { Start-Sleep -Milliseconds 500; $phoneLog=Read-PhoneLog } until (($phoneLog.Contains('first_frame_rendered=true') -and $phoneLog -match 'frame_size=\d+x\d+ rotation=0') -or (Get-Date) -gt $deadline)
    if (!$phoneLog.Contains('first_frame_rendered=true')) { throw 'Authorized desktop was not rendered.' }
    $senderLog=Get-Content (Join-Path $run 'sender.log') -Raw
    $capture=[regex]::Match($senderLog,'desktop_frame=true capture_width=(\d+) capture_height=(\d+)')
    if (!$capture.Success -or [int]$capture.Groups[1].Value -ne $geometry.screen_width -or [int]$capture.Groups[2].Value -ne $geometry.screen_height) { throw 'Fixture requires capture of the primary monitor.' }
    $desktopBounds=[regex]::Match($senderLog,'desktop_bounds left=(-?\d+) top=(-?\d+) width=(\d+) height=(\d+)')
    if (!$desktopBounds.Success -or [int]$desktopBounds.Groups[1].Value -ne 0 -or [int]$desktopBounds.Groups[2].Value -ne 0 -or
        [int]$desktopBounds.Groups[3].Value -ne $geometry.screen_width -or [int]$desktopBounds.Groups[4].Value -ne $geometry.screen_height) {
        throw 'Fixture requires physical input bounds matching the captured primary display at (0,0).'
    }
    Start-Sleep -Seconds 1
    $ui=Read-Ui
    $surface=$ui.SelectSingleNode('//node[@content-desc="Remote desktop video" or contains(@class,"SurfaceView")]')
    if (!$surface) { throw 'Android desktop surface unavailable.' }
    $bounds=Read-Bounds $surface
    $frame=[regex]::Match($phoneLog,'frame_size=(\d+)x(\d+) rotation=0')
    if (!$frame.Success) { throw 'Expected unrotated desktop video.' }
    $scale=[Math]::Min(($bounds.right-$bounds.left)/[double]$frame.Groups[1].Value,($bounds.bottom-$bounds.top)/[double]$frame.Groups[2].Value)
    $videoWidth=[double]$frame.Groups[1].Value*$scale; $videoHeight=[double]$frame.Groups[2].Value*$scale
    $videoLeft=$bounds.left+(($bounds.right-$bounds.left)-$videoWidth)/2
    $videoTop=$bounds.top+(($bounds.bottom-$bounds.top)-$videoHeight)/2
    $targetX=[int]($geometry.left+$geometry.width/3); $targetY=[int]($geometry.top+$geometry.height/2)
    $phoneX=[int]($videoLeft+$targetX/$geometry.screen_width*$videoWidth)
    $phoneY=[int]($videoTop+$targetY/$geometry.screen_height*$videoHeight)
    $testConsole=[TerminalTestWindows]::GetConsoleWindow()
    [void][TerminalTestWindows]::ShowWindow($testConsole,5)
    [void][TerminalTestWindows]::SetForegroundWindow($testConsole)
    Start-Sleep -Milliseconds 300
    if ([TerminalTestWindows]::GetForegroundWindow().ToInt64() -eq $geometry.window) { throw 'Could not defocus terminal before remote tap.' }
    $target=New-Object TerminalTestWindows+Point; $target.X=$targetX; $target.Y=$targetY
    $targetWindow=[TerminalTestWindows]::GetAncestor([TerminalTestWindows]::WindowFromPhysicalPoint($target),2).ToInt64()
    if ($targetWindow -ne $geometry.window) { throw 'Terminal is obscured at target; no input was sent.' }
    Save-PhoneImage 'before-focus'
    Tap $phoneX $phoneY
    Start-Sleep -Seconds 1
    if ([TerminalTestWindows]::GetForegroundWindow().ToInt64() -ne $geometry.window) { throw 'Android touch did not focus the real Windows terminal.' }
    Save-PhoneImage 'after-focus'
    $known=-join [char[]](32..126)
    $quoted=$known.Replace("'","''")
    $command="'$quoted' | Tee-Object -FilePath result-lines.txt"
    Send-TerminalText $command
    Save-PhoneImage 'text-before-enter'
    if ((Read-ResultLines).Length -ne 0) { throw 'Text send unexpectedly executed a command before Enter.' }
    Tap-Control 'Enter'
    Wait-Result $known
    if ((Read-ResultLines) -cne ($known+"`r`n")) { throw 'Windows shell result does not exactly match all 95 printable ASCII characters.' }
    Assert-Released
    Save-PhoneImage 'text-executed'
    $result=[ordered]@{text_ascii_exact=$true;ascii_character_count=95;enter_executed=$true;remote_touch_focused=$true;keys_released=$true;known_text=$known;psreadline=$geometry.psreadline;run_directory=$run;visual_review='required: inspect draft-ime-open and draft-after-send for actual IME visibility, draft/Send reachability and restored keys; inspect text-executed for remote output'}
    if (!$TextOnly) {
        Send-TerminalText 'Get-Content .\task04_comp'
        Tap-Control 'Tab'
        Send-TerminalText ' | Tee-Object -FilePath tab-result.txt'
        Tap-Control 'Enter'
        $tabFile=Wait-File 'tab-result.txt'
        if ([IO.File]::ReadAllText($tabFile).Trim() -cne 'TAB_COMPLETED') { throw 'Tab did not complete the unique real filename.' }
        Assert-Released
        Save-PhoneImage 'tab-completed'

        Send-TerminalText "Add-Content result-lines.txt 'EDIT_XY'"
        Tap-Control 'Left'; Tap-Control 'Left'; Tap-Control 'Backspace'
        Send-TerminalText 'Z'
        Tap-Control 'Right'
        Send-TerminalText 'Q'
        Tap-Control 'Enter'
        Wait-Result 'EDIT_ZYQ'
        Assert-Released
        Save-PhoneImage 'arrows-edited'

        Send-Command "Add-Content result-lines.txt 'HISTORY_A'"
        Wait-Result 'HISTORY_A'
        Send-Command "Add-Content result-lines.txt 'HISTORY_B'"
        Wait-Result 'HISTORY_B'
        Tap-Control 'Up'; Tap-Control 'Up'; Tap-Control 'Down'; Tap-Control 'Enter'
        $historyExpected=$known+"`r`nEDIT_ZYQ`r`nHISTORY_A`r`nHISTORY_B`r`nHISTORY_B`r`n"
        $deadline=(Get-Date).AddSeconds(12)
        do { Start-Sleep -Milliseconds 200; $lines=Read-ResultLines } until ($lines -ceq $historyExpected -or (Get-Date) -gt $deadline)
        if ($lines -cne $historyExpected) { throw 'Up/Down did not select and execute the expected history entry.' }
        Assert-Released
        Save-PhoneImage 'history-selected'

        Send-Command 'powershell.exe -NoProfile -File .\foreground.ps1'
        $null=Wait-File 'foreground-started.txt'
        $foregroundPid=[int][IO.File]::ReadAllText((Wait-File 'foreground-pid.txt'))
        if (!(Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue)) { throw 'Foreground process ended before Ctrl+C.' }
        Save-PhoneImage 'foreground-running'
        Tap-Control 'Ctrl+C'
        $deadline=(Get-Date).AddSeconds(12)
        while (Get-Process -Id $foregroundPid -ErrorAction SilentlyContinue) {
            if ((Get-Date) -gt $deadline) { throw 'Ctrl+C did not stop the foreground process.' }
            Start-Sleep -Milliseconds 200
        }
        if (Test-Path (Join-Path $geometry.work_directory 'foreground-finished.txt')) { throw 'Foreground process ran to completion instead of being interrupted.' }
        Assert-Released
        Send-Command "Write-Output 'AFTER_CTRL_C'; Add-Content result-lines.txt 'AFTER_CTRL_C'"
        Wait-Result 'AFTER_CTRL_C'
        Assert-Released
        Save-PhoneImage 'ctrl-c-recovered'

        $before=Read-ConsoleText
        $staleDraft=Find-Control 'Terminal text'
        $staleSend=Find-Control 'Send text'
        $staleEnter=Find-Control 'Enter'
        & adb @adbTarget shell input keyevent 3 | Out-Null; Check-Adb
        Start-Sleep -Seconds 1
        $phoneLog=Read-PhoneLog
        if (!$phoneLog.Contains('activity_stopped=true') -or !$senderProcess.WaitForExit(10000)) { throw 'Backgrounding did not end the authorized session.' }
        $senderProcess.Refresh()
        if ($senderProcess.ExitCode -ne 0) { throw 'Sender did not end cleanly after backgrounding.' }
        Assert-NoTerminalInput 'Background session end' $before
        & adb @adbTarget shell am start -W -n "$package/.ProbeActivity" | Out-Null; Check-Adb
        $remainingProcess=((& adb @adbTarget shell pidof $package) -join '').Trim(); Check-Adb
        if ($remainingProcess -ne $phoneProcess) { throw 'Android process did not survive session cleanup.' }
        Tap-Node $staleDraft
        Send-AndroidText 'STALE_INPUT'
        Tap-Node $staleSend
        Tap-Node $staleEnter
        Assert-NoTerminalInput 'Stale foreground view' $before
        Save-PhoneImage 'stale-view'
        $crashes=(& adb @adbTarget logcat -d "--pid=$phoneProcess" -s 'AndroidRuntime:E' '*:S') -join "`n"; Check-Adb
        if ($crashes.Contains('FATAL EXCEPTION')) { throw 'Android crashed during terminal session cleanup.' }
        $result.tab_completed=$true; $result.left_right_backspace_edited=$true; $result.up_down_history=$true
        $result.ctrl_c_interrupted_foreground=$true; $result.command_after_ctrl_c=$true
        $result.wrong_pairing_no_video_or_input=$true; $result.background_session_ended=$true
        $result.stale_view_no_input=$true; $result.android_process_survived=$true
        $result.final_result_lines=Read-ResultLines
    }
    $result | ConvertTo-Json | Tee-Object -FilePath (Join-Path $run 'result.json')
} finally {
    if ($phoneProcess) {
        try { [IO.File]::WriteAllText((Join-Path $run 'android.log'),(Read-PhoneLog)); Save-PhoneImage 'final-state' }
        catch { Write-Warning 'Could not collect final Android evidence.' }
    }
    if ($script:ownsPhone) { & adb @adbTarget shell am force-stop $package | Out-Null }
    if ($senderProcess -and !$senderProcess.HasExited) { Stop-Process -Id $senderProcess.Id }
    if ($foregroundPid) { Stop-Process -Id $foregroundPid -ErrorAction SilentlyContinue }
    if ($geometry) { Stop-Process -Id $geometry.pid -ErrorAction SilentlyContinue }
    if ($fixtureProcess -and !$fixtureProcess.WaitForExit(3000)) { Stop-Process -Id $fixtureProcess.Id -ErrorAction SilentlyContinue }
    $code=$null; $wrong=$null
    Write-Output "run_directory=$run"
}
