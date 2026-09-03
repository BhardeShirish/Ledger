# Ootaa Ledger installer.
#
# Double-click Install-Ledger.cmd rather than running this directly.
#
# One script handles a first installation and an update of an existing one,
# because they are the same job with different amounts of caution, and two
# scripts drifted apart every time one of them was fixed.
#
# It runs in two phases. The first checks everything and changes nothing, so
# that a missing prerequisite is a tidy list on screen rather than a half
# installed Ledger. Only when every check passes does the second phase touch
# this PC.

$ErrorActionPreference = "Stop"

$Target    = if ($env:LEDGER_HOME) { $env:LEDGER_HOME } else { Join-Path $env:LOCALAPPDATA "Ootaa Ledger" }
$Port      = if ($env:LEDGER_PORT) { [int]$env:LEDGER_PORT } else { 8080 }
$Bind      = if ($env:LEDGER_HOST) { $env:LEDGER_HOST } else { "127.0.0.1" }
# A second installation somewhere else must not overwrite the real one's task.
$TaskName  = if ($env:LEDGER_HOME) { "Ootaa Ledger Server ($(Split-Path $Target -Leaf))" }
             else { "Ootaa Ledger Server" }
$Stamp     = Get-Date -Format "yyyyMMdd-HHmmss"
$PythonUrl = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"
$MinPython = [Version]"3.10"
$NeedMB    = 700

# Without this every failure below prints a PowerShell stack trace over the
# message that was written for the person standing at the till.
trap {
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

# ---------------------------------------------------------------- helpers

function Find-Python {
    $candidates = @()
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    $candidates += Get-ChildItem `
        "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe",
        "$env:ProgramFiles\Python*\python.exe" `
        -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not $candidate -or -not (Test-Path $candidate)) { continue }
        $reported = & $candidate --version 2>&1
        if ($LASTEXITCODE -ne 0) { continue }
        if ($reported -match "(\d+)\.(\d+)\.(\d+)") {
            $version = [Version]"$($Matches[1]).$($Matches[2])"
            if ($version -ge $MinPython) {
                return [pscustomobject]@{ Path = $candidate; Version = $version }
            }
        }
    }
    return $null
}

function Get-PortHolder {
    $held = Get-NetTCPConnection -LocalPort $Port -State Listen `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $held) { return $null }
    $process = Get-Process -Id $held.OwningProcess -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        Pid  = $held.OwningProcess
        Name = if ($process) { $process.ProcessName } else { "unknown" }
        Path = if ($process) { $process.Path } else { $null }
    }
}

function Stop-Ledger {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    $stop = Join-Path $Target "stop.ps1"
    if (Test-Path $stop) { & $stop *> $null }

    # The program files cannot be replaced while the server still holds them.
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-PortHolder)) { return }
        Start-Sleep 2
    }
    $holder = Get-PortHolder
    if ($holder) {
        throw "Ledger is still running as $($holder.Name) (PID $($holder.Pid)). Restart Windows and run this installer again."
    }
}

function Register-LedgerTask([string]$Python) {
    $action = New-ScheduledTaskAction -Execute $Python `
        -Argument "`"$Target\run_ledger.py`" --host $Bind --port $Port" `
        -WorkingDirectory $Target
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
    $principal = New-ScheduledTaskPrincipal -UserId $me `
        -LogonType Interactive -RunLevel Limited
    $settings  = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description "Runs the local Ootaa Ledger server." -Force | Out-Null
}

function Wait-ForLedger {
    # A cold Python start, the database migration and the first backup all
    # happen before the port opens, so a few seconds is not enough on a PC
    # that has just installed Python.
    Write-Host "Waiting for Ledger to start (the first run can take a couple of minutes)..." -ForegroundColor Cyan
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep 2
        try {
            if ((Invoke-RestMethod "http://localhost:$Port/api/health" -TimeoutSec 3).ok -eq $true) {
                Write-Host ""
                return $true
            }
        } catch { }
        Write-Host "." -NoNewline
    }
    Write-Host ""
    return $false
}

function Get-FailureReport([string]$Python) {
    $info  = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $state = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
    & $Python -c "import uvicorn, fastapi" *> $null
    $report = @(
        "python           : $Python",
        "dependencies load: $($LASTEXITCODE -eq 0)",
        "task state       : $state",
        "task last result : $(if ($info) { '0x{0:X}' -f $info.LastTaskResult } else { 'no task info' })",
        "port $Port held by : $(if ($h = Get-PortHolder) { "$($h.Name) (PID $($h.Pid))" } else { 'nothing' })"
    )
    foreach ($log in @("uvicorn-error.log", "uvicorn.log")) {
        $path = Join-Path $Target "server\data\$log"
        $report += "--- $log ---"
        $report += if (Test-Path $path) {
            $tail = Get-Content $path -Tail 25 -ErrorAction SilentlyContinue
            if ($tail) { $tail } else { "(empty)" }
        } else { "(never created)" }
    }
    return $report -join "`n"
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

$script:Problems = @()
function Check([string]$Name, [bool]$Ok, [string]$Detail, [string]$Fix) {
    $mark = if ($Ok) { "  OK  " } else { " FAIL " }
    $colour = if ($Ok) { "Green" } else { "Red" }
    Write-Host "[" -NoNewline
    Write-Host $mark -ForegroundColor $colour -NoNewline
    Write-Host "] $Name" -NoNewline
    if ($Detail) { Write-Host "  $Detail" -ForegroundColor DarkGray } else { Write-Host "" }
    if (-not $Ok) {
        $problem = if ($Detail) { "$Name - $Detail" } else { $Name }
        $script:Problems += "$problem`n      $Fix"
    }
}

# ------------------------------------------------------- phase 1: checks

Write-Host ""
Write-Host "Ootaa Ledger installer" -ForegroundColor Cyan
Write-Host "Checking this PC before anything is installed." -ForegroundColor Cyan
Write-Host ""

Check "Windows is 64-bit" ([Environment]::Is64BitOperatingSystem) `
    "" "Ledger needs 64-bit Windows."

Check "PowerShell 5 or newer" ($PSVersionTable.PSVersion.Major -ge 5) `
    "found $($PSVersionTable.PSVersion)" "Update Windows, or install PowerShell 7."

# The package must be extracted whole. Running the installer from inside a
# ZIP viewer copies a folder that is missing most of the program.
$appFolders = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter "run_ledger.py" `
    -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty DirectoryName -Unique)
$packageOk = $appFolders.Count -eq 1
Check "Package extracted correctly" $packageOk `
    $(if ($packageOk) { "found the Ledger folder" } else { "found $($appFolders.Count) Ledger folders" }) `
    "Extract the whole ZIP to a real folder first, then run Install-Ledger.cmd from there."

$Source = if ($packageOk) { $appFolders[0] } else { $null }

if ($Source) {
    $needed = @("server\requirements.txt", "server\app\main.py", "web\dist\index.html", "start.ps1")
    $missing = $needed | Where-Object { -not (Test-Path (Join-Path $Source $_)) }
    Check "Package is complete" ($missing.Count -eq 0) `
        $(if ($missing) { "missing: $($missing -join ', ')" } else { "all program files present" }) `
        "This ZIP is incomplete. Get a fresh copy of the package."
}

$python = Find-Python
$needsPythonDownload = -not $python
if ($python) {
    Check "Python $MinPython or newer" $true "found $($python.Version) at $($python.Path)" ""
} else {
    # Nothing is downloaded yet - this only asks whether it could be.
    $reachable = $false
    try {
        $reachable = (Invoke-WebRequest $PythonUrl -Method Head -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200
    } catch { }
    Check "Python can be installed" $reachable `
        "not on this PC, so the installer will fetch it from python.org" `
        "No Python and no way to download it. Connect to the internet, or install Python $MinPython+ from python.org first."
}

$installRoot = Split-Path $Target -Parent
$freeMB = [math]::Round((Get-PSDrive -Name $installRoot.Substring(0,1)).Free / 1MB)
Check "Enough disk space" ($freeMB -ge $NeedMB) `
    "$freeMB MB free, needs $NeedMB MB" "Free up space on your $($installRoot.Substring(0,2)) drive."

$canWrite = $false
try {
    $probe = Join-Path $installRoot ".ledger-write-test-$Stamp"
    New-Item -ItemType Directory -Path $probe -Force | Out-Null
    Remove-Item -LiteralPath $probe -Force
    $canWrite = $true
} catch { }
Check "Can install into your user folder" $canWrite "$Target" `
    "Windows refused to write to $installRoot. Sign in as the usual user, or ask IT."

Check "Can start Ledger automatically" `
    ([bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) "" `
    "This Windows edition has no Task Scheduler cmdlets, so Ledger cannot start by itself."

# Port 8080: a foreign program holding it is fatal, but Ledger holding it is
# ordinary - this is an update, and it gets stopped in phase 2.
$installed  = Test-Path (Join-Path $Target "run_ledger.py")
$holder     = Get-PortHolder
$ourPort    = $holder -and $installed -and
              ($holder.Path -like "*python*" -or $holder.Name -like "*python*")
Check "Port $Port is available" (-not $holder -or $ourPort) `
    $(if (-not $holder) { "nothing is using it" }
      elseif ($ourPort) { "Ledger is using it, and will be restarted" }
      else { "held by $($holder.Name) (PID $($holder.Pid))" }) `
    "Close the program using port $Port, then run this installer again."

# ----------------------------------------------------------- the verdict

$targetDb   = Join-Path $Target "server\data\ledger.db"
$packageDb  = if ($Source) { Join-Path $Source "server\data\ledger.db" } else { $null }
$hasRecords = Test-Path $targetDb
$packageHasRecords = $packageDb -and (Test-Path $packageDb)

$mode = if (-not $installed)            { "install" }
        elseif ($packageHasRecords)     { "replace" }
        else                            { "update"  }

Write-Host ""
if ($script:Problems.Count -gt 0) {
    Write-Host "Nothing has been installed. Fix these first:" -ForegroundColor Red
    Write-Host ""
    foreach ($problem in $script:Problems) { Write-Host "  - $problem" -ForegroundColor Yellow }
    Write-Host ""
    if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

switch ($mode) {
    "install" { Write-Host "Ready to install Ledger on this PC for the first time." -ForegroundColor Green }
    "update"  { Write-Host "Ledger is already installed. Ready to update the program and keep every record." -ForegroundColor Green }
    "replace" {
        Write-Host "STOP - read this." -ForegroundColor Red
        Write-Host "This package carries a ledger of its own, and this PC already has one." -ForegroundColor Red
        Write-Host "Continuing REPLACES the records on this PC with the ones in the package." -ForegroundColor Red
        Write-Host "The current ones will be moved aside, not deleted." -ForegroundColor Yellow
    }
}
Write-Host ""

if ($env:LEDGER_ASSUME_YES -ne "1") {
    $expected = if ($mode -eq "replace") { "REPLACE" } else { "" }
    if ($expected) {
        if ((Read-Host "Type $expected to continue, or press Enter to cancel") -ne $expected) {
            throw "Cancelled. Nothing on this PC was changed."
        }
    } else {
        Read-Host "Press Enter to continue, or close this window to cancel" | Out-Null
    }
}

# ------------------------------------------------------ phase 2: install

if ($needsPythonDownload) {
    Write-Host "Installing Python..." -ForegroundColor Cyan
    $installer = Join-Path $env:TEMP "python-for-ledger.exe"
    Invoke-WebRequest -Uri $PythonUrl -OutFile $installer
    $signature = Get-AuthenticodeSignature $installer
    if ($signature.Status -ne "Valid" -or
        $signature.SignerCertificate.Subject -notlike "*Python Software Foundation*") {
        Remove-Item -LiteralPath $installer -Force
        throw "The downloaded Python installer was not signed by the Python Software Foundation, so it was not run."
    }
    $run = Start-Process -FilePath $installer -Wait -PassThru -ArgumentList `
        "/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_pip=1", "Include_test=0"
    if ($run.ExitCode -ne 0) { throw "Python installation failed with exit code $($run.ExitCode)." }
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    $python = Find-Python
    if (-not $python) { throw "Python was installed, but python.exe could not be found afterwards." }
}
$Python = $python.Path

Stop-Ledger

$rollback = $null
if ($mode -eq "update") {
    Write-Host "Backing up your records before touching anything..." -ForegroundColor Cyan
    $data = Join-Path $Target "server\data"
    $backupPath = Join-Path $data "backups\pre-update-$Stamp.db"
    New-Item -ItemType Directory -Path (Split-Path $backupPath) -Force | Out-Null
    $backupCode = @'
import sqlite3, sys
source, destination = sqlite3.connect(sys.argv[1]), sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
    result = destination.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise RuntimeError(f"database integrity check failed: {result}")
finally:
    destination.close(); source.close()
'@
    if ($hasRecords) {
        $backupCode | & $Python - $targetDb $backupPath
        if ($LASTEXITCODE -ne 0) { throw "Your database could not be backed up, so nothing was changed." }
        Write-Host "  Saved to $backupPath" -ForegroundColor Green
    }

    # Keep the old program, not the data, so a bad update can be undone.
    $rollback = "$Target.before-update-$Stamp"
    Write-Host "Keeping a copy of the current program for rollback..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $rollback -Force | Out-Null
    & robocopy $Target $rollback /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP `
        /XD (Join-Path $Target "server\data") "node_modules" "__pycache__" | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "The rollback copy failed, so nothing was changed." }

    Write-Host "Installing the new version..." -ForegroundColor Cyan
    Mirror-Code (Join-Path $Source "server") (Join-Path $Target "server") @(
        "/XD", (Join-Path $Target "server\data"), "tests", "__pycache__", ".pytest_cache",
        "/XF", "*.pyc", "*.log")
    Mirror-Code (Join-Path $Source "web") (Join-Path $Target "web") @(
        "/XD", "node_modules", "/XF", "tsconfig.tsbuildinfo")
    foreach ($item in Get-ChildItem -LiteralPath $Source -File) {
        Copy-Item -LiteralPath $item.FullName -Destination $Target -Force
    }

    if ($hasRecords -and -not (Test-Path $targetDb)) {
        throw "The update removed the database. It has been kept at $rollback - do not run Ledger until this is looked at."
    }
} else {
    if (Test-Path $Target) {
        $moved = "$Target.previous-$Stamp"
        Move-Item -LiteralPath $Target -Destination $moved
        Write-Host "The previous installation was kept at '$moved'." -ForegroundColor Yellow
    }
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    Copy-Item -Path (Join-Path $Source "*") -Destination $Target -Recurse -Force
}

Write-Host "Installing Ledger's dependencies..." -ForegroundColor Cyan
& $Python -m pip install --quiet -r (Join-Path $Target "server\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

# Old desktop shortcuts from earlier versions point at paths that no longer
# exist, and a shortcut that does nothing looks like Ledger is broken.
$desktops = @([Environment]::GetFolderPath("Desktop"),
              (Join-Path $env:USERPROFILE "Desktop"),
              $(if ($env:OneDrive) { Join-Path $env:OneDrive "Desktop" })) |
            Where-Object { $_ } | Select-Object -Unique
foreach ($desktop in $desktops) {
    foreach ($old in @("Ootaa Ledger.url", "Ootaa Ledger.lnk",
                       "Ootaa Ledger (local).lnk", "START Ootaa Ledger.cmd")) {
        $path = Join-Path $desktop $old
        if (Test-Path $path) { Remove-Item -LiteralPath $path -Force }
    }
}

$ownerName = "owner"
$createdLedger = $false
if (-not (Test-Path $targetDb)) {
    $createdLedger = $true
    Write-Host ""
    Write-Host "A brand-new, empty ledger will be created." -ForegroundColor Cyan
    $password = $env:LEDGER_OWNER_PASSWORD
    if ($password -and $password.Length -ge 12 -and $password -ne "change-me-please") {
        Write-Host "Using the owner password from LEDGER_OWNER_PASSWORD." -ForegroundColor Cyan
    } else {
        Write-Host "Choose the owner password now. Write it down - it can be reset, but never recovered." -ForegroundColor Yellow
        while ($true) {
            $first = Read-Host "New owner password (at least 12 characters)" -AsSecureString
            $again = Read-Host "Type it again" -AsSecureString
            $password  = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first))
            $confirm = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($again))
            if ($password -ne $confirm)          { Write-Host "Those did not match. Try again." -ForegroundColor Yellow; continue }
            if ($password.Length -lt 12)         { Write-Host "Too short - use at least 12 characters." -ForegroundColor Yellow; continue }
            if ($password -eq "change-me-please"){ Write-Host "Please choose your own password." -ForegroundColor Yellow; continue }
            break
        }
    }

    # Built here with Ledger's own start-up code, so the background server
    # never has to be handed a password.
    $firstRunCode = @'
import os, sys
server, data = sys.argv[1], sys.argv[2]
sys.path.insert(0, server)
os.chdir(server)
os.environ["LEDGER_DATA_DIR"] = data
from app.config import ensure_dirs
from app.db import Base, SessionLocal, engine
from app.models import migrate
from app.seed import bootstrap
ensure_dirs()
Base.metadata.create_all(bind=engine)
migrate(engine)
db = SessionLocal()
try:
    info = bootstrap(db)
finally:
    db.close()
print(info.get("owner_username", "owner"))
'@
    Write-Host "Creating the ledger..." -ForegroundColor Cyan
    $env:LEDGER_OWNER_PASSWORD = $password
    try {
        $created = $firstRunCode | & $Python - (Join-Path $Target "server") (Join-Path $Target "server\data")
        if ($LASTEXITCODE -ne 0) { throw "The new Ledger database could not be created.`n$created" }
        $ownerName = ($created | Select-Object -Last 1).Trim()
    } finally {
        Remove-Item Env:\LEDGER_OWNER_PASSWORD -ErrorAction SilentlyContinue
        $password = $null; $confirm = $null
    }
}

Write-Host "Setting Ledger to start when you sign in..." -ForegroundColor Cyan
Register-LedgerTask $Python
Start-ScheduledTask -TaskName $TaskName

if (-not (Wait-ForLedger)) {
    $where = if ($rollback) {
@"
  database  : $targetDb
  backup    : $(Join-Path $Target "server\data\backups\pre-update-$Stamp.db")
  old program: $rollback

To go back to the version that worked, delete this folder:
  $Target
then rename '$rollback' to 'Ootaa Ledger' and run Start-Ootaa-Ledger.cmd inside it.
"@
    } else {
        "  database  : $targetDb"
    }
    throw @"
Ledger was installed, but its background server did not start.

Nothing was lost:
$where

Send everything below to whoever set this up:
$(Get-FailureReport $Python)
"@
}

Start-Process "http://localhost:$Port"

# The new version is proven healthy, so older rollback copies are dead weight -
# each one is a full copy of the program. Compared by name, because the folder
# listing and $rollback can spell the same path differently (8.3 short names).
$keep = if ($rollback) { Split-Path $rollback -Leaf } else { "" }
Get-ChildItem (Split-Path $Target -Parent) -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "$(Split-Path $Target -Leaf).before-update-*" -and
                   $_.Name -ne $keep } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($createdLedger) {
    Write-Host @"
Ledger is installed and running.

  Sign in as "$ownerName" with the password you just chose.
  Open http://localhost:$Port in any browser.
  Ledger starts by itself whenever you sign in to Windows.
"@ -ForegroundColor Green
} elseif ($mode -eq "update") {
    Write-Host @"
Ledger is updated and running.
Your records, receipts and logins were kept exactly as they were.

  database backup : $(Join-Path $Target "server\data\backups\pre-update-$Stamp.db")
  previous version: $rollback

Open http://localhost:$Port and press Ctrl+F5 once so the browser loads the new
screens. Once you are happy, the previous-version folder can be deleted.
"@ -ForegroundColor Green
} else {
    Write-Host @"
Ledger is installed and running, carrying the records from the package.

  Open http://localhost:$Port in any browser.
  Ledger starts by itself whenever you sign in to Windows.
  Do not keep entering data on the old PC, or the two ledgers will diverge.
"@ -ForegroundColor Green
}

if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" | Out-Null }
