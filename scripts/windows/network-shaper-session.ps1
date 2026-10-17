# Test-only ownership and liveness wrapper. Dot-source from a local experiment runner.
$ErrorActionPreference='Stop'
function Start-NetworkShaper {
 param([string]$Executable,[string]$Directory,[string]$Session,[string]$Experiment,
       [ValidateSet('pass','rate','delay','loss')][string]$Profile,
       [string]$LocalAddress,[int]$LocalPort,[string]$RemoteAddress,[int]$RemotePort,[int]$ExpectedOwnerPid)
 if(Test-Path $Directory){throw 'Shaper directory must be fresh'}
 $endpoints=@(Get-NetUDPEndpoint -LocalPort $LocalPort -ErrorAction Stop|Where-Object {$_.OwningProcess -eq $ExpectedOwnerPid})
 if(!$endpoints.Count){throw 'Selected UDP socket is not owned by the authorized sender process'}
 New-Item -ItemType Directory $Directory|Out-Null
 'initial'|Set-Content "$Directory\heartbeat.txt" -Encoding ASCII
 $owner=Get-Process -Id $PID
 $beat=Start-Job -ArgumentList $PID,$owner.StartTime.ToUniversalTime().Ticks,$Directory -ScriptBlock {
  param($ownerId,$created,$directory)
  try {
   $parent=Get-Process -Id $ownerId -ErrorAction Stop
   if($parent.StartTime.ToUniversalTime().Ticks -ne $created){return}
   while(!$parent.HasExited){[IO.File]::WriteAllText("$directory\heartbeat.txt",[Diagnostics.Stopwatch]::GetTimestamp().ToString());Start-Sleep -Milliseconds 500;$parent.Refresh()}
  }catch{}
 }
 $arguments=@('--local-address',$LocalAddress,'--remote-address',$RemoteAddress,'--local-port',"$LocalPort",'--remote-port',"$RemotePort",'--session',$Session,'--experiment',$Experiment,'--profile',$Profile,'--directory',$Directory)
 if(@($arguments|Where-Object {$_ -match '["\r\n]' -or $_.EndsWith('\')}).Count){Stop-Job $beat;Remove-Job $beat;throw 'Unsupported control argument'}
 $arguments=@($arguments|ForEach-Object {'"'+$_+'"'})
 $process=Start-Process $Executable -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardError "$Directory\stderr.log" -RedirectStandardOutput "$Directory\stdout.log"
 $state=[pscustomobject]@{process=$process;heartbeat=$beat;directory=$Directory;session=$Session;experiment=$Experiment;epoch=0;executable=$Executable}
 $deadline=[Diagnostics.Stopwatch]::StartNew()
 while(!(Test-Path "$Directory\ready.json") -and !$process.HasExited -and $deadline.Elapsed.TotalSeconds -lt 10){Start-Sleep -Milliseconds 50}
 if(!(Test-Path "$Directory\ready.json")) {Stop-NetworkShaper $state;throw 'Shaper startup failed; see owned stderr/driver evidence'}
 return $state
}
function Set-NetworkShaper {
 param($State,[ValidateSet('active','pass')][string]$Mode)
 if($State.process.HasExited){throw 'Shaper already exited'}
 $State.epoch++
 $command="$($State.session) $($State.epoch) $Mode"
 [IO.File]::WriteAllText("$($State.directory)\control.pending",$command)
 Move-Item "$($State.directory)\control.pending" "$($State.directory)\control.txt" -Force
 $wait=[Diagnostics.Stopwatch]::StartNew()
 while($wait.Elapsed.TotalSeconds -lt 3 -and !$State.process.HasExited) {
  if((Test-Path "$($State.directory)\applied.txt") -and [IO.File]::ReadAllText("$($State.directory)\applied.txt").Trim() -eq $command){return}
  Start-Sleep -Milliseconds 20
 }
 throw 'Scoped profile acknowledgement missing'
}
function Stop-NetworkShaper {
 param($State)
 try {
  if(!$State.process.HasExited){
   $State.epoch++
   [IO.File]::WriteAllText("$($State.directory)\control.pending","$($State.session) $($State.epoch) stop")
   Move-Item "$($State.directory)\control.pending" "$($State.directory)\control.txt" -Force
   if(!$State.process.WaitForExit(3000)){$State.process.Kill();$State.process.WaitForExit(3000)|Out-Null}
  }
 }finally {
  Stop-Job $State.heartbeat -ErrorAction SilentlyContinue
  Remove-Job $State.heartbeat -Force -ErrorAction SilentlyContinue
 }
}
