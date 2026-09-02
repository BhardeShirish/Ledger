$ErrorActionPreference = "Stop"
$target = Join-Path $env:LOCALAPPDATA "Ootaa Ledger"
$pythonInstaller = Join-Path $env:TEMP "python-3.12.10-amd64.exe"
$taskName = "Ootaa Ledger Server"
Write-Host "Ootaa Ledger local installer v5" -ForegroundColor Cyan

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

$sourceCandidates = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter "start.ps1" `
    -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object {
        # Identify the app folder by the launcher, not by the database: a
        # fresh-install package deliberately carries no database.
        Test-Path (Join-Path $_.Directory.FullName "run_ledger.py")
    } |
    Select-Object -ExpandProperty DirectoryName -Unique)
if ($sourceCandidates.Count -ne 1) {
    throw "The extracted package must contain exactly one Ledger application folder. Extract the entire ZIP before running this installer."
}
$source = $sourceCandidates[0]

$python = Find-Python
if (-not $python) {
    Write-Host "Installing Python for Ledger..." -ForegroundColor Cyan
    Invoke-WebRequest `
        -Uri "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" `
        -OutFile $pythonInstaller
    $signature = Get-AuthenticodeSignature $pythonInstaller
    if ($signature.Status -ne "Valid" -or
        $signature.SignerCertificate.Subject -notlike "*Python Software Foundation*") {
        Remove-Item -LiteralPath $pythonInstaller -Force
        throw "The downloaded Python installer did not have a valid Python Software Foundation signature."
    }
    $install = Start-Process -FilePath $pythonInstaller -Wait -PassThru `
        -ArgumentList "/quiet", "InstallAllUsers=0", "PrependPath=1",
            "Include_pip=1", "Include_test=0"
    if ($install.ExitCode -ne 0) {
        throw "Python installation failed with exit code $($install.ExitCode)."
    }
    $python = Find-Python
    if (-not $python) { throw "Python installed, but python.exe could not be found." }
}

Write-Host "Installing Ootaa Ledger..." -ForegroundColor Cyan
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
if ((Test-Path $target) -and
    (Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue)) {
    $oldTarget = "$target.previous-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

    # A no-data package on a PC that already holds records would silently look
    # like everything was wiped. Make that impossible to do by accident.
    if ((-not (Test-Path (Join-Path $source "server\data\ledger.db"))) -and
        (Test-Path (Join-Path $target "server\data\ledger.db"))) {
        Write-Host ""
        Write-Host "STOP - this is a fresh-install package that contains no data," -ForegroundColor Red
        Write-Host "but this PC already has a Ledger with records in it." -ForegroundColor Red
        Write-Host "Continuing will start an EMPTY ledger. Your current records will be" -ForegroundColor Red
        Write-Host "moved aside to:" -ForegroundColor Red
        Write-Host "  $oldTarget" -ForegroundColor Red
        Write-Host "If you meant to move your data to this PC, cancel and use the" -ForegroundColor Yellow
        Write-Host "normal (data) package instead." -ForegroundColor Yellow
        if ($env:LEDGER_ASSUME_YES -ne "1") {
            $answer = Read-Host "Type ERASE to start an empty ledger, or press Enter to cancel"
            if ($answer -ne "ERASE") {
                throw "Cancelled. Nothing on this PC was changed."
            }
        }
    }

    $oldStop = Join-Path $target "stop.ps1"
    if (Test-Path $oldStop) { & $oldStop }
    Move-Item -LiteralPath $target -Destination $oldTarget
    Write-Host "The previous installation was preserved at '$oldTarget'." -ForegroundColor Yellow
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force

Write-Host "Installing Ledger dependencies..." -ForegroundColor Cyan
& $python -m pip install --quiet -r (Join-Path $target "server\requirements.txt")
if ($LASTEXITCODE -ne 0) {
    throw "Python dependency installation failed."
}

$desktop = [Environment]::GetFolderPath("Desktop")
$desktopPaths = @(
    $desktop,
    (Join-Path $env:USERPROFILE "Desktop"),
    $(if ($env:OneDrive) { Join-Path $env:OneDrive "Desktop" })
) | Where-Object { $_ } | Select-Object -Unique
foreach ($desktopPath in $desktopPaths) {
    foreach ($oldName in @(
        "Ootaa Ledger.url",
        "Ootaa Ledger.lnk",
        "Ootaa Ledger (local).lnk",
        "START Ootaa Ledger.cmd"
    )) {
        $oldShortcut = Join-Path $desktopPath $oldName
        if (Test-Path $oldShortcut) {
            Remove-Item -LiteralPath $oldShortcut -Force
        }
    }
}

$freshInstall = -not (Test-Path (Join-Path $target "server\data\ledger.db"))
$ownerName = "owner"
if ($freshInstall) {
    Write-Host ""
    Write-Host "This package contains no data, so a brand-new ledger will be created." -ForegroundColor Cyan
    $plainFirst = $env:LEDGER_OWNER_PASSWORD
    if ($plainFirst -and $plainFirst.Length -ge 12 -and $plainFirst -ne "change-me-please") {
        Write-Host "Using the owner password supplied in LEDGER_OWNER_PASSWORD." -ForegroundColor Cyan
    } else {
        Write-Host "Choose the owner password now. Write it down - it can only be reset, not recovered." -ForegroundColor Yellow
        while ($true) {
            $first = Read-Host "New owner password (at least 12 characters)" -AsSecureString
            $again = Read-Host "Type it again" -AsSecureString
            $plainFirst = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first))
            $plainAgain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($again))
            if ($plainFirst -ne $plainAgain) {
                Write-Host "Those did not match. Try again." -ForegroundColor Yellow; continue
            }
            if ($plainFirst.Length -lt 12) {
                Write-Host "Too short - use at least 12 characters." -ForegroundColor Yellow; continue
            }
            if ($plainFirst -eq "change-me-please") {
                Write-Host "Please choose your own password." -ForegroundColor Yellow; continue
            }
            break
        }
    }

    # Build the database here, using Ledger's own start-up code, so the
    # background server never has to be handed a password.
    $firstRunCode = @'
import os
import sys

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
    Write-Host "Creating the new ledger..." -ForegroundColor Cyan
    $env:LEDGER_OWNER_PASSWORD = $plainFirst
    try {
        $created = $firstRunCode | & $python - (Join-Path $target "server") `
            (Join-Path $target "server\data")
        if ($LASTEXITCODE -ne 0) {
            throw "The new Ledger database could not be created.`n$created"
        }
        $ownerName = ($created | Select-Object -Last 1).Trim()
    } finally {
        Remove-Item Env:\LEDGER_OWNER_PASSWORD -ErrorAction SilentlyContinue
        $plainFirst = $null
        $plainAgain = $null
    }
}

Write-Host "Registering Ledger to start automatically..." -ForegroundColor Cyan

# Nothing else may hold Ledger's port, or the server will die on startup with an
# error only a developer could read.
$portOwner = Get-NetTCPConnection -LocalPort 8080 -State Listen `
    -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portOwner) {
    $blocker = Get-Process -Id $portOwner.OwningProcess -ErrorAction SilentlyContinue
    $blockerName = if ($blocker) { "$($blocker.ProcessName) (PID $($blocker.Id))" }
                   else { "PID $($portOwner.OwningProcess)" }
    throw @"
Another program on this PC is already using port 8080, which Ledger needs.
The program is: $blockerName
Close that program and run this installer again.
"@
}

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
Start-ScheduledTask -TaskName $taskName

# A brand-new PC is slow on the first run: cold Python start, database
# migration and the first backup all happen before the port opens. Waiting
# only a few seconds here reports failure on a server that is still starting.
Write-Host "Waiting for Ledger to start (first run can take a couple of minutes)..." `
    -ForegroundColor Cyan
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
    $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
    & $python -c "import uvicorn, fastapi" *> $null
    $importsOk = ($LASTEXITCODE -eq 0)
    $holder = Get-NetTCPConnection -LocalPort 8080 -State Listen `
        -ErrorAction SilentlyContinue | Select-Object -First 1

    $report = @()
    $report += "python           : $python"
    $report += "dependencies load: $importsOk"
    $report += "task state       : $state"
    $report += "task last result : $(if ($info) { '0x{0:X}' -f $info.LastTaskResult } else { 'no task info' })"
    $report += "task last run    : $(if ($info) { $info.LastRunTime } else { '-' })"
    $report += "port 8080 held by: $(if ($holder) { $holder.OwningProcess } else { 'nothing' })"
    foreach ($log in @("uvicorn-error.log", "uvicorn.log")) {
        $path = Join-Path $target "server\data\$log"
        $report += "--- $log ---"
        $report += if (Test-Path $path) {
            $tail = Get-Content $path -Tail 25 -ErrorAction SilentlyContinue
            if ($tail) { $tail } else { "(empty)" }
        } else { "(never created)" }
    }

    throw @"
Ledger was copied to this PC, but its background server did not start.
Nothing was lost - your data is safe at:
$target\server\data\ledger.db

Send everything below to whoever set this up:
$($report -join "`n")
"@
}
Start-Process "http://localhost:8080"

$closing = if ($freshInstall) {
@"

This laptop now runs a brand-new, empty Ledger.
Sign in as "$ownerName" with the password you just chose.
Ledger starts automatically when you sign in to Windows.
Open http://localhost:8080 in any browser.
"@
} else {
@"

This laptop is now the Ledger base PC.
Ledger starts automatically when you sign in to Windows.
Open http://localhost:8080 in any browser.
Do not enter new data on the old PC, or the two databases will diverge.
"@
}
Write-Host $closing -ForegroundColor Green
