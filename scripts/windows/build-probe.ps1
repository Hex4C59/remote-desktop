param(
    [string]$SourceRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'Visual Studio Installer/vswhere was not found.' }
$installation = & $vswhere -latest -products '*' -version '[17.0,18.0)' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'VS2022 C++ tools were not found.' }
$cmake = Join-Path $installation 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path $cmake)) { throw 'VS2022 bundled CMake was not found.' }
$buildDirectory = Join-Path $SourceRoot 'build\windows-probe'

& $cmake -S $SourceRoot -B $buildDirectory -G 'Visual Studio 17 2022' -A x64 `
    "-DCMAKE_GENERATOR_INSTANCE=$installation" '-DCMAKE_SYSTEM_VERSION=10.0.26100.0'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $cmake --build $buildDirectory --config Release --parallel 4
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# SSH can verify the build and basic enumeration. Capture is an interactive test.
& (Join-Path $buildDirectory 'Release\windows_desktop_probe.exe')
exit $LASTEXITCODE
