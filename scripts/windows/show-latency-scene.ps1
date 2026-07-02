param(
    [Parameter(Mandatory=$true)][guid]$Experiment,
    [Parameter(Mandatory=$true)][guid]$SessionUuid,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
# Dot-source inside a NEW dedicated classic PowerShell terminal, after normal
# pairing. These are ordinary terminal commands; no input/media bypass exists.
# Each new authorized session needs a new console, experiment and output folder.
$ErrorActionPreference='Stop'
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a fresh experiment directory.' }
if ($null -ne (Get-Variable Task07Scene -Scope Global -ErrorAction SilentlyContinue)) {
    throw 'A scene already exists in this console; start a fresh dedicated console.'
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Task07SceneWindow {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$window=[Task07SceneWindow]::GetConsoleWindow()
if ($window -eq [IntPtr]::Zero) { throw 'A classic interactive console is required.' }
New-Item -ItemType Directory -Path $OutputDirectory -ErrorAction Stop | Out-Null
$global:Task07Scene=@{
    Experiment=$Experiment.ToString(); Session=$SessionUuid.ToString(); Window=$window
    Directory=[IO.Path]::GetFullPath($OutputDirectory); Feedback=0; DisplayStarted=$false
}
function global:Assert-Task07Scene {
    if (Test-Path (Join-Path $global:Task07Scene.Directory 'stop.request')) {
        throw 'Measurement stopped; use a new console for a new session.'
    }
    if ([Task07SceneWindow]::GetForegroundWindow() -ne $global:Task07Scene.Window) {
        throw 'Dedicated terminal lost foreground; stop input and recording.'
    }
}
function global:Write-Task07Event([string]$Metric,[int]$Round,[int]$Number) {
    Assert-Task07Scene
    $phase=if ($Number -le 3) { 'W' } else { 'S' }
    $ordinal=if ($Number -le 3) { $Number } else { $Number-3 }
    $id='{0}-{1}-R{2}-{3}{4:D2}' -f $global:Task07Scene.Experiment,$Metric,$Round,$phase,$ordinal
    # A stable target line, unique ID and changing checker prevent cursor/prompt
    # blink or repeated output from being mistaken for the target event.
    [Console]::SetCursorPosition(0,3)
    $marker=if ($Number % 2) { '########' } else { '========' }
    Write-Host ($marker+' '+$id+' '+$marker).PadRight(90)
    [ordered]@{event_id=$id;experiment=$global:Task07Scene.Experiment;
        session_uuid=$global:Task07Scene.Session;metric=$Metric;round=$Round;
        phase=$phase;ordinal=$ordinal;software_output_observed_utc=[DateTime]::UtcNow.ToString('o');
        physical_display_time=$null} | ConvertTo-Json -Compress |
        Add-Content -LiteralPath (Join-Path $global:Task07Scene.Directory 'events.jsonl') -Encoding UTF8
    [Console]::SetCursorPosition(0,7)
}
function global:ld {
    Assert-Task07Scene
    if ($global:Task07Scene.DisplayStarted) { throw 'Display sequence is single-use; retain partial runs.' }
    $global:Task07Scene.DisplayStarted=$true
    foreach ($round in 1..2) {
        Start-Sleep -Seconds 10
        foreach ($number in 1..13) {
            Write-Task07Event 'display' $round $number
            Start-Sleep -Seconds 5
        }
    }
    Write-Host 'DISPLAY SEQUENCE FINISHED. Keep the entire original recording.'
}
function global:lf {
    Assert-Task07Scene
    if ($global:Task07Scene.Feedback -ge 26) { throw 'Feedback sequence finished; no extra samples.' }
    $global:Task07Scene.Feedback++
    $n=$global:Task07Scene.Feedback-1
    Write-Task07Event 'feedback' ([int][Math]::Floor($n/13)+1) (($n%13)+1)
}
function global:prompt { [Console]::SetCursorPosition(0,7); 'TASK07 PS> ' }
Clear-Host
Write-Host 'TASK07 PHYSICAL LATENCY - DEDICATED TERMINAL'
Write-Host ('Experiment: '+$Experiment.ToString())
Write-Host ('Session: '+$SessionUuid.ToString())
Write-Host 'READY - no physical events measured yet'
Write-Host ''
Write-Host 'ld: display sequence. lf: one real terminal feedback event.'
Write-Host 'After lf: wait >=5 seconds, then tablet Up + Enter to repeat.'
