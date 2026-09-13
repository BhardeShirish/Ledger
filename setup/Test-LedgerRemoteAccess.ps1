# Dependency-free checks: no account, listener, database, certificate or task changes.
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "Set-LedgerRemoteAccess.ps1"
$tokens = $null
$errors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
. $script

function Assert-Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

foreach ($address in @("100.64.0.1", "100.127.255.254")) {
    Assert-Check (Test-LedgerPrivateAddress $address) "Valid private address rejected: $address"
}
Assert-Check ((ConvertTo-LedgerNetBirdAddress "100.64.0.9/16") -eq "100.64.0.9") "NetBird CIDR address was not normalized"
foreach ($address in @("", "0.0.0.0", "127.0.0.1", "192.168.1.1", "::", "100.63.255.255",
                       "100.128.0.0", "100.64.0.1`nadmin off", "100.64.000.1")) {
    Assert-Check (-not (Test-LedgerPrivateAddress $address)) "Unsafe address accepted: $address"
}
foreach ($address in @("100.64.0.9/abc", "100.64.0.9/128", "100.64.0.9/16/extra")) {
    $rejected = $false
    try { $null = ConvertTo-LedgerNetBirdAddress $address } catch { $rejected = $true }
    Assert-Check $rejected "Unsafe NetBird CIDR address accepted: $address"
}
$config = New-LedgerProxyConfig "100.64.0.9" 8080 8443
foreach ($line in @("admin off", "persist_config off", "auto_https disable_redirects", "skip_install_trust",
                    'storage file_system "{$LEDGER_REMOTE_STORAGE}"', "https://100.64.0.9:8443",
                    "bind 100.64.0.9", "tls internal", "protocols h1 h2", "reverse_proxy 127.0.0.1:8080")) {
    Assert-Check ($config.Contains($line)) "Missing safety setting: $line"
}
Assert-Check (-not $config.Contains("0.0.0.0")) "Wildcard listener generated"
foreach ($ports in @(@(0, 8443), @(8080, 65536))) {
    $rejected = $false
    try { $null = New-LedgerProxyConfig "100.64.0.9" $ports[0] $ports[1] } catch { $rejected = $true }
    Assert-Check $rejected "Invalid port accepted"
}

# Shadow OS inspection functions so checks cannot query the live application.
function Get-NetTCPConnection { return $script:listeners }
$script:listeners = @([pscustomobject]@{ LocalAddress = "127.0.0.1" })
Assert-LedgerLoopback 8080
foreach ($listeners in @(@(), @([pscustomobject]@{ LocalAddress = "0.0.0.0" }),
                         @([pscustomobject]@{ LocalAddress = "127.0.0.1" }, [pscustomobject]@{ LocalAddress = "::" }))) {
    $script:listeners = $listeners
    $rejected = $false
    try { Assert-LedgerLoopback 8080 } catch { $rejected = $true }
    Assert-Check $rejected "Missing or exposed backend was accepted"
}
$task = [pscustomobject]@{
    Principal = [pscustomobject]@{ UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
    Actions = @([pscustomobject]@{
    Execute = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    Arguments = Get-LedgerStartupArguments
}) }
Assert-LedgerTaskOwnership $task
$task.Actions[0].Arguments = "-File unrelated.ps1"
$rejected = $false
try { Assert-LedgerTaskOwnership $task } catch { $rejected = $true }
Assert-Check $rejected "Unrelated startup task accepted"
$task.Actions[0].Arguments = Get-LedgerStartupArguments
$task.Principal.UserId = "S-1-5-18"
$rejected = $false
try { Assert-LedgerTaskOwnership $task } catch { $rejected = $true }
Assert-Check $rejected "Another user's startup task accepted"

foreach ($action in @("Setup", "Bootstrap", "Prepare", "Run", "EnableStartup", "DisableStartup", "ExportCertificate")) {
    $rejected = $false
    try { & $script -Action $action } catch { $rejected = $_.Exception.Message -like "No changes made.*" }
    Assert-Check $rejected "$action did not require explicit owner approval"
}
foreach ($action in @("Prepare", "Run", "EnableStartup")) {
    $rejected = $false
    try { & $script -Action $action -OwnerAuthorized } catch {
        $rejected = $_.Exception.Message -like "No changes made. Restrict NetBird policy*"
    }
    Assert-Check $rejected "$action did not require a restricted-policy acknowledgement"
}
Write-Host "Remote access self-check passed: parsing, address/port validation, private TLS config, loopback guard, task ownership, authorization."
