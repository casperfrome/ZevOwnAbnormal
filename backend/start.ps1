$ErrorActionPreference = 'Stop'
$PythonExe = 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe'
Push-Location $PSScriptRoot
try {
    & $PythonExe -m alembic -c alembic.ini upgrade head
    & $PythonExe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
} finally {
    Pop-Location
}
