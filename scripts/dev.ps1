# Start HAVEN for development on Windows: the world-state service on :8000 and the Vite app on :5173.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# Stops any backend already holding :8000 first (a stale one keeps the port and the new one dies).
$root = Split-Path -Parent $PSScriptRoot
$stale = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*uvicorn*haven.api.app*' }
foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not (Test-Path "$root\backend\.venv")) { Push-Location "$root\backend"; uv sync; Pop-Location }
if (-not (Test-Path "$root\frontend\node_modules")) { Push-Location "$root\frontend"; npm install; Pop-Location }
Start-Process -FilePath "uv" -ArgumentList "run uvicorn haven.api.app:create_app --factory --port 8000" -WorkingDirectory "$root\backend" -WindowStyle Minimized
Start-Process -FilePath "npm" -ArgumentList "run dev" -WorkingDirectory "$root\frontend" -WindowStyle Minimized
Write-Host "HAVEN: backend http://localhost:8000/api/health · dashboard http://localhost:5173 · phone /phone · story /story"
Write-Host "Keys (all optional) go in backend\.env; see backend\.env.example and the README."
