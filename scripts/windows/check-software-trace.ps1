param([Parameter(Mandatory=$true)][string]$WebRtcRoot,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Smoke output directory must be fresh.' }
$program=Join-Path $WebRtcRoot 'out\remote-desktop-win\software_trace_smoke.exe'
& $program $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Native trace smoke failed.' }
$rows=Get-Content (Join-Path $OutputDirectory 'stages.jsonl') | ForEach-Object { $_ | ConvertFrom-Json }
$captures=@($rows | Where-Object event -eq 'capture')
if ($captures.Count -eq 0 -or $rows[-1].event -ne 'stopped' -or $rows[-1].write_failed) { throw 'Trace did not finish.' }
if ($rows[-1].records_attempted -ne 1000 -or $captures.Count+$rows[-1].dropped_records_total -ne 1000) { throw 'Missing trace attempts.' }
if (@($captures | Where-Object { $_.session -ne '00000000-0000-0000-0000-000000000001' -or $_.receiver_statistics_seq -ne 1 }).Count) { throw 'Session association mismatch.' }
if (@($captures | Where-Object { $_.outcome -eq 'reused' -and
    ($_.acquire_status -ne 'timeout' -or $null -ne $_.convert_ns -or $null -ne $_.scale_ns -or $null -ne $_.rotate_ns) }).Count) { throw 'Reused frame stages are invalid.' }
[ordered]@{scope='synthetic_writer_only';attempts=1000;saved=$captures.Count;dropped=$rows[-1].dropped_records_total;passed=$true} | ConvertTo-Json -Compress
