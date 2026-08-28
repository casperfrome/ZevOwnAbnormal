$ErrorActionPreference = 'Stop'
$PythonExe = 'D:\PythonVenv\Scripts\python.exe'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
Push-Location $PSScriptRoot
try {
    & $PythonExe -u -m scripts.start_services
    $ServiceExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $ServiceExitCode
