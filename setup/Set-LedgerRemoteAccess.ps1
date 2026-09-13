<#
.SYNOPSIS
    Opt-in private HTTPS over an owner-managed NetBird network.
.DESCRIPTION
    Diagnose is read-only. Bootstrap installs Caddy from its official source
    and launches the normal NetBird sign-in flow, but never starts exposure.
    Other actions require -OwnerAuthorized. This script never changes VPN
    policy, opens a firewall, trusts a certificate, or touches an existing
    cloudflared/Caddy service.
    Read docs\REMOTE-ACCESS.md before authorizing changes.
#>
[CmdletBinding()]
param(
    [ValidateSet("Diagnose", "Setup", "Bootstrap", "Prepare", "Run", "EnableStartup", "DisableStartup", "ExportCertificate")]
    [string]$Action = "Diagnose",
    [switch]$OwnerAuthorized,
    [switch]$PolicyRestricted,
    [string]$PrivateAddress,
    [ValidateRange(1, 65535)][int]$LedgerPort = 8080,
    [ValidateRange(1, 65535)][int]$HttpsPort = 8443,
    [string]$CaddyPath
)

$ErrorActionPreference = "Stop"
$state = Join-Path $env:LOCALAPPDATA "LedgerRemote"
$configPath = Join-Path $state "Caddyfile"
$settingsPath = Join-Path $state "settings.json"
$taskName = "Ledger Private HTTPS"
$scriptPath = $PSCommandPath
$managedCaddyPath = Join-Path $env:LOCALAPPDATA "Ledger\tools\caddy.exe"

function Test-LedgerPrivateAddress([string]$Address) {
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($Address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $parsed.ToString() -ne $Address) { return $false }
    $bytes = $parsed.GetAddressBytes()
    return $bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127
}

function ConvertTo-LedgerNetBirdAddress([string]$Address) {
    # NetBird reports its peer address as CIDR (for example 100.64.0.9/16).
    # The Caddy listener needs the address alone, never the CIDR suffix.
    if ($Address -notmatch '^(?<address>\d+\.\d+\.\d+\.\d+)(?:/\d{1,2})?$' -or
        -not (Test-LedgerPrivateAddress $Matches.address)) {
        throw "NetBird returned an invalid or unsupported private IPv4 address."
    }
    return $Matches.address
}

function New-LedgerProxyConfig([string]$Address, [int]$BackendPort, [int]$TlsPort) {
    if (-not (Test-LedgerPrivateAddress $Address)) { throw "Expected a NetBird IPv4 address in 100.64.0.0/10." }
    if ($BackendPort -lt 1 -or $BackendPort -gt 65535 -or $TlsPort -lt 1 -or $TlsPort -gt 65535) {
        throw "Ports must be between 1 and 65535."
    }
    @"
# Managed by Ledger Set-LedgerRemoteAccess.ps1
{
    admin off
    persist_config off
    auto_https disable_redirects
    skip_install_trust
    servers {
        protocols h1 h2
    }
    storage file_system "{`$LEDGER_REMOTE_STORAGE}"
}
https://${Address}:$TlsPort {
    bind $Address
    tls internal
    reverse_proxy 127.0.0.1:$BackendPort
}
"@
}

function Install-LedgerNetBird {
    $existing = Find-LedgerRemoteTool "netbird" ""
    if ($existing) {
        Write-Host "NetBird: already available at $existing"
        return $existing
    }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
        Start-Process "https://docs.netbird.io/get-started/install/windows"
        throw "Windows curl is unavailable. Install NetBird from the page just opened, then run Setup again."
    }
    $installer = Join-Path $env:TEMP ("netbird-" + [Guid]::NewGuid().ToString("N") + ".exe")
    try {
        # NetBird's own package endpoint; it redirects to the signed release
        # asset on GitHub. No third-party mirror is involved.
        & $curl.Source --fail --silent --show-error --location `
            "https://pkgs.netbird.io/windows/x64" --output $installer
        if ($LASTEXITCODE -ne 0) { throw "The official NetBird download failed." }
        if ((Get-Item -LiteralPath $installer).Length -lt 1MB) {
            throw "The NetBird download is unexpectedly small; it was not run."
        }
        Write-Host ""
        Write-Host "Installing NetBird. Approve the Windows prompt and accept its defaults." -ForegroundColor Cyan
        Write-Host "SHA-256: $((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash)"
        # Run the wizard rather than guessing a silent switch: an installer
        # invoked with the wrong flags can succeed loudly and install nothing.
        $process = Start-Process -FilePath $installer -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "The NetBird installer exited with code $($process.ExitCode). Nothing else was changed."
        }
    } finally {
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    }
    # A fresh install lands in Program Files, which this session's PATH
    # predates; Find-LedgerRemoteTool checks that location directly.
    $installed = Find-LedgerRemoteTool "netbird" ""
    if (-not $installed) {
        throw "NetBird still cannot be found after installation. Close this window, open a new one, and run Setup again."
    }
    Write-Host "NetBird installed at $installed"
    return $installed
}

function Find-LedgerRemoteTool([string]$Name, [string]$ExplicitPath) {
    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) -or
            [IO.Path]::GetExtension($ExplicitPath) -ne ".exe") {
            throw "Expected an installed Windows executable, not a directory or script."
        }
        return (Get-Item -LiteralPath $ExplicitPath -ErrorAction Stop).FullName
    }
    $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    if ($Name -eq "caddy" -and (Test-Path -LiteralPath $managedCaddyPath -PathType Leaf)) {
        return $managedCaddyPath
    }
    $standard = Join-Path $env:ProgramFiles "$Name\$Name.exe"
    if (Test-Path -LiteralPath $standard) { return $standard }
    return $null
}

function Install-LedgerCaddy {
    $existing = Find-LedgerRemoteTool "caddy" ""
    if ($existing) {
        & $existing version *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Caddy: already available at $existing"
            return $existing
        }
        throw "Caddy exists at '$existing' but cannot run. Replace it through the approved software process."
    }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
        throw "Windows curl is unavailable. Download the official Caddy Windows amd64 binary, then run Prepare with -CaddyPath."
    }
    $tools = Split-Path -Parent $managedCaddyPath
    $temporary = Join-Path $tools ("caddy-" + [Guid]::NewGuid().ToString("N") + ".download")
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    try {
        # Caddy's own endpoint selects the stock Windows amd64 build: no plugins.
        & $curl.Source --fail --silent --show-error --location `
            "https://caddyserver.com/api/download?os=windows&arch=amd64" `
            --output $temporary
        if ($LASTEXITCODE -ne 0) { throw "The official Caddy download failed." }
        if ((Get-Item -LiteralPath $temporary).Length -lt 1MB) {
            throw "The Caddy download is unexpectedly small; it was not installed."
        }
        Move-Item -LiteralPath $temporary -Destination $managedCaddyPath -Force
        & $managedCaddyPath version
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $managedCaddyPath -Force -ErrorAction SilentlyContinue
            throw "Downloaded Caddy could not run and was removed."
        }
        Write-Host "Caddy installed at $managedCaddyPath"
        Write-Host "SHA-256: $((Get-FileHash -LiteralPath $managedCaddyPath -Algorithm SHA256).Hash)"
        return $managedCaddyPath
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Connect-LedgerNetBird {
    $tool = Find-LedgerRemoteTool "netbird" ""
    if (-not $tool) {
        Start-Process "https://docs.netbird.io/get-started/install/windows"
        throw "NetBird is not installed. Its official Windows installation page was opened; install it through the approved Windows process, then run Bootstrap again."
    }
    try { return Get-LedgerNetBirdAddress } catch { }
    Write-Host "NetBird needs account sign-in. Complete the browser flow it opens now." -ForegroundColor Cyan
    & $tool up
    if ($LASTEXITCODE -ne 0) { throw "NetBird sign-in did not complete. No proxy was prepared or started." }
    return Get-LedgerNetBirdAddress
}

function Get-LedgerNetBirdAddress {
    $tool = Find-LedgerRemoteTool "netbird" ""
    if (-not $tool) { throw "NetBird is missing. Ask the device/network owner to install it; see docs\REMOTE-ACCESS.md." }
    # Only request this device's address, never full peer/account status or keys.
    $reported = ((& $tool status --ipv4 2>$null) -join "").Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "NetBird is not enrolled/connected, or has no supported IPv4. Owner must sign in through its UI; do not retry corporate TLS/auth failures here."
    }
    try { $address = ConvertTo-LedgerNetBirdAddress $reported }
    catch { throw "NetBird is not enrolled/connected, or has no supported IPv4. Owner must sign in through its UI; do not retry corporate TLS/auth failures here." }
    $assigned = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $address -ErrorAction SilentlyContinue
    if (-not $assigned) { throw "NetBird reports an address not assigned to this PC. Reconnect through the owner-approved NetBird UI." }
    return $address
}

function Assert-LedgerLoopback([int]$Port) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }) {
        throw "Port $Port is listening beyond loopback. Stop that owner-managed Ledger instance and restart without -Lan/LEDGER_HOST overrides; no listener was changed."
    }
    if (-not ($listeners | Where-Object LocalAddress -eq "127.0.0.1")) {
        throw "Nothing listens on 127.0.0.1:$Port. Start the existing Ledger installation first; this script never launches a second database."
    }
}

function Get-LedgerRemoteSettings {
    if (-not (Test-Path -LiteralPath $settingsPath)) { throw "Run Prepare after owner authorization first." }
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if (-not (Test-LedgerPrivateAddress $settings.address) -or
        $settings.ledgerPort -lt 1 -or $settings.ledgerPort -gt 65535 -or
        $settings.httpsPort -lt 1 -or $settings.httpsPort -gt 65535 -or
        -not (Test-Path -LiteralPath $settings.caddy -PathType Leaf)) {
        throw "Stored settings are invalid or Caddy has moved. Run Prepare again."
    }
    return $settings
}

function Get-LedgerStartupArguments {
    return "-NoProfile -NonInteractive -File `"$scriptPath`" -Action Run -OwnerAuthorized -PolicyRestricted"
}

function Assert-LedgerTaskOwnership($Task) {
    if ($Task -and ($Task.Actions.Count -ne 1 -or
        $Task.Actions[0].Arguments -ne (Get-LedgerStartupArguments) -or
        $Task.Actions[0].Execute -ne "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe")) {
        throw "A different task already uses '$taskName'. It was not changed. Ask its owner to resolve the name conflict."
    }
    if ($Task) {
        $owner = $Task.Principal.UserId
        $current = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($owner -ne $current.Name -and $owner -ne $current.User.Value) {
            throw "The '$taskName' task belongs to another user. It was not changed."
        }
    }
}

# Permit the dependency-free self-check to load pure functions without actions.
if ($MyInvocation.InvocationName -eq ".") { return }

if ($Action -ne "Diagnose" -and -not $OwnerAuthorized) {
    throw "No changes made. Read docs\REMOTE-ACCESS.md, obtain device/network owner approval, then explicitly pass -OwnerAuthorized."
}
if ($Action -in @("Prepare", "Run", "EnableStartup") -and -not $PolicyRestricted) {
    throw "No changes made. Restrict NetBird policy to approved phone(s) -> this PC TCP/$HttpsPort first, then acknowledge with -PolicyRestricted."
}

if ($Action -eq "Diagnose") {
    Write-Host "Read-only checks; no account login, database access or network changes."
    foreach ($name in @("netbird", "caddy")) {
        $found = Find-LedgerRemoteTool $name $(if ($name -eq "caddy") { $CaddyPath } else { "" })
        Write-Host "${name}: $(if ($found) { 'installed' } else { 'missing; owner installation required' })"
    }
    try { Write-Host "NetBird IPv4: $(Get-LedgerNetBirdAddress)" } catch { Write-Warning $_.Exception.Message }
    try { Assert-LedgerLoopback $LedgerPort; Write-Host "Loopback backend port: ready (application identity not checked)" }
    catch { Write-Warning $_.Exception.Message }
    Write-Host "Configuration prepared: $(Test-Path -LiteralPath $settingsPath)"
    Write-Host ""
    Write-Host "Next step: .\setup\Set-LedgerRemoteAccess.ps1 -Action Setup -OwnerAuthorized" -ForegroundColor Cyan
    Write-Host "It installs anything missing above, then walks you through the rest."
    Write-Host "Phone trust, narrow access policy and external reachability require the owner's checks in docs\REMOTE-ACCESS.md."
    return
}

if ($Action -eq "Setup") {
    # One guided run through Bootstrap -> Prepare -> Run -> ExportCertificate
    # -> EnableStartup. The individual actions still exist and still enforce
    # their own gates; this only removes the chance of doing them out of
    # order, which is how a half-configured proxy ends up unreachable from
    # the phone with nothing to show for it.
    Write-Host "Ledger private remote access - guided setup" -ForegroundColor Cyan
    Write-Host "Nothing is exposed to the internet. Access stays inside your NetBird network."
    Write-Host ""

    Write-Host "[1/6] Checking that Ledger is running on this PC..."
    Assert-LedgerLoopback $LedgerPort
    Write-Host "      OK - Ledger answers on 127.0.0.1:$LedgerPort"

    Write-Host "[2/6] Caddy (the HTTPS front door)..."
    $null = Install-LedgerCaddy

    Write-Host "[3/6] NetBird (the private network)..."
    $null = Install-LedgerNetBird
    $address = Connect-LedgerNetBird
    Write-Host "      This PC's private address: $address"

    Write-Host ""
    Write-Host "[4/6] Now restrict who may reach it." -ForegroundColor Yellow
    Write-Host "      In the NetBird dashboard (app.netbird.io):"
    Write-Host "        a. Peers - confirm this PC and your phone are both listed and Connected."
    Write-Host "        b. Access Control - add a policy allowing ONLY your phone"
    Write-Host "           to reach this PC on TCP port $HttpsPort."
    Write-Host "        c. If a default 'Allow All' policy exists, disable it."
    Write-Host ""
    Write-Host "      This step is why a phone times out: without a policy that"
    Write-Host "      permits it, NetBird silently drops the connection."
    $answer = Read-Host "      Type YES once that policy is saved (anything else stops here)"
    if ($answer -ne "YES") {
        Write-Host "Stopped. Nothing was prepared, started or registered." -ForegroundColor Yellow
        return
    }

    Write-Host "[5/6] Preparing and starting the private HTTPS proxy..."
    # Prepare throws on any problem, which aborts this run; no exit code to test.
    & $scriptPath -Action Prepare -OwnerAuthorized -PolicyRestricted `
        -LedgerPort $LedgerPort -HttpsPort $HttpsPort -CaddyPath $CaddyPath

    $running = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue |
        Where-Object State -eq "Running"
    if (-not $running) {
        Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -ArgumentList "-NoProfile -File `"$scriptPath`" -Action Run -OwnerAuthorized -PolicyRestricted -LedgerPort $LedgerPort -HttpsPort $HttpsPort"
    }
    # The certificate only exists once Caddy has generated it.
    $root = Join-Path $state "storage\pki\authorities\local\root.crt"
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path -LiteralPath $root) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
    }
    if (-not (Test-Path -LiteralPath $root)) {
        throw "The proxy did not produce a certificate within a minute. Check Task Scheduler for 'Ledger Private HTTPS' and verify that its action belongs to this Ledger installation."
    }
    & $scriptPath -Action ExportCertificate -OwnerAuthorized

    Write-Host "[6/6] Starting the proxy automatically at sign-in..."
    & $scriptPath -Action EnableStartup -OwnerAuthorized -PolicyRestricted `
        -LedgerPort $LedgerPort -HttpsPort $HttpsPort

    Write-Host ""
    Write-Host "Done. On your phone, in this order:" -ForegroundColor Green
    Write-Host "  1. Install NetBird from the Play Store and sign in to the SAME account."
    Write-Host "  2. Copy $((Join-Path $state 'ledger-root.cer')) to the phone privately."
    Write-Host "  3. Android: Settings - Security - Encryption & credentials -"
    Write-Host "     Install a certificate - CA certificate. Accept the warning."
    Write-Host "  4. With NetBird connected, open:  https://${address}:$HttpsPort"
    Write-Host ""
    Write-Host "If the phone still times out, the NetBird access policy in step 4"
    Write-Host "is the thing to re-check first. Nothing on this PC is exposed publicly."
    return
}

if ($Action -eq "Bootstrap") {
    Assert-LedgerLoopback $LedgerPort
    $caddy = Install-LedgerCaddy
    $address = Connect-LedgerNetBird
    Write-Host ""
    Write-Host "Ready to prepare private HTTPS: $address" -ForegroundColor Green
    Write-Host "Before continuing, restrict NetBird to approved devices -> this PC TCP/$HttpsPort."
    Write-Host "Then run: Set-LedgerRemoteAccess.ps1 -Action Prepare -OwnerAuthorized -PolicyRestricted"
    Write-Host "No proxy, firewall rule, certificate trust, public URL or scheduled task was created."
    return
}

if ($Action -eq "Prepare") {
    $address = Get-LedgerNetBirdAddress
    if ($PrivateAddress -and $PrivateAddress -ne $address) { throw "Requested address is not this PC's NetBird address." }
    Assert-LedgerLoopback $LedgerPort
    $caddy = Find-LedgerRemoteTool "caddy" $CaddyPath
    if (-not $caddy) { throw "Caddy is missing. Install an official Caddy v2 binary after owner approval; see docs\REMOTE-ACCESS.md." }
    $config = New-LedgerProxyConfig $address $LedgerPort $HttpsPort
    if ((Test-Path -LiteralPath $settingsPath) -and (Test-Path -LiteralPath $configPath)) {
        $existing = $null
        try { $existing = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json } catch { }
        if ($existing.address -eq $address -and $existing.ledgerPort -eq $LedgerPort -and
            $existing.httpsPort -eq $HttpsPort -and $existing.caddy -eq $caddy -and
            (Get-Content -LiteralPath $configPath -Raw).Trim() -eq $config.Trim()) {
            Write-Host "Already prepared: https://${address}:$HttpsPort. No changes made."
            return
        }
    }
    if (Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue |
        Where-Object State -eq "Running") { throw "Stop the Ledger Private HTTPS task before preparing changes." }
    if (Get-NetTCPConnection -State Listen -LocalPort $HttpsPort -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @($address, "0.0.0.0", "::") }) {
        throw "HTTPS port $HttpsPort is already in use. Stop only your Ledger proxy or choose another approved port."
    }
    if ((Test-Path -LiteralPath $configPath) -and
        -not (Get-Content -LiteralPath $configPath -TotalCount 1).StartsWith("# Managed by Ledger Set-LedgerRemoteAccess.ps1")) {
        throw "An unmanaged Caddyfile exists in $state. It was not overwritten."
    }
    if ((Test-Path -LiteralPath $state) -and -not (Test-Path -LiteralPath $configPath) -and
        (Get-ChildItem -LiteralPath $state -Force | Select-Object -First 1)) {
        throw "The state directory already contains unmanaged files. Nothing was changed."
    }
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,
                       [Security.Principal.SecurityIdentifier]::new("S-1-5-18"))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"))
    }
    Set-Acl -LiteralPath $state -AclObject $acl
    Set-Content -LiteralPath $configPath -Value $config -Encoding ASCII
    @{ address = $address; ledgerPort = $LedgerPort; httpsPort = $HttpsPort; caddy = $caddy } |
        ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Write-Host "Prepared private HTTPS at https://${address}:$HttpsPort. No proxy was started."
    Write-Host "Run with -Action Run -OwnerAuthorized -PolicyRestricted, then export/trust only the public CA certificate."
    return
}

if ($Action -eq "ExportCertificate") {
    $root = Join-Path $state "storage\pki\authorities\local\root.crt"
    if (-not (Test-Path -LiteralPath $root)) { throw "CA certificate not present. Start the prepared proxy first." }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($root)
    $publicPath = Join-Path $state "ledger-root.cer"
    [IO.File]::WriteAllBytes($publicPath, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    Write-Host "Public certificate ONLY: $publicPath"
    Write-Host "SHA-256 file fingerprint: $((Get-FileHash -LiteralPath $publicPath -Algorithm SHA256).Hash)"
    Write-Host "Nothing was trusted automatically. Transfer privately and verify this fingerprint; never transfer storage or *.key."
    return
}

if ($Action -in @("EnableStartup", "DisableStartup")) {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue
    Assert-LedgerTaskOwnership $task
    if ($Action -eq "DisableStartup") {
        if ($task) {
            Stop-ScheduledTask -TaskName $taskName -TaskPath "\"
            Unregister-ScheduledTask -TaskName $taskName -TaskPath "\" -Confirm:$false
        }
        Write-Host "Ledger HTTPS startup removed. NetBird, Ledger, certificates and all other services are unchanged."
        return
    }
    $null = Get-LedgerRemoteSettings
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $actionDefinition = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument (Get-LedgerStartupArguments)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $options = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -TaskPath "\" -Action $actionDefinition -Trigger $trigger -Settings $options -Principal $principal -Force | Out-Null
    Write-Host "Registered '$taskName' for this user's next sign-in, without stored credentials. It was not started."
    return
}

$settings = Get-LedgerRemoteSettings
$address = Get-LedgerNetBirdAddress
if ($address -ne $settings.address) { throw "NetBird address changed. Stop the Ledger proxy, update the narrow policy if necessary, then run Prepare again." }
Assert-LedgerLoopback $settings.ledgerPort
$expected = New-LedgerProxyConfig $address $settings.ledgerPort $settings.httpsPort
if (-not (Test-Path -LiteralPath $configPath) -or
    (Get-Content -LiteralPath $configPath -Raw).Trim() -ne $expected.Trim()) {
    throw "Caddyfile differs from the private-only configuration. Run Prepare to restore it; arbitrary configurations are not run."
}
Write-Host "Serving https://${address}:$($settings.httpsPort). Keep this window open; Ctrl+C stops ONLY this proxy."
Write-Host "First run: use ExportCertificate in another window and follow phone trust instructions."
$previousStorage = $env:LEDGER_REMOTE_STORAGE
try {
    # Caddy's quoted config values need slash-separated paths, unlike PowerShell.
    $env:LEDGER_REMOTE_STORAGE = (Join-Path $state "storage").Replace("\", "/")
    & $settings.caddy run --config $configPath --adapter caddyfile
    if ($LASTEXITCODE -ne 0) { throw "Caddy exited with code $LASTEXITCODE. Check the displayed error; no TLS checks or firewall rules were bypassed." }
} finally {
    $env:LEDGER_REMOTE_STORAGE = $previousStorage
}
