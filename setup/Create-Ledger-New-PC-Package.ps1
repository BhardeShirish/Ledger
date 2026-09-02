<#
  .SYNOPSIS
    Builds the ZIP used to move Ledger to another PC, or to update one.
  .PARAMETER Fresh
    Package the application with NO data: no database, uploads, imports or
    session key. The new PC starts an empty ledger and asks for a new owner
    password during install. This PC is left running and untouched.
  .PARAMETER Update
    Package the application code ONLY, to refresh a PC that already runs
    Ledger. The other PC keeps its database, uploads and logins.
#>
param([switch]$Fresh, [switch]$Update)

$ErrorActionPreference = "Stop"
if ($Fresh -and $Update) {
    throw "Choose either -Fresh or -Update, not both."
}
$setup = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $setup
$output = Join-Path $root $(if ($Update) { "Ledger-Update.zip" }
                            elseif ($Fresh) { "Ledger-Fresh-Install.zip" }
                            else { "Ledger-New-PC.zip" })
$stage = Join-Path $env:TEMP ("Ootaa-Ledger-Move-" + [Guid]::NewGuid().ToString("N"))
$payload = Join-Path $stage "Ledger"
$sourceDb = Join-Path $root "server\data\ledger.db"
$snapshotDb = Join-Path $payload "server\data\ledger.db"

function Copy-Tree([string]$Source, [string]$Destination, [string[]]$ExtraArgs = @()) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy $Source $Destination /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP @ExtraArgs
    if ($LASTEXITCODE -ge 8) {
        throw "Could not copy '$Source' (robocopy exit code $LASTEXITCODE)."
    }
}

if (-not $Fresh -and -not $Update -and -not (Test-Path $sourceDb)) {
    throw "No Ledger database was found at '$sourceDb'."
}

$rootFiles = @("start.ps1", "stop.ps1", "Start-Ootaa-Ledger.cmd",
               "Stop-Ootaa-Ledger.cmd", "run_ledger.py", "README.md")
# Adding a launcher at the repo root without listing it above would silently
# ship a package missing it. Check before stopping Ledger or building.
$unlisted = Get-ChildItem -LiteralPath $root -File |
    Where-Object { $_.Extension -in ".ps1", ".cmd" -or $_.Name -eq "run_ledger.py" } |
    Where-Object { $_.Name -notin $rootFiles }
if ($unlisted) {
    throw ("These root scripts are not in the package list, so they would not " +
           "reach the other PC: " + ($unlisted.Name -join ", ") +
           ". Add them to the `$rootFiles list or delete them.")
}
foreach ($required in $rootFiles) {
    if (-not (Test-Path (Join-Path $root $required))) {
        throw "The package needs '$required' at the project root, but it is missing."
    }
}

# The target PC has no npm: it serves the prebuilt bundle. Building here is
# what stops a package shipping yesterday's screens with today's server.
Write-Host "Building the web UI so the package cannot ship a stale screen..." -ForegroundColor Cyan
Push-Location (Join-Path $root "web")
try {
    if (-not (Test-Path "node_modules")) { & npm ci --no-audit --no-fund }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "The web UI build failed, so no package was created." }
} finally {
    Pop-Location
}
if (-not (Test-Path (Join-Path $root "web\dist\index.html"))) {
    throw "The web build produced no dist\index.html."
}

$python = if ($Fresh -or $Update) { $null } else { (Get-Command python -ErrorAction Stop).Source }
try {
    if (-not $Fresh -and -not $Update) {
        # Only a data-carrying package needs the server stopped, so that the
        # database snapshot cannot catch a half-written transaction.
        & (Join-Path $root "stop.ps1")
        if ($LASTEXITCODE -ne 0) {
            throw "Ledger could not be stopped, so this package was not created. Close Ledger and try again."
        }
    }

    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    Copy-Item ($rootFiles | ForEach-Object { Join-Path $root $_ }) -Destination $payload
    Copy-Tree (Join-Path $root "server") (Join-Path $payload "server") @(
        "/XD", "data", "tests", "__pycache__", ".pytest_cache",
        "/XF", "*.pyc", "*.log"
    )
    # Only the built bundle is shipped. The target PC has no Node.js, so
    # sources, configs and package.json there would be unusable weight - and
    # their presence makes start.ps1 try to rebuild and fail.
    Copy-Tree (Join-Path $root "web\dist") (Join-Path $payload "web\dist")

    $payloadData = Join-Path $payload "server\data"
    if (-not $Update) {
        New-Item -ItemType Directory -Path $payloadData -Force | Out-Null
    }
    if (-not $Fresh -and -not $Update) {
        foreach ($directory in @("uploads", "imports")) {
            $sourceDirectory = Join-Path $root "server\data\$directory"
            if (Test-Path $sourceDirectory) {
                Copy-Tree $sourceDirectory (Join-Path $payloadData $directory)
            }
        }
        # Carrying the key forward keeps existing logins valid. A fresh install
        # must NOT have it: it would share a session key with this PC.
        $secret = Join-Path $root "server\data\secret.key"
        if (Test-Path $secret) {
            Copy-Item -LiteralPath $secret -Destination $payloadData
        }
    }

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
    if (-not $Fresh -and -not $Update) {
        $backupCode | & $python - $sourceDb $snapshotDb
        if ($LASTEXITCODE -ne 0) { throw "The database snapshot failed." }
    }

    if ($Update) {
        Copy-Item (Join-Path $setup "Update-Ledger.ps1"),
            (Join-Path $setup "Update-Ledger.cmd") -Destination $stage
    } else {
        Copy-Item (Join-Path $setup "Install-Ledger-New-PC.ps1"),
            (Join-Path $setup "Install-Ledger-New-PC.cmd") -Destination $stage
    }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $output -Force
} finally {
    if (Test-Path $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}

$archive = Get-Item $output
$hash = (Get-FileHash -Algorithm SHA256 $archive.FullName).Hash
$summary = if ($Update) {
@"

Update package created (code only, NO data):
$output

Size: $([math]::Round($archive.Length / 1MB, 1)) MB
SHA-256: $hash

Copy the ZIP to the other PC, extract it, and double-click Update-Ledger.cmd.
That PC keeps its database, uploads and logins; only the program is replaced.
Ledger on THIS PC was not stopped and is unaffected.
"@
} elseif ($Fresh) {
@"

Fresh install package created (NO data):
$output

Size: $([math]::Round($archive.Length / 1MB, 1)) MB
SHA-256: $hash

This ZIP contains no records, no uploads and no login key.
Ledger on THIS PC was not stopped and is unaffected.
On the other PC, extract it and double-click Install-Ledger-New-PC.cmd.
It will ask you to choose a new owner password.
"@
} else {
@"

Transfer package created:
$output

Size: $([math]::Round($archive.Length / 1MB, 1)) MB
SHA-256: $hash

Ledger on this old PC is stopped. Copy the ZIP privately to the new laptop,
extract it, and double-click Install-Ledger-New-PC.cmd.
"@
}
Write-Host $summary -ForegroundColor Green
