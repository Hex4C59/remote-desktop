param([Parameter(Mandatory=$true)][string]$Executable,
      [Parameter(Mandatory=$true)][string]$OutputDirectory,
      [switch]$IncludeDeadline)
$root=$OutputDirectory
if(!(Test-Path $root)){New-Item -ItemType Directory $root|Out-Null}
. "$PSScriptRoot\network-shaper-session.ps1"
$a=[Net.Sockets.UdpClient]::new(0);$b=[Net.Sockets.UdpClient]::new(0)
$a.Client.ReceiveTimeout=500;$b.Client.ReceiveTimeout=500
$ap=$a.Client.LocalEndPoint.Port;$bp=$b.Client.LocalEndPoint.Port
$a.Connect('127.0.0.1',$bp);$b.Connect('127.0.0.1',$ap)
$payload=[byte[]]::new(1200);$peer=[Net.IPEndPoint]::new([Net.IPAddress]::Any,0)
$results=@()
try {
 foreach($profile in @('pass','rate','delay','loss')) {
  $dir="$root\driver-test-$profile-$([guid]::NewGuid().ToString('N'))"
  $state=Start-NetworkShaper -Executable $Executable -Directory $dir -Session ([guid]::NewGuid().ToString()) -Experiment ([guid]::NewGuid().ToString()) -Profile $profile -LocalAddress '127.0.0.1' -LocalPort $ap -RemoteAddress '127.0.0.1' -RemotePort $bp -ExpectedOwnerPid $PID
  try {
   Set-NetworkShaper $state active
   $other=[Net.Sockets.UdpClient]::new(0)
   try {
    $unrelated=[Net.Sockets.UdpClient]::new(0);$unrelated.Client.ReceiveTimeout=500
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $other.Send($payload,$payload.Length,'127.0.0.1',$unrelated.Client.LocalEndPoint.Port)|Out-Null
    $unrelated.Receive([ref]$peer)|Out-Null
    $unrelatedMs=$timer.Elapsed.TotalMilliseconds
    if($unrelatedMs -gt 40){throw 'Nonmatching UDP flow was delayed'}
   }finally{$other.Dispose();if($unrelated){$unrelated.Dispose()}}
   $times=@();$received=0;$missing=0
   $count=if($profile -eq 'loss'){300}else{12}
   for($i=0;$i -lt $count;$i++) {
    $sw=[Diagnostics.Stopwatch]::StartNew();$a.Send($payload,$payload.Length)|Out-Null
    try{$b.Receive([ref]$peer)|Out-Null;$b.Send($payload,$payload.Length)|Out-Null;$a.Receive([ref]$peer)|Out-Null;$received++;$times+=$sw.Elapsed.TotalMilliseconds}catch [Net.Sockets.SocketException]{$missing++}
   }
   Set-NetworkShaper $state pass
   $sw=[Diagnostics.Stopwatch]::StartNew();$a.Send($payload,$payload.Length)|Out-Null;$b.Receive([ref]$peer)|Out-Null
   $after=$sw.Elapsed.TotalMilliseconds
   $results+=[ordered]@{profile=$profile;sent_roundtrips=$count;received=$received;missing=$missing;mean_roundtrip_ms=($times|Measure-Object -Average).Average;after_clear_oneway_ms=$after;unrelated_oneway_ms=$unrelatedMs;directory=$dir}
  }finally{Stop-NetworkShaper $state}
 }
 # Liveness failure must unblock subsequent matching traffic without a control command.
 $dir="$root\driver-test-watchdog-$([guid]::NewGuid().ToString('N'))"
 $state=Start-NetworkShaper -Executable $Executable -Directory $dir -Session ([guid]::NewGuid().ToString()) -Experiment ([guid]::NewGuid().ToString()) -Profile delay -LocalAddress '127.0.0.1' -LocalPort $ap -RemoteAddress '127.0.0.1' -RemotePort $bp -ExpectedOwnerPid $PID
 try {
  Set-NetworkShaper $state active
  Stop-Job $state.heartbeat
  $exited=$state.process.WaitForExit(8000)
  $a.Send($payload,$payload.Length)|Out-Null;$b.Receive([ref]$peer)|Out-Null
  if(!$exited -or !(Test-Path "$dir\watchdog.json")){throw 'Watchdog did not release filter'}
  $results+=[ordered]@{profile='heartbeat_lost';released=$true;directory=$dir}
 }finally{Stop-NetworkShaper $state}
 # Abrupt main-process death must also release the filter.
 $dir="$root\driver-test-crash-$([guid]::NewGuid().ToString('N'))"
 $state=Start-NetworkShaper -Executable $Executable -Directory $dir -Session ([guid]::NewGuid().ToString()) -Experiment ([guid]::NewGuid().ToString()) -Profile delay -LocalAddress '127.0.0.1' -LocalPort $ap -RemoteAddress '127.0.0.1' -RemotePort $bp -ExpectedOwnerPid $PID
 try {
  Set-NetworkShaper $state active
  $state.process.Kill();$state.process.WaitForExit(3000)|Out-Null
  $a.Send($payload,$payload.Length)|Out-Null;$b.Receive([ref]$peer)|Out-Null
  $results+=[ordered]@{profile='crash';released=$true;directory=$dir}
 }finally{Stop-NetworkShaper $state}
 if($IncludeDeadline) {
  $dir="$root\driver-test-deadline-$([guid]::NewGuid().ToString('N'))"
  $state=Start-NetworkShaper -Executable $Executable -Directory $dir -Session ([guid]::NewGuid().ToString()) -Experiment ([guid]::NewGuid().ToString()) -Profile delay -LocalAddress '127.0.0.1' -LocalPort $ap -RemoteAddress '127.0.0.1' -RemotePort $bp -ExpectedOwnerPid $PID
  try {
   Set-NetworkShaper $state active
   $wait=[Diagnostics.Stopwatch]::StartNew()
   while(!$state.process.HasExited -and $wait.Elapsed.TotalSeconds -lt 153){Start-Sleep -Milliseconds 200;$state.process.Refresh()}
   if(!$state.process.HasExited -or !(Test-Path "$dir\watchdog.json")){throw 'Active deadline did not release filter'}
   $a.Send($payload,$payload.Length)|Out-Null;$b.Receive([ref]$peer)|Out-Null
   $results+=[ordered]@{profile='active_deadline';released=$true;wait_seconds=$wait.Elapsed.TotalSeconds;directory=$dir}
  }finally{Stop-NetworkShaper $state}
 }
}finally{$a.Dispose();$b.Dispose()}
$results|ConvertTo-Json -Depth 4|Set-Content "$root\driver-tests.json" -Encoding UTF8
$results|ConvertTo-Json -Depth 4
