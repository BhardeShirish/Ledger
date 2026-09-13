<#
.SYNOPSIS
    Restores a Ledger recovery ZIP after the application data is lost.
.DESCRIPTION
    Run only from an installed Ledger folder. The script accepts database,
    receipt and signing-key files from a Ledger backup, validates the archive
    and database first, preserves any current data, then restarts Ledger.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BackupPath,
    [switch]$OwnerAuthorized,
    [switch]$ConfirmRestore
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root "server\data"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$documents = [Environment]::GetFolderPath("MyDocuments")
$preserved = Join-Path $documents "Ledger Backups\before-restore-$stamp"
$stage = Join-Path $root ".restore-$stamp"

function Assert-LedgerArchive([System.IO.Compression.ZipArchive]$Archive) {
    $names = @($Archive.Entries | Where-Object { -not $_.FullName.EndsWith("/") } |
        ForEach-Object FullName)
    if ($names -notcontains "ledger.db") {
        throw "This ZIP does not contain a Ledger database (ledger.db). Nothing was restored."
    }
    foreach ($name in $names) {
        if (($name -split "/") -contains ".." -or ($name -split "/") -contains ".") {
            throw "Unsafe path in backup ZIP. Nothing was restored."
        }
        if ($name -notmatch '^(ledger\.db|secret\.key|README\.txt|uploads/[^/]+(?:/[^/]+)*)$') {
            throw "This ZIP contains an unsupported file ('$name'). Nothing was restored."
        }
    }
}

function Expand-LedgerArchive([System.IO.Compression.ZipArchive]$Archive, [string]$Destination) {
    $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar) +
        [IO.Path]::DirectorySeparatorChar
    foreach ($entry in $Archive.Entries) {
        if ($entry.FullName.EndsWith("/")) { continue }
        $relative = $entry.FullName.Replace("/", [IO.Path]::DirectorySeparatorChar)
        $output = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
        if (-not $output.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe path in backup ZIP. Nothing was restored."
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $output, $true)
    }
}

function Test-LedgerDatabase([string]$Path) {
    $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if (-not $python) { $python = (Get-Command python -ErrorAction SilentlyContinue).Source }
    if (-not $python) { throw "Python is required to validate the backup, but was not found." }
    $check = @'
import sqlite3, sys
connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("database integrity check failed")
finally:
    connection.close()
'@
    $check | & $python - $Path
    if ($LASTEXITCODE -ne 0) { throw "The backup database failed its integrity check. Nothing was restored." }
}

if (-not $OwnerAuthorized -or -not $ConfirmRestore) {
    throw "Restoring replaces Ledger data. Re-run only as the owner with -OwnerAuthorized -ConfirmRestore."
}
if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $root) "Install-Ledger.cmd") -PathType Leaf) {
    throw "This is an extracted setup package. Install Ledger first, then run this script from the installed Ledger folder."
}
if (-not (Test-Path -LiteralPath (Join-Path $root "run_ledger.py") -PathType Leaf)) {
    throw "Run this from the installed Ledger folder after reinstalling it. Do not restore into an extracted ZIP."
}
if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf) -or
    [IO.Path]::GetExtension($BackupPath) -ne ".zip") {
    throw "Choose an existing Ledger backup ZIP."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Get-Item -LiteralPath $BackupPath).FullName)
try {
    Assert-LedgerArchive $archive
    $restoreData = Join-Path $stage "data"
    Expand-LedgerArchive $archive $restoreData
} finally {
    $archive.Dispose()
}
try {
    Test-LedgerDatabase (Join-Path $stage "data\ledger.db")
    & (Join-Path $root "stop.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Ledger could not be stopped. Nothing was restored." }
    $movedCurrent = $false
    $restored = $false
    if (Test-Path -LiteralPath $data) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $preserved) -Force | Out-Null
        Move-Item -LiteralPath $data -Destination $preserved
        $movedCurrent = $true
    }
    Move-Item -LiteralPath (Join-Path $stage "data") -Destination $data
    $restored = $true
    Write-Host "Recovered Ledger data from $(Split-Path -Leaf $BackupPath)." -ForegroundColor Green
    if (Test-Path -LiteralPath $preserved) {
        Write-Host "The previous data was kept at $preserved" -ForegroundColor Yellow
    }
    & (Join-Path $root "start.ps1") -NoBrowser
    if ($LASTEXITCODE -ne 0) {
        throw "Recovery data was restored, but Ledger did not restart. Check server\data\uvicorn-error.log."
    }
} catch {
    if ($movedCurrent -and -not $restored -and
        -not (Test-Path -LiteralPath $data) -and (Test-Path -LiteralPath $preserved)) {
        Move-Item -LiteralPath $preserved -Destination $data
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
