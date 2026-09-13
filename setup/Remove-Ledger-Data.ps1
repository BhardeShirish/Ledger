<#
.SYNOPSIS
    Removes all Ledger-owned records and local setup from this PC.
.DESCRIPTION
    Keeps the downloaded Ledger folder intact so it can be installed again.
    This cannot be undone. It does not uninstall NetBird or Caddy.
#>
[CmdletBinding()]
param(
    [switch]$ConfirmRemoveAllLedgerData,
    [string]$RecoveryDirectory
)

$ErrorActionPreference = "Stop"

function Get-ExistingDirectories([string[]]$Paths) {
    @($Paths | Where-Object {
        $_ -and (Test-Path -LiteralPath $_ -PathType Container)
    } | Select-Object -Unique)
}

function Get-SafeRecoveryDirectory([string]$Path) {
    if (-not $Path) { return $null }
    try {
        $full = [IO.Path]::GetFullPath($Path)
        if ($full -eq [IO.Path]::GetPathRoot($full)) { return $null }
        return $full
    } catch {
        return $null
    }
}

function Stop-AndRemove-LedgerTask([string]$Name, [string[]]$ExpectedPaths) {
    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return }
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task) { return }

    $definition = ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join "`n"
    $isOwned = $ExpectedPaths | Where-Object {
        $_ -and $definition -match [regex]::Escape($_)
    } | Select-Object -First 1
    if (-not $isOwned) {
        Write-Warning "Did not remove '$Name': it is not a Ledger task created by this installer."
        return
    }

    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $current = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if (-not $current -or $current.State -ne "Running") { break }
        Start-Sleep -Seconds 1
    }
    if ((Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue).State -eq "Running") {
        throw "Ledger task '$Name' did not stop. Restart Windows and run this command again."
    }
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
}

function Remove-LedgerRecoveryArtifacts([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
    Get-ChildItem -LiteralPath $Directory -File -ErrorAction Stop |
        Where-Object {
            $_.Name -like "ledger-recovery-*.zip" -or
            $_.Name -like ".ledger-recovery-*.db.partial"
        } |
        Remove-Item -Force
    Get-ChildItem -LiteralPath $Directory -Directory -Filter "before-restore-*" -ErrorAction Stop |
        Remove-Item -Recurse -Force
    if (-not (Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop |
              Select-Object -First 1)) {
        Remove-Item -LiteralPath $Directory -Force
    }
}

$defaultTarget = Join-Path $env:LOCALAPPDATA "Ledger"
$legacyTarget = Join-Path $env:LOCALAPPDATA "Ootaa Ledger"
$targets = @($defaultTarget, $legacyTarget)
if ($env:LEDGER_HOME) { $targets += $env:LEDGER_HOME }
$targets = @($targets | Select-Object -Unique)
$oldCopies = @()
foreach ($target in $targets) {
    $parent = Split-Path -Parent $target
    $leaf = Split-Path -Leaf $target
    if (Test-Path -LiteralPath $parent -PathType Container) {
        $oldCopies += Get-ChildItem -LiteralPath $parent -Directory -ErrorAction Stop |
            Where-Object { $_.Name -like "$leaf.previous-*" -or $_.Name -like "$leaf.before-update-*" } |
            Select-Object -ExpandProperty FullName
    }
}
$installFolders = Get-ExistingDirectories ($targets + $oldCopies)

$appData = if ($env:APPDATA) { $env:APPDATA } else { [Environment]::GetFolderPath("ApplicationData") }
$recoveryLocationFile = Join-Path $appData "Ledger\recovery-location.txt"
$recoveryDirectories = @()
if ($RecoveryDirectory) {
    $recoveryDirectories += Get-SafeRecoveryDirectory $RecoveryDirectory
} elseif ($env:LEDGER_RECOVERY_DIR) {
    $recoveryDirectories += Get-SafeRecoveryDirectory $env:LEDGER_RECOVERY_DIR
} else {
    $recoveryDirectories += Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Ledger Backups"
}
if (Test-Path -LiteralPath $recoveryLocationFile -PathType Leaf) {
    $recoveryDirectories += Get-SafeRecoveryDirectory (Get-Content -LiteralPath $recoveryLocationFile -Raw).Trim()
}
$recoveryDirectories = Get-ExistingDirectories $recoveryDirectories
$remoteState = Join-Path $env:LOCALAPPDATA "LedgerRemote"

Write-Host ""
Write-Host "Remove all Ledger data from this PC" -ForegroundColor Red
Write-Host ""
Write-Host "This permanently removes:" -ForegroundColor Yellow
if ($installFolders) { $installFolders | ForEach-Object { Write-Host "  - $($_)" } }
else { Write-Host "  - no installed Ledger folders were found" }
if ($recoveryDirectories) { $recoveryDirectories | ForEach-Object { Write-Host "  - Ledger recovery archives in $($_)" } }
if (Test-Path -LiteralPath $remoteState) { Write-Host "  - $remoteState" }
Write-Host "  - Ledger startup tasks and legacy desktop shortcuts"
Write-Host ""
Write-Host "It keeps this downloaded Ledger folder so you can install it again."
Write-Host "It does not uninstall NetBird, Caddy, or delete unrelated files in a custom backup folder."
Write-Host ""

if (-not $ConfirmRemoveAllLedgerData) {
    if ((Read-Host "Type ERASE to permanently remove this Ledger data") -ne "ERASE") {
        throw "Cancelled. Nothing was removed."
    }
}

$serverEntrypoints = $targets | ForEach-Object { Join-Path $_ "run_ledger.py" }
$remoteEntrypoints = $targets | ForEach-Object {
    Join-Path $_ "setup\Set-LedgerRemoteAccess.ps1"
}
Stop-AndRemove-LedgerTask "Ledger Server" $serverEntrypoints
Stop-AndRemove-LedgerTask "Ootaa Ledger Server" $serverEntrypoints
Stop-AndRemove-LedgerTask "Ledger Private HTTPS" $remoteEntrypoints

foreach ($target in $targets) {
    $stop = Join-Path $target "stop.ps1"
    if (Test-Path -LiteralPath $stop -PathType Leaf) {
        & $stop
        if ($LASTEXITCODE -ne 0) { throw "Ledger at '$target' could not be stopped." }
    }
}

foreach ($folder in $installFolders) {
    Remove-Item -LiteralPath $folder -Recurse -Force
}
foreach ($directory in $recoveryDirectories) {
    Remove-LedgerRecoveryArtifacts $directory
}
if (Test-Path -LiteralPath $recoveryLocationFile -PathType Leaf) {
    Remove-Item -LiteralPath $recoveryLocationFile -Force
}
if (Test-Path -LiteralPath $remoteState -PathType Container) {
    Remove-Item -LiteralPath $remoteState -Recurse -Force
}

$desktops = @([Environment]::GetFolderPath("Desktop"),
              (Join-Path $env:USERPROFILE "Desktop"),
              $(if ($env:OneDrive) { Join-Path $env:OneDrive "Desktop" })) |
            Where-Object { $_ } | Select-Object -Unique
foreach ($desktop in $desktops) {
    foreach ($name in @("Ootaa Ledger.url", "Ootaa Ledger.lnk",
                        "Ootaa Ledger (local).lnk", "START Ootaa Ledger.cmd")) {
        $shortcut = Join-Path $desktop $name
        if (Test-Path -LiteralPath $shortcut -PathType Leaf) {
            Remove-Item -LiteralPath $shortcut -Force
        }
    }
}

Write-Host ""
Write-Host "All Ledger data and local setup found on this PC were removed." -ForegroundColor Green
Write-Host "Run setup\Install-Ledger.cmd to start again with an empty Ledger." -ForegroundColor Green
