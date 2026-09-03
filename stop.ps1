$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Same trap as start.ps1: run from the extracted ZIP this would look for a
# server that was never started there and report "not running" while the real
# installed Ledger carries on serving.
$parent = Split-Path -Parent $root
$fromPackage = $parent -and (@("Install-Ledger.cmd") |
    Where-Object { Test-Path (Join-Path $parent $_) })
if ($fromPackage) {
    $installed = Join-Path $env:LOCALAPPDATA "Ootaa Ledger"
    Write-Host "This is the setup folder, not your installed Ledger." -ForegroundColor Yellow
    if (Test-Path (Join-Path $installed "stop.ps1")) {
        Write-Host "Stopping the Ledger installed on this PC instead..." -ForegroundColor Cyan
        if (Get-ScheduledTask -TaskName "Ootaa Ledger Server" -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName "Ootaa Ledger Server" -ErrorAction SilentlyContinue
        }
        & (Join-Path $installed "stop.ps1")
        exit $LASTEXITCODE
    }
    Write-Host "Ledger is not installed on this PC, so there is nothing to stop." -ForegroundColor Red
    exit 1
}

$pidFile = Join-Path $root "server\data\server.pid"
if (Test-Path $pidFile) {
    $id = Get-Content $pidFile
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if (-not $process) {
        # Force-killed servers never run their own cleanup, so a stale pid file
        # is the normal case, not a problem.
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        Write-Host "Not running (stale pid file removed)."
        exit 0
    }
    $isLedger = (
        $process.CommandLine -like "*uvicorn*app.main:app*" -or
        $process.CommandLine -like "*run_ledger.py*"
    )
    if (-not $isLedger) {
        Write-Host "PID $id belongs to another program, not Ledger; refusing to stop it."
        exit 1
    }
    Stop-Process -Id $id -Force -ErrorAction Stop
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "Ledger stopped."
    exit 0
} else {
    Write-Host "Not running (no pid file)."
    exit 0
}
