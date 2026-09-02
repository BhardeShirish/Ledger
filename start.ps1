# Ootaa Ledger — Windows launcher
# Usage:  .\start.ps1          → build (if needed) + serve on http://localhost:8080
#         .\start.ps1 -Rebuild → force-rebuild the web bundle first
#         .\start.ps1 -Lan     → also listen on the network so a phone can reach it
param(
    [switch]$Rebuild,
    [switch]$NoBrowser,
    [switch]$KeepAlive,
    [switch]$Lan,
    [int]$Port
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Loopback unless asked otherwise: a ledger must not become reachable by accident.
$ledgerHost = if ($Lan) { "0.0.0.0" }
              elseif ($env:LEDGER_HOST) { $env:LEDGER_HOST }
              else { "127.0.0.1" }
$ledgerPort = if ($Port) { $Port }
              elseif ($env:LEDGER_PORT) { [int]$env:LEDGER_PORT }
              else { 8080 }
$ledgerUrl = "http://localhost:$ledgerPort"

# A ZIP is extracted next to its installer, and this launcher travels inside it.
# Run from there it would build a SECOND, empty ledger in the download folder -
# new random password, same port - while the real one sits installed elsewhere.
$packagedWith = @("Install-Ledger-New-PC.cmd", "Update-Ledger.cmd")
$parent = Split-Path -Parent $root
$fromPackage = $parent -and ($packagedWith | Where-Object {
    Test-Path (Join-Path $parent $_) })
if ($fromPackage) {
    $installed = Join-Path $env:LOCALAPPDATA "Ootaa Ledger"
    Write-Host ""
    Write-Host "This is the setup folder, not your installed Ledger." -ForegroundColor Yellow
    if (Test-Path (Join-Path $installed "run_ledger.py")) {
        Write-Host "Starting the Ledger that is installed on this PC instead..." -ForegroundColor Cyan
        $task = Get-ScheduledTask -TaskName "Ootaa Ledger Server" -ErrorAction SilentlyContinue
        if ($task) { Start-ScheduledTask -TaskName "Ootaa Ledger Server" }
        else { & (Join-Path $installed "start.ps1") @PSBoundParameters; exit $LASTEXITCODE }
        $ready = $false
        $deadline = (Get-Date).AddMinutes(2)
        while (-not $ready -and (Get-Date) -lt $deadline) {
            Start-Sleep 2
            try { $ready = (Invoke-RestMethod "$ledgerUrl/api/health" -TimeoutSec 3).ok -eq $true } catch { }
        }
        if ($ready) {
            Write-Host "OK - Ledger is running  ->  $ledgerUrl" -ForegroundColor Green
            Write-Host "Sign in with the password you chose during installation."
            Start-Process $ledgerUrl
            exit 0
        }
        Write-Host "Ledger did not answer. Open Task Scheduler and check 'Ootaa Ledger Server'." -ForegroundColor Red
        exit 1
    }
    Write-Host "Ledger is not installed on this PC yet." -ForegroundColor Red
    Write-Host "Go up one folder and double-click Install-Ledger-New-PC.cmd first." -ForegroundColor Yellow
    Write-Host "  looked in: $installed"
    if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

$server = Join-Path $root "server"
$web    = Join-Path $root "web"
$dist   = Join-Path $web "dist"
$dataDir = Join-Path $server "data"
$firstRun = -not (Test-Path (Join-Path $dataDir "ledger.db"))

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

$python = Find-Python
if (-not $python) {
    throw "Python is not installed. Run Install-Ledger-New-PC.cmd."
}

$distIndex = Join-Path $dist "index.html"
$srcDir = Join-Path $web "src"
# An installed PC receives only the built bundle - no sources, no Node.js.
# Only a machine that still has the sources can (or needs to) rebuild.
if (Test-Path $srcDir) {
    $latestSource = Get-ChildItem $srcDir -Recurse -File |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $manifest = Join-Path $web "package-lock.json"
    $needsBuild = $Rebuild -or -not (Test-Path $distIndex) -or ($latestSource -and $latestSource.LastWriteTimeUtc -gt (Get-Item $distIndex).LastWriteTimeUtc) -or ((Test-Path $manifest) -and (Get-Item $manifest).LastWriteTimeUtc -gt (Get-Item $distIndex).LastWriteTimeUtc)
} else {
    if (-not (Test-Path $distIndex)) {
        throw "The web bundle is missing and there are no sources to build it from. Reinstall Ledger from its ZIP."
    }
    $needsBuild = $false
}
if ($needsBuild) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "The web UI needs rebuilding but Node.js is not installed. Install Node.js, or reinstall Ledger from a package built on the development PC."
    }
    Write-Host "Building web UI…" -ForegroundColor Cyan
    Push-Location $web
    try {
        if (-not (Test-Path "node_modules") -or $Rebuild) {
            npm ci --no-audit --no-fund
        }
        npm run build
    } finally {
        Pop-Location
    }
}

Write-Host "Installing Python dependencies (first run only)…" -ForegroundColor Cyan
& $python -m pip install --quiet -r (Join-Path $server "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

# stop a previous instance
$pidFile = Join-Path $dataDir "server.pid"
if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old) {
        $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $old" -ErrorAction SilentlyContinue
        $isLedger = $oldProcess -and (
            $oldProcess.CommandLine -like "*uvicorn*app.main:app*" -or
            $oldProcess.CommandLine -like "*run_ledger.py*"
        )
        if ($isLedger) {
            Stop-Process -Id $old -Force -ErrorAction Stop
        }
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$identity = "$env:USERDOMAIN\$env:USERNAME"
& icacls $dataDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

$env:LEDGER_WEB_DIST = $dist
$env:LEDGER_DATA_DIR = $dataDir
# stable secret so sessions survive restarts
$secretFile = Join-Path $dataDir "secret.key"
if (Test-Path $secretFile) {
    $env:LEDGER_SECRET_KEY = (Get-Content $secretFile -Raw).Trim()
} else {
    $env:LEDGER_SECRET_KEY = "ootaa-" + [System.Guid]::NewGuid().ToString("N")
    Set-Content -Path $secretFile -Value $env:LEDGER_SECRET_KEY -NoNewline
}
$env:LEDGER_OWNER_USER = if ($env:LEDGER_OWNER_USER) { $env:LEDGER_OWNER_USER } else { "owner" }
if (-not $env:LEDGER_OWNER_PASSWORD) {
    $bytes = New-Object byte[] 18
    $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $env:LEDGER_OWNER_PASSWORD = [Convert]::ToBase64String($bytes)
}
$firstPassword = $env:LEDGER_OWNER_PASSWORD
$stdoutLog = Join-Path $dataDir "uvicorn.log"
$stderrLog = Join-Path $dataDir "uvicorn-error.log"
foreach ($log in @($stdoutLog, $stderrLog)) {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) {
        Move-Item $log "$log.1" -Force
    }
}

if ($firstRun) {
    Write-Host "First login: $($env:LEDGER_OWNER_USER) / $firstPassword -- save this password now." -ForegroundColor Yellow
}

$proc = Start-Process -PassThru -WindowStyle Hidden -FilePath $python `
    -ArgumentList "-m","uvicorn","app.main:app","--host",$ledgerHost,"--port","$ledgerPort" `
    -WorkingDirectory $server -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog
Set-Content -Path $pidFile -Value $proc.Id

try {
    $ready = $false
    $deadline = (Get-Date).AddMinutes(2)
    while (-not $ready -and (Get-Date) -lt $deadline) {
        Start-Sleep 2
        try {
            $health = Invoke-RestMethod "$ledgerUrl/api/health" -TimeoutSec 3
            $ready = $health.ok -eq $true
        } catch { }
        if (-not $ready -and $proc.HasExited) {
            throw "The Ledger server stopped straight away. See $stderrLog"
        }
    }
    if (-not $ready) { throw "Health check timed out" }
    Write-Host "`nOK - Ledger is running  ->  $ledgerUrl   (PID $($proc.Id))" -ForegroundColor Green
    if ($ledgerHost -eq "0.0.0.0") {
        # Printing the actual address is the difference between "it works" and
        # the owner hunting through ipconfig on their phone.
        $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                  Where-Object { $_.IPAddress -notlike "127.*" -and
                                 $_.IPAddress -notlike "169.254.*" } |
                  Select-Object -First 1).IPAddress
        if ($lanIp) {
            Write-Host "  On this network        ->  http://${lanIp}:$ledgerPort" -ForegroundColor Cyan
        }
        Write-Host "  Reachable from other devices. Prefer a private network" -ForegroundColor Yellow
        Write-Host "  (Tailscale) over public Wi-Fi, and keep a strong password." -ForegroundColor Yellow
    }
    Write-Host "  Stop with .\stop.ps1"
    if (-not $NoBrowser) {
        Start-Process $ledgerUrl
    }
    if ($KeepAlive) {
        try {
            Wait-Process -Id $proc.Id
        } finally {
            Remove-Item $pidFile -ErrorAction SilentlyContinue
        }
    }
} catch {
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $proc.Id -Force
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "Server did not come up - check port $ledgerPort or run: python -m uvicorn app.main:app --port $ledgerPort" -ForegroundColor Red
    exit 1
}
