$ErrorActionPreference = "Stop"
$target = Join-Path $env:LOCALAPPDATA "Ootaa Ledger"
$taskName = "Ootaa Ledger Server"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Write-Host "Ootaa Ledger updater v1" -ForegroundColor Cyan

# Every failure below uses throw. Without this the person running the updater
# sees a PowerShell stack trace instead of the message written for them.
trap {
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

function Find-Python {
    $candidates = @()
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $candidates += Get-ChildItem `
        "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe",
        "$env:ProgramFiles\Python*\python.exe" `
        -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not $candidate -or -not (Test-Path $candidate)) { continue }
        & $candidate --version *> $null
        if ($LASTEXITCODE -eq 0) { return $candidate }
    }
    return $null
}

function Mirror-Code([string]$Source, [string]$Destination, [string[]]$ExtraArgs = @()) {
    # /MIR also deletes files the new version dropped, which a plain copy would
    # leave behind to be imported by mistake. Excluded folders are neither
    # copied nor deleted, which is what keeps server\data safe.
    & robocopy $Source $Destination /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP @ExtraArgs
    if ($LASTEXITCODE -ge 8) {
        throw "Could not update '$Destination' (robocopy exit code $LASTEXITCODE)."
    }
}

$sourceCandidates = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter "start.ps1" `
    -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.Directory.FullName "run_ledger.py") } |
    Select-Object -ExpandProperty DirectoryName -Unique)
if ($sourceCandidates.Count -ne 1) {
    throw "The extracted package must contain exactly one Ledger application folder. Extract the entire ZIP before running this updater."
}
$source = $sourceCandidates[0]

if (Test-Path (Join-Path $source "server\data\ledger.db")) {
    throw @"
This is not an update package - it carries a database of its own.
Running it as an update would mix two ledgers.
Use Install-Ledger-New-PC.cmd instead.
"@
}
if (-not (Test-Path (Join-Path $target "run_ledger.py"))) {
    throw @"
Ledger is not installed on this PC, so there is nothing to update.
Expected it at: $target
Use Install-Ledger-New-PC.cmd for a first installation.
"@
}

$python = Find-Python
if (-not $python) { throw "Python could not be found. Run Install-Ledger-New-PC.cmd instead." }

$data = Join-Path $target "server\data"
$db = Join-Path $data "ledger.db"

Write-Host "Stopping Ledger..." -ForegroundColor Cyan
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
$oldStop = Join-Path $target "stop.ps1"
if (Test-Path $oldStop) { & $oldStop *> $null }
# The files cannot be replaced while the server still holds them open.
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    $holder = Get-NetTCPConnection -LocalPort 8080 -State Listen `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $holder) { break }
    Start-Sleep 2
}
$holder = Get-NetTCPConnection -LocalPort 8080 -State Listen `
    -ErrorAction SilentlyContinue | Select-Object -First 1
if ($holder) {
    $blocker = Get-Process -Id $holder.OwningProcess -ErrorAction SilentlyContinue
    throw "Ledger is still running as $(if ($blocker) { "$($blocker.ProcessName) (PID $($blocker.Id))" } else { "PID $($holder.OwningProcess)" }). Restart Windows and run this updater again."
}

if (Test-Path $db) {
    Write-Host "Backing up your records before touching anything..." -ForegroundColor Cyan
    $backupDir = Join-Path $data "backups"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backupPath = Join-Path $backupDir "pre-update-$stamp.db"
    $backupCode = @'
import sqlite3
import sys

source = sqlite3.connect(sys.argv[1])
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
    result = destination.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise RuntimeError(f"database integrity check failed: {result}")
finally:
    destination.close()
    source.close()
'@
    $backupCode | & $python - $db $backupPath
    if ($LASTEXITCODE -ne 0) {
        throw "Your database could not be backed up, so nothing was changed."
    }
    Write-Host "  Saved to $backupPath" -ForegroundColor Green
} else {
    Write-Host "No database found yet - this install has no records to protect." -ForegroundColor Yellow
}

# Keep the old program (not the data) so a bad update can be undone.
$rollback = Join-Path $env:LOCALAPPDATA "Ootaa Ledger.before-update-$stamp"
Write-Host "Keeping a copy of the current program for rollback..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $rollback -Force | Out-Null
& robocopy $target $rollback /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP `
    /XD (Join-Path $target "server\data") "node_modules" "__pycache__" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "The rollback copy failed, so nothing was changed." }

Write-Host "Installing the new version..." -ForegroundColor Cyan
Mirror-Code (Join-Path $source "server") (Join-Path $target "server") @(
    "/XD", (Join-Path $target "server\data"), "tests", "__pycache__", ".pytest_cache",
    "/XF", "*.pyc", "*.log"
)
Mirror-Code (Join-Path $source "web") (Join-Path $target "web") @(
    "/XD", "node_modules",
    "/XF", "tsconfig.tsbuildinfo"
)
# The payload root is already exactly the set of files a target PC needs, so
# copy all of it rather than a second hardcoded list that can drift.
foreach ($item in Get-ChildItem -LiteralPath $source -File) {
    Copy-Item -LiteralPath $item.FullName -Destination $target -Force
}

if (-not (Test-Path $db) -and (Test-Path (Join-Path $rollback "server\data\ledger.db"))) {
    throw "The update removed the database. It has been kept at $rollback - do not run Ledger until this is looked at."
}

Write-Host "Updating Ledger dependencies..." -ForegroundColor Cyan
& $python -m pip install --quiet -r (Join-Path $target "server\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

Write-Host "Starting Ledger..." -ForegroundColor Cyan
if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    $taskAction = New-ScheduledTaskAction -Execute $python `
        -Argument "`"$target\run_ledger.py`"" -WorkingDirectory $target
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn `
        -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $taskPrincipal = New-ScheduledTaskPrincipal `
        -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $taskAction `
        -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings `
        -Description "Runs the local Ootaa Ledger server." -Force | Out-Null
}
Start-ScheduledTask -TaskName $taskName

Write-Host "Waiting for Ledger to come back (database changes run now)..." -ForegroundColor Cyan
$ready = $false
$deadline = (Get-Date).AddMinutes(3)
while (-not $ready -and (Get-Date) -lt $deadline) {
    Start-Sleep 2
    try {
        $health = Invoke-RestMethod "http://localhost:8080/api/health" -TimeoutSec 3
        $ready = $health.ok -eq $true
    } catch { }
    if (-not $ready) { Write-Host "." -NoNewline }
}
Write-Host ""

if (-not $ready) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    $report = @("python: $python",
                "task last result: $(if ($info) { '0x{0:X}' -f $info.LastTaskResult } else { 'no task info' })")
    foreach ($log in @("uvicorn-error.log", "uvicorn.log")) {
        $path = Join-Path $data $log
        $report += "--- $log ---"
        $report += if (Test-Path $path) {
            $tail = Get-Content $path -Tail 25 -ErrorAction SilentlyContinue
            if ($tail) { $tail } else { "(empty)" }
        } else { "(never created)" }
    }
    throw @"
The update was installed but Ledger did not start.

Your records are safe. Nothing was deleted:
  database  : $db
  backup    : $(Join-Path $data "backups\pre-update-$stamp.db")
  old program: $rollback

To go back to the version that worked, delete this folder:
  $target
then rename '$rollback' to 'Ootaa Ledger', and run Start-Ootaa-Ledger.cmd inside it.

Send everything below to whoever set this up:
$($report -join "`n")
"@
}

Start-Process "http://localhost:8080"

# The new version is verified healthy, so older rollback copies are dead weight -
# each is a full copy of the program. The current one is kept.
Get-ChildItem "$env:LOCALAPPDATA\Ootaa Ledger.before-update-*" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $rollback } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host @"

Ledger is updated and running.
Your records, uploads and logins were kept exactly as they were.

  database backup: $(Join-Path $data "backups\pre-update-$stamp.db")
  previous version: $rollback

Once you are happy the new version works, that previous-version folder can
be deleted. Open http://localhost:8080 in any browser.
Press Ctrl+F5 once so the browser loads the new screens.
"@ -ForegroundColor Green
