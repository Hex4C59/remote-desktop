param(
    [Parameter(Mandatory = $true)][string]$WebRtcRoot,
    [string]$SourceRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$manifest = Get-Content (Join-Path $SourceRoot 'scripts\webrtc\webrtc-build-candidate.json') -Raw | ConvertFrom-Json
$revision = & git -C $WebRtcRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -ne $manifest.webrtc.revision) {
    throw 'WebRTC checkout does not match the project revision.'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$env:vs2026_install = & $vswhere -latest -products '*' -version '[18.0,19.0)' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $env:vs2026_install) { throw 'VS2026 C++ tools were not found.' }
$env:GYP_MSVS_OVERRIDE_PATH = $env:vs2026_install
$env:DEPOT_TOOLS_UPDATE = '0'
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$depotTools = Join-Path (Split-Path (Split-Path $WebRtcRoot -Parent) -Parent) 'depot_tools'
$env:Path = "$depotTools;$env:Path"

$overlay = Join-Path $WebRtcRoot 'remote_desktop_probe'
# Assemble the existing libwebrtc overlay from application and probe sources.
$androidOverlay = Join-Path $overlay 'android'
New-Item -ItemType Directory -Force -Path $androidOverlay | Out-Null
Copy-Item (Join-Path $SourceRoot 'scripts\webrtc\BUILD.gn') (Join-Path $overlay 'BUILD.gn') -Force
Copy-Item (Join-Path $SourceRoot 'apps\windows\src\*') $overlay -Force
Copy-Item (Join-Path $SourceRoot 'probes\webrtc\*.cpp') $overlay -Force
Copy-Item (Join-Path $SourceRoot 'apps\android\src\main\AndroidManifest.xml') $androidOverlay -Force
Copy-Item (Join-Path $SourceRoot 'apps\android\src\main\java\*') $androidOverlay -Recurse -Force
$outputDirectory = Join-Path $WebRtcRoot 'out\remote-desktop-win'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$gnArguments = @'
target_os = "win"
target_cpu = "x64"
is_debug = false
is_component_build = false
symbol_level = 1
rtc_include_tests = false
rtc_build_examples = false
rtc_build_tools = false
use_remoteexec = false
use_siso = true
'@
[IO.File]::WriteAllText((Join-Path $outputDirectory 'args.gn'), $gnArguments)
Set-Location $WebRtcRoot
$backend = Join-Path $WebRtcRoot 'build\config\siso\backend_config\backend.star'
if (-not (Test-Path -LiteralPath $backend)) {
    Copy-Item (Join-Path $SourceRoot 'scripts\webrtc\siso-local.star') $backend
}
& (Join-Path $WebRtcRoot 'buildtools\win\gn.exe') gen $outputDirectory --root-target=//remote_desktop_probe:windows_validation
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$logPath = Join-Path $SourceRoot 'build\webrtc-sender-build.log'
$ErrorActionPreference = 'Continue'
& (Join-Path $WebRtcRoot 'third_party\siso\cipd\siso.exe') ninja -C $outputDirectory remote_desktop_probe:sender remote_desktop_probe:software_trace_smoke -local_jobs 8 -remote_jobs 0 *> $logPath
$buildExitCode = $LASTEXITCODE
Get-Content $logPath -Tail 35
exit $buildExitCode
