$ErrorActionPreference = 'Stop'
& adb devices -l
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& adb -d get-state
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($property in @('ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abilist')) {
    $value = & adb -d shell getprop $property
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output "$property=$value"
}
& adb -d shell wm size
exit $LASTEXITCODE
