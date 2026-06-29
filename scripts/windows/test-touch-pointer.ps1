param(
    [Parameter(Mandatory=$true)][string]$Address,
    [Parameter(Mandatory=$true)][string]$Sender,
    [string]$OutputRoot = 'D:\code\remote-desktop\build\touch-tests',
    [ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$DeviceSerial
)
# Run in the logged-in interactive Windows session (a scheduled task using
# LogonType Interactive also works), with one USB-authorized Android device.
# ADB operates only the normal UI. The terminal is an independent OS observer.
$ErrorActionPreference = 'Stop'
$adbTarget=if ($DeviceSerial) { @('-s',$DeviceSerial) } else { @('-d') }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TouchTestWindows {
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
if (![TouchTestWindows]::IsProcessDPIAware() -and ![TouchTestWindows]::SetProcessDPIAware()) { throw 'Cannot establish DPI-aware input observation.' }
$run = Join-Path $OutputRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$package = 'dev.remotedesktop.probe'
$senderProcess = $null; $fixtureProcess = $null; $phoneProcess = $null; $geometry = $null; $wrong = $null
$script:ownsPhone = $false
function Check-Adb { if ($LASTEXITCODE -ne 0) { throw 'ADB operation failed.' } }
function Read-Ui {
    & adb @adbTarget shell uiautomator dump /sdcard/touch-ui.xml | Out-Null; Check-Adb
    & adb @adbTarget pull /sdcard/touch-ui.xml (Join-Path $run 'ui.xml') | Out-Null; Check-Adb
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
    if ($fields.Count -ne 2) { throw 'Expected normal address and pairing-code fields.' }
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
    & adb @adbTarget shell screencap -p /sdcard/touch-desktop.png | Out-Null; Check-Adb
    & adb @adbTarget pull /sdcard/touch-desktop.png (Join-Path $run "$name.png") | Out-Null; Check-Adb
}
function Read-ConsoleEvents { return @(Import-Csv (Join-Path $run 'console-events.csv')) }
function Assert-NoInput([string]$scenario,[int]$expectedEvents,[int]$expectedX,[int]$expectedY) {
    Start-Sleep -Milliseconds 500
    $position=New-Object TouchTestWindows+Point
    [void][TouchTestWindows]::GetPhysicalCursorPos([ref]$position)
    $observed=Read-ConsoleEvents
    if ($observed.Count -ne $expectedEvents -or $position.X -ne $expectedX -or $position.Y -ne $expectedY -or ([TouchTestWindows]::GetAsyncKeyState(1) -band 0x8000) -ne 0) {
        throw "$scenario produced unexpected Windows input: events=$($observed.Count), cursor=$($position.X),$($position.Y)."
    }
}
try {
    if ([TouchTestWindows]::FindPairing() -ne [IntPtr]::Zero) {
        throw 'Close the existing pairing sender before running this test; it must own a fresh sender.'
    }
    $fixtureScript=Join-Path $PSScriptRoot 'show-pointer-fixture.ps1'
    $fixtureProcess=Start-Process -FilePath "$env:WINDIR\System32\conhost.exe" -ArgumentList "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$fixtureScript`" -OutputDirectory `"$run`"" -PassThru
    $deadline=(Get-Date).AddSeconds(20)
    while (!(Test-Path (Join-Path $run 'fixture.json'))) {
        if (Test-Path (Join-Path $run 'fixture-error.txt')) { throw (Get-Content (Join-Path $run 'fixture-error.txt') -Raw) }
        if ((Get-Date) -gt $deadline) { throw 'Dedicated Windows terminal fixture did not start.' }
        Start-Sleep -Milliseconds 250
    }
    $geometry=Get-Content (Join-Path $run 'fixture.json') -Raw | ConvertFrom-Json
    $senderProcess=Start-Process -FilePath $Sender -ArgumentList '--serve' -RedirectStandardOutput (Join-Path $run 'sender.log') -RedirectStandardError (Join-Path $run 'sender-error.log') -PassThru
    $null=$senderProcess.Handle
    $deadline=(Get-Date).AddSeconds(20)
    do {
        $window=[TouchTestWindows]::FindPairing()
        if ($window -ne [IntPtr]::Zero) { break }
        if ($senderProcess.HasExited -or (Get-Date) -gt $deadline) { throw 'Fresh interactive pairing window not found.' }
        Start-Sleep -Milliseconds 200
    } while ($true)
    $edit=[TouchTestWindows]::FindCode($window)
    $text=New-Object Text.StringBuilder 128
    [void][TouchTestWindows]::GetWindowText($edit,$text,128)
    $code=$text.ToString()
    if ($code -notmatch '^[A-Za-z0-9_-]{64}$') { throw 'Pairing code was not available in the normal Windows UI.' }
    # Keep the pinned identity intact but change the authorization secret.
    $last=if ($code.EndsWith('A')) { 'B' } else { 'A' }
    $wrong=$code.Substring(0,63)+$last
    [void][TouchTestWindows]::SetPhysicalCursorPos(5,5)
    $phoneProcess=Connect-Phone $wrong
    $deadline=(Get-Date).AddSeconds(10)
    do { Start-Sleep -Milliseconds 300; $wrongLog=Read-PhoneLog } until ($wrongLog.Contains('pairing_denied=true') -or (Get-Date) -gt $deadline)
    if (!$wrongLog.Contains('pairing_denied=true') -or $wrongLog.Contains('pairing_authorized=true') -or $wrongLog.Contains('first_frame_rendered=true')) {
        throw 'Incorrect pairing credential was not rejected before desktop access.'
    }
    $deniedUi=Read-Ui
    $deniedSurface=$deniedUi.SelectSingleNode('//node[contains(@class,"SurfaceView")]')
    if (!$deniedSurface) { throw 'Could not locate the unauthenticated desktop surface for the rejection experiment.' }
    Tap-Node $deniedSurface
    Assert-NoInput 'Incorrect pairing credential' 0 5 5
    Save-PhoneImage 'wrong-pairing'
    [IO.File]::WriteAllText((Join-Path $run 'wrong-pairing.log'),$wrongLog)
    $phoneProcess=Connect-Phone $code
    $deadline=(Get-Date).AddSeconds(40)
    do {
        Start-Sleep -Milliseconds 500
        $phoneLog=Read-PhoneLog
    } until (($phoneLog.Contains('first_frame_rendered=true') -and $phoneLog -match 'frame_size=\d+x\d+ rotation=0') -or (Get-Date) -gt $deadline)
    if (!$phoneLog.Contains('first_frame_rendered=true')) { throw 'Authorized desktop was not rendered.' }
    $senderLog=Get-Content (Join-Path $run 'sender.log') -Raw
    $capture=[regex]::Match($senderLog,'desktop_frame=true capture_width=(\d+) capture_height=(\d+)')
    if (!$capture.Success -or [int]$capture.Groups[1].Value -ne $geometry.screen_width -or [int]$capture.Groups[2].Value -ne $geometry.screen_height) {
        throw 'This fixture requires the captured monitor to be the primary display.'
    }
    $desktopBounds=[regex]::Match($senderLog,'desktop_bounds left=(-?\d+) top=(-?\d+) width=(\d+) height=(\d+)')
    if (!$desktopBounds.Success -or [int]$desktopBounds.Groups[1].Value -ne 0 -or [int]$desktopBounds.Groups[2].Value -ne 0 -or
        [int]$desktopBounds.Groups[3].Value -ne $geometry.screen_width -or [int]$desktopBounds.Groups[4].Value -ne $geometry.screen_height) {
        throw 'This fixture requires physical input bounds matching the captured primary display at (0,0).'
    }
    Start-Sleep -Seconds 1
    $ui=Read-Ui
    $surface=$ui.SelectSingleNode('//node[@content-desc="Remote desktop video" or contains(@class,"SurfaceView")]')
    if (!$surface) { throw 'Desktop video surface was not exposed by Android UI automation.' }
    $bounds=Read-Bounds $surface
    $frame=[regex]::Match($phoneLog,'frame_size=(\d+)x(\d+) rotation=0')
    if (!$frame.Success) { throw 'Expected unrotated desktop frame.' }
    $scale=[Math]::Min(($bounds.right-$bounds.left)/[double]$frame.Groups[1].Value,($bounds.bottom-$bounds.top)/[double]$frame.Groups[2].Value)
    $videoWidth=[double]$frame.Groups[1].Value*$scale; $videoHeight=[double]$frame.Groups[2].Value*$scale
    $videoLeft=$bounds.left+(($bounds.right-$bounds.left)-$videoWidth)/2
    $videoTop=$bounds.top+(($bounds.bottom-$bounds.top)-$videoHeight)/2
    # A worked target inside the dedicated terminal, independent of sender code.
    $targetX=[int]($geometry.left+$geometry.width/3)
    $targetY=[int]($geometry.top+$geometry.height/2)
    $phoneX=[int]($videoLeft+$targetX/$geometry.screen_width*$videoWidth)
    $phoneY=[int]($videoTop+$targetY/$geometry.screen_height*$videoHeight)
    $testConsole=[TouchTestWindows]::GetConsoleWindow()
    [void][TouchTestWindows]::ShowWindow($testConsole,5)
    [void][TouchTestWindows]::SetForegroundWindow($testConsole)
    Start-Sleep -Milliseconds 300
    $focusBefore=[TouchTestWindows]::GetForegroundWindow().ToInt64()
    if ($focusBefore -eq $geometry.window) { throw 'Could not defocus the terminal before the click experiment.' }
    $target=New-Object TouchTestWindows+Point
    $target.X=$targetX; $target.Y=$targetY
    $targetWindow=[TouchTestWindows]::GetAncestor([TouchTestWindows]::WindowFromPhysicalPoint($target),2).ToInt64()
    if ($targetWindow -ne $geometry.window) { throw 'The dedicated terminal is not visible at the intended target; no remote tap was sent.' }
    [void][TouchTestWindows]::SetPhysicalCursorPos(5,5)
    Save-PhoneImage 'before-click'
    Tap $phoneX $phoneY
    Start-Sleep -Seconds 1
    $cursor=New-Object TouchTestWindows+Point
    [void][TouchTestWindows]::GetPhysicalCursorPos([ref]$cursor)
    $foreground=[TouchTestWindows]::GetForegroundWindow().ToInt64()
    $released=([TouchTestWindows]::GetAsyncKeyState(1) -band 0x8000) -eq 0
    if ($foreground -ne $geometry.window -or !$released -or [Math]::Abs($cursor.X-$targetX) -gt 6 -or [Math]::Abs($cursor.Y-$targetY) -gt 6) {
        throw "Android tap did not focus the Windows terminal at the target: cursor=$($cursor.X),$($cursor.Y), foreground=$foreground, released=$released."
    }
    Save-PhoneImage 'after-focus'
    # Classic conhost can consume the first click while activating its window.
    # Verify focus separately; a second tap on the active terminal must produce
    # real console mouse records, independent of the sender's diagnostic log.
    $focusEvents=Read-ConsoleEvents
    Tap $phoneX $phoneY
    $deadline=(Get-Date).AddSeconds(5)
    do { Start-Sleep -Milliseconds 100; $events=Read-ConsoleEvents } until ($events.Count -ge $focusEvents.Count+2 -or (Get-Date) -gt $deadline)
    Save-PhoneImage 'after-click'
    $released=([TouchTestWindows]::GetAsyncKeyState(1) -band 0x8000) -eq 0
    if ($events.Count -ne $focusEvents.Count+2 -or $events[$focusEvents.Count].event -ne 'down' -or $events[$focusEvents.Count+1].event -ne 'up' -or !$released) {
        throw "Android tap did not produce one real Windows terminal down/up pair: before=$($focusEvents.Count), after=$($events.Count), released=$released."
    }
    # A second, deliberately noncentral point verifies both axes under scaling.
    $secondX=[int]($geometry.left+$geometry.width*2/3)
    $secondY=[int]($geometry.top+$geometry.height/3)
    $secondPhoneX=[int]($videoLeft+$secondX/$geometry.screen_width*$videoWidth)
    $secondPhoneY=[int]($videoTop+$secondY/$geometry.screen_height*$videoHeight)
    $beforeSecond=$events.Count
    Tap $secondPhoneX $secondPhoneY
    Start-Sleep -Milliseconds 500
    [void][TouchTestWindows]::GetPhysicalCursorPos([ref]$cursor)
    $events=Read-ConsoleEvents
    if ($events.Count -ne $beforeSecond+2 -or $events[$beforeSecond].event -ne 'down' -or $events[$beforeSecond+1].event -ne 'up' -or [Math]::Abs($cursor.X-$secondX) -gt 6 -or [Math]::Abs($cursor.Y-$secondY) -gt 6) {
        throw 'Second scaled target did not receive the expected Windows click.'
    }
    Save-PhoneImage 'second-target'
    $expectedEvents=$events.Count; $expectedX=$cursor.X; $expectedY=$cursor.Y
    $container=Read-Bounds $surface.ParentNode
    if ($videoLeft-$container.left -gt 20 -and $container.right-($videoLeft+$videoWidth) -gt 20) {
        $borderA=@([int](($container.left+$videoLeft)/2),[int]($videoTop+$videoHeight/2))
        $borderB=@([int](($container.right+$videoLeft+$videoWidth)/2),$borderA[1])
    } elseif ($videoTop-$container.top -gt 20 -and $container.bottom-($videoTop+$videoHeight) -gt 20) {
        $borderA=@([int]($videoLeft+$videoWidth/2),[int](($container.top+$videoTop)/2))
        $borderB=@($borderA[0],[int](($container.bottom+$videoTop+$videoHeight)/2))
    } else { throw 'The current device layout has no two usable letterbox margins for this acceptance case.' }
    Tap $borderA[0] $borderA[1]
    Assert-NoInput 'First letterbox margin' $expectedEvents $expectedX $expectedY
    Tap $borderB[0] $borderB[1]
    Assert-NoInput 'Second letterbox margin' $expectedEvents $expectedX $expectedY
    & adb @adbTarget shell input swipe $phoneX $phoneY $secondPhoneX $secondPhoneY 400 | Out-Null; Check-Adb
    Assert-NoInput 'Drag gesture' $expectedEvents $expectedX $expectedY
    # Leave a contact unfinished. A tap is atomic at touch-up, so this must not
    # hold a remote button, and backgrounding must revoke the entire session.
    & adb @adbTarget shell input motionevent DOWN $phoneX $phoneY | Out-Null; Check-Adb
    Assert-NoInput 'Unfinished touch contact' $expectedEvents $expectedX $expectedY
    & adb @adbTarget shell input keyevent 3 | Out-Null; Check-Adb
    Start-Sleep -Seconds 1
    & adb @adbTarget shell input motionevent UP $phoneX $phoneY | Out-Null; Check-Adb
    $phoneLog=Read-PhoneLog
    if (!$phoneLog.Contains('activity_stopped=true') -or !$senderProcess.WaitForExit(10000)) { throw 'Backgrounding did not end the authorized session.' }
    $senderProcess.Refresh()
    if ($senderProcess.ExitCode -ne 0) { throw 'Sender did not cleanly end its session.' }
    Assert-NoInput 'Background session end' $expectedEvents $expectedX $expectedY
    # Bring the same Activity back without force-stop or credentials. A stale
    # desktop surface must remain inert until an explicit new authorization.
    & adb @adbTarget shell am start -W -n "$package/.ProbeActivity" | Out-Null; Check-Adb
    $remainingProcess=((& adb @adbTarget shell pidof $package) -join '').Trim(); Check-Adb
    if ($remainingProcess -ne $phoneProcess) { throw 'Android process did not survive background cleanup.' }
    Tap $phoneX $phoneY
    Assert-NoInput 'Stale foreground view' $expectedEvents $expectedX $expectedY
    Save-PhoneImage 'after-session-end'
    $crashes=(& adb @adbTarget logcat -d "--pid=$phoneProcess" -s 'AndroidRuntime:E' '*:S') -join "`n"; Check-Adb
    if ($crashes.Contains('FATAL EXCEPTION')) { throw 'Android crashed during input/session cleanup.' }
    [ordered]@{
        wrong_pairing_no_video_or_input=$true; terminal_focus_changed=$true; terminal_click=$true
        actual_down_up_pair=$true; second_scaled_target=$true; letterbox_margins_rejected=2
        drag_rejected=$true; unfinished_touch_did_not_press=$true; background_session_ended=$true
        stale_view_no_input=$true; android_process_survived=$true; left_button_released=$true
        first_target=@($targetX,$targetY); second_target=@($secondX,$secondY)
        observed_second_pointer=@($cursor.X,$cursor.Y); real_console_events=$events.Count
        captured_primary_display=@($geometry.screen_width,$geometry.screen_height)
        video_bounds=@($videoLeft,$videoTop,$videoWidth,$videoHeight)
        visual_review='required: compare before-click, after-focus, after-click and second-target images'
        run_directory=$run
    } | ConvertTo-Json | Tee-Object -FilePath (Join-Path $run 'result.json')
} finally {
    if ($phoneProcess) {
        try { [IO.File]::WriteAllText((Join-Path $run 'android.log'),(Read-PhoneLog)) }
        catch { Write-Warning 'Could not collect final Android log.' }
    }
    if ($script:ownsPhone) { & adb @adbTarget shell am force-stop $package | Out-Null }
    if ($senderProcess -and !$senderProcess.HasExited) { Stop-Process -Id $senderProcess.Id }
    [IO.File]::WriteAllText((Join-Path $run 'stop-fixture'),'stop')
    if ($fixtureProcess -and !$fixtureProcess.WaitForExit(3000)) {
        if ($geometry) { Stop-Process -Id $geometry.pid -ErrorAction SilentlyContinue }
        Stop-Process -Id $fixtureProcess.Id -ErrorAction SilentlyContinue
    }
    $code=$null; $wrong=$null
    Write-Output "run_directory=$run"
}
