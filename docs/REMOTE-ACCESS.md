# Private phone access, without a domain or service subscription

## Recommendation and honest limits

For a small commercial restaurant, use **NetBird Cloud Free + Caddy v2
private HTTPS** on the existing Ledger Windows PC. The phone uses the
NetBird companion app and its ordinary browser. There is no router port
forwarding, public application endpoint, domain purchase, or paid server.

```text
Approved phone -> encrypted NetBird network -> PC's NetBird IP:8443
               -> Caddy (HTTPS) -> 127.0.0.1:8080 (existing Ledger)
```

The stable address is `https://<PC-NetBird-IPv4>:8443`. The private IP is
stable while the peer registration remains in place, not a promise that it
survives deleting/re-enrolling the device. Unlike a public domain certificate,
this route requires **one-time, deliberate trust of a private CA on each
phone**. Do not skip that step or dismiss certificate warnings.

The PC must stay powered on, awake and online, Ledger must run, and the phone
must have connectivity and NetBird enabled. This is not free cloud hosting.
Power, existing internet/mobile data and hardware still cost money. Free
tiers may change, have usage limits, and provide no production uptime SLA.
Ledger's limited offline queue is not a remotely available database while
the PC is off. Backups remain necessary.

## Operator quick path: approved account, restaurant PC, Android + iPhone

**Perform these steps on the restaurant PC, not the development PC.** Use
the already approved dedicated NetBird account; do not create another account
or copy a VPN enrollment, certificate authority or settings from another PC.

1. Transfer the new Ledger ZIP. For an existing restaurant installation, use
   the **Update** ZIP to preserve its records; it contains no database. A new
   PC needs a planned fresh installation or an authorized data transfer,
   not an assumption that an Update ZIP contains the restaurant's records.
   Extract the complete ZIP and run the reviewed `Install-Ledger.ps1` using
   the target's approved installation/signing process.
2. Check the **target PC's** script policy. If signatures are required, have
   its administrator approve/sign the installer and helper. The legacy
   `Install-Ledger.cmd` wrapper specifies an execution-policy bypass: **do not
   use it to work around a signing restriction**. A development machine's
   AllSigned setting does not establish the restaurant PC's policy.
3. On the restaurant PC install the official NetBird client and Caddy v2
   Windows binary; enroll NetBird into the existing dedicated account. Add
   **both** Android and iPhone through their official NetBird apps. Verify
   the account remains on the eligible Free plan, not a paid trial.
4. In that dedicated account, allow only approved phone peers → restaurant
   PC **TCP 8443**; remove broad default access as described below. Keep
   Ledger listening on `127.0.0.1:8080`. Sign in as the Windows user who will
   normally operate Ledger and run:

   ```powershell
   Set-Location "$env:LOCALAPPDATA\Ledger"
   .\setup\Set-LedgerRemoteAccess.ps1
   .\setup\Set-LedgerRemoteAccess.ps1 -Action Prepare -OwnerAuthorized -PolicyRestricted -CaddyPath "C:\Tools\Caddy\caddy.exe"
   .\setup\Set-LedgerRemoteAccess.ps1 -Action Run -OwnerAuthorized -PolicyRestricted
   ```

5. Leave that window running. From a second window in the installed Ledger
   folder, run:

   ```powershell
   .\setup\Set-LedgerRemoteAccess.ps1 -Action ExportCertificate -OwnerAuthorized
   ```

   Privately transfer the exported **public certificate only** to both
   phones. Complete [Android and iPhone trust](#2-trust-https-on-the-owners-phone)
   separately; enable full trust on iPhone. Open the printed HTTPS URL in
   Android Chrome and iPhone Safari, then add Ledger to each home screen.
6. Test **each phone with Wi-Fi off and NetBird on**, then confirm access
   fails with NetBird off. Only after both pass, opt into
   [Windows sign-in startup](#4-optional-startup-and-removal). Keep this PC
   powered, awake, online and signed in. Do not change another PC's services.

NetBird is **not bundled** in the Ledger ZIP. The bootstrap helper downloads
the stock Caddy binary from Caddy's official endpoint only after explicit
owner authorization. Target internet access for approved
installation/enrollment, sufficient Free-plan capacity, permission to install
the VPN/certificate on both phones, a compatible Windows PC, and an approved
narrow firewall allowance (if needed) are prerequisites. The helper never
grants those permissions automatically.

## Eligibility checked against official sources

Checked **9 September 2026**. Confirm the displayed plan and terms yourself
at enrollment; do not convert a trial to a paid plan to follow this guide.

| Option | Published free eligibility | Fit and limitations |
|---|---|---|
| **NetBird Cloud Free** | [Pricing](https://netbird.io/pricing): individuals **or small teams**, €0, up to **5 users / 100 machines**. [Terms](https://netbird.io/terms) explicitly cover business customers and free services; the free network plan is not described as personal/non-commercial-only. | Recommended for a small restaurant within those limits. PC/phone clients, owner account, narrowly scoped access policy, and private browser TLS trust required. Uses the ordinary private network, **not** its hosted Reverse Proxy product. Reconfirm commercial eligibility/limits if the signup terms differ. |
| **Tailscale Personal** | [Pricing FAQ](https://tailscale.com/pricing) explicitly says Personal is **only suitable for non-commercial use**. [Plan documentation](https://tailscale.com/kb/1154/free-plans-discounts) currently lists 6 free users. Business gets a 14-day trial, not permanent free restaurant hosting. | Do not recommend Personal for restaurant records, even with a Gmail login. An open-source app does not turn commercial restaurant operations into an eligible open-source community project. Paid business use, or an explicitly granted eligible plan, is a separate choice. |
| **Cloudflare Zero Trust Free** | [Official Access pricing](https://www.cloudflare.com/zero-trust/products/access/) lists $0, a **50-user limit**, and teams under 50 users / proofs of concept. | Business-capable free option. [Private IP/CIDR routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-cidr/) with the Cloudflare One Client (WARP) does **not require buying/adding a public DNS domain**. Still needs a Zero Trust organization, enrollment, tunnel credentials, narrow Gateway policies and valid HTTPS at the private application. |
| **Twingate Starter** | [Pricing](https://www.twingate.com/pricing): free for personal projects and small startups, up to **5 users / 50 resources**. | Another small-business candidate subject to signup terms. Requires a supported Connector host and phone client; private routing alone does not solve browser certificate trust. Less direct for this existing Windows installation. |
| **Self-hosted WireGuard / NetBird / Headscale** | Open-source software can remove software subscription charges. | Not automatically zero cost: a reachable endpoint, NAT traversal/relay infrastructure, TLS, patches and operations are still needed. No reason to provision a paid VPS just for this restaurant. |

The [NetBird access-control guide](https://docs.netbird.io/manage/access-control/manage-network-access)
warns that its initial **Default All-to-All policy is permissive**. Being on
a private VPN does not, by itself, mean only your phone can reach Ledger.

Cloudflare's [private hostname routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/)
also supports internal names. Do not confuse private routing with a publicly
published tunnel hostname, which normally uses a domain under your control.
A temporary `trycloudflare.com` URL is not a stable private production
deployment. A WARP-encrypted route to `http://...` is still **not browser
HTTPS** and does not solve PWA secure-context requirements.

Repeated Cloudflare login failures are a blocker to resolve with the
account/network administrator, not a reason to disable TLS verification,
change corporate proxy policy, use someone else's credentials or replace an
unrelated `cloudflared` service. This implementation does none of those.

## 1. Owner approval and prerequisites

Only proceed on a **restaurant-owned or explicitly approved PC, account and
network**. Obtain the device/network administrator's approval before VPN
installation, account enrollment, certificate trust, firewall changes or
startup registration. On an employer-managed laptop, stop and ask its IT
owner; owning restaurant records is not permission to change that laptop.
Do not disable another VPN or work around device-management restrictions.

### Fast path for a new restaurant PC

Install or move Ledger to the new PC first. The normal transfer package moves
the database, uploads and Ledger sign-in key together; the fresh-install
package starts a separate empty restaurant. Do not copy only `ledger.db`, and
do not run two PCs against the same SQLite file.

Then run:

```powershell
.\setup\Set-LedgerRemoteAccess.ps1 -Action Setup -OwnerAuthorized
```

Setup is the guided path and the one to use unless you have a reason not to.
It runs the steps below in order: it verifies Ledger's loopback service,
installs the stock Caddy Windows amd64 binary and, if NetBird is absent,
downloads NetBird's own official Windows installer and runs its normal wizard
(Windows will ask for administrator approval). It then launches NetBird's
browser sign-in only when needed, **pauses** and prints the exact NetBird
access policy to create, and continues only after you type `YES`. Finally it
prepares the config, starts the private proxy, exports the certificate for
the phone and registers the sign-in task.

That pause is not decoration. A phone that reaches the address but times out
is almost always missing a NetBird policy permitting it; nothing on the PC
can detect or fix that.

The individual actions remain available for anyone who wants to run them one
at a time, and each still enforces its own approval gates:

```powershell
.\setup\Set-LedgerRemoteAccess.ps1 -Action Bootstrap -OwnerAuthorized
```

Bootstrap checks Ledger's loopback service, downloads the stock Caddy Windows
amd64 binary into `%LOCALAPPDATA%\Ledger\tools`, and launches NetBird's normal
browser sign-in flow only when it is needed. It **does not** start a proxy,
create a firewall rule, trust a certificate, alter another VPN/service, or
make Ledger reachable. If NetBird is absent, it opens NetBird's official
Windows install page and stops: Windows requires the device owner's normal
approved administrator installation process.

After the account owner has enrolled the PC and made the policy narrow, run
Prepare and Run below. NetBird account sign-in, access-policy approval and
certificate trust remain deliberate human-owned boundaries; a script cannot
safely infer them.

1. Keep the existing Ledger installation listening on **127.0.0.1:8080**.
   Start it using its normal installed launcher. Do not run another copy from
   a download folder, change its database, enable `-Lan`, or bind to
   `0.0.0.0`. For Docker, keep host publishing on `127.0.0.1:8080`.
2. If bootstrap could not find it, install the official [NetBird Windows client](https://docs.netbird.io/get-started/install/windows)
   and the official Android/iOS client. The owner enrolls both through its UI
   into the **same restaurant-controlled account** with MFA where supported.
   Bootstrap can run `netbird up`, but never asks for a setup key or reads
   tokens.
   If NetBird is already enrolled elsewhere, do not repurpose it without its
   owner's authorization.
3. In NetBird, create a `Ledger-PC` group containing only this PC and an
   `Owner-Phones` group containing only approved phones. Allow **unidirectional
   TCP 8443**, source `Owner-Phones`, destination `Ledger-PC`. Remove/disable
   the initial Default All-to-All policy **only in a dedicated network you
   own**, and check that no other policy still grants broad access. In a
   shared network ask its administrator to restrict access without breaking
   others. Do not create subnet routes, exit nodes, public proxies or shares.
4. Bootstrap obtains the stock official [Caddy v2 Windows binary](https://caddyserver.com/download).
   If your organization requires a separate software approval process,
   obtain it there instead, verify its release provenance/checksum, and keep it at a stable
   owner-controlled location such as `C:\Tools\Caddy\caddy.exe`. No plugins,
   Node.js, OpenSSL package, Docker VM or new Python environment are needed.
5. Keep the helper at a stable approved location. Newly generated install,
   update and transfer ZIPs include `setup\Set-LedgerRemoteAccess.ps1`,
   `setup\Test-LedgerRemoteAccess.ps1`,
   `setup\Restore-LedgerBackup.ps1` and this guide. The installer copies
   them into `%LOCALAPPDATA%\Ledger`, including on updates; it never enables
   remote access automatically. Older ZIPs do not contain these files.
   Alternatively, copy those three files to an approved stable location
   without reinstalling Ledger. Packaging copies only these explicit code/doc
   files, never `%LOCALAPPDATA%\LedgerRemote`, VPN state, CA keys or tokens.

Commands below assume you are in the installed Ledger folder
(`Set-Location "$env:LOCALAPPDATA\Ledger"`) or the checkout root. Run Prepare,
Run, certificate export and startup registration as the **same Windows
user**, because state and startup are per-user. A successful bootstrap stores
Caddy at `%LOCALAPPDATA%\Ledger\tools\caddy.exe`, so Prepare then needs no
`-CaddyPath`. Respect local PowerShell
signing policy: if execution is blocked, have IT review/sign the helper
through its approved process. **Do not change execution policy or use
`-ExecutionPolicy Bypass`.** Diagnostics can identify prerequisites, but
cannot approve a device, validate your account plan or audit cloud policies.

```powershell
# Read-only: installed tools, this PC's NetBird address, loopback listener.
.\setup\Set-LedgerRemoteAccess.ps1

# Only after the NetBird policy is narrowed to approved devices.
.\setup\Set-LedgerRemoteAccess.ps1 -Action Prepare `
    -OwnerAuthorized -PolicyRestricted

# Starts only this isolated HTTPS proxy in the foreground. Ctrl+C stops it.
.\setup\Set-LedgerRemoteAccess.ps1 -Action Run -OwnerAuthorized -PolicyRestricted
```

`-PolicyRestricted` is your explicit acknowledgement, **not** an automated
proof that NetBird policies are safe. `-LedgerPort` and `-HttpsPort` can be
set during Prepare if needed; match the latter in your approved access policy.
The helper verifies the selected address belongs to NetBird and is assigned
to this PC, not a LAN or public address. Nonstandard NetBird address ranges
are deliberately unsupported; this recipe accepts only `100.64.0.0/10`.

Preparation is repeatable: identical configuration is left alone. To change
ports/address, stop your Ledger proxy first and Prepare again. Existing
unmanaged configurations/tasks cause a refusal rather than being overwritten.
The helper stores only its config, executable path and private CA under
`%LOCALAPPDATA%\LedgerRemote`, with access restricted to the current user
and SYSTEM. It does not read or copy Ledger records, credentials or keys.
Do not share that folder: it contains the **private CA key**.

Caddy binds **only the NetBird IPv4**, disables HTTP redirect listeners,
disables its administrative API and automatic trust installation, and
proxies only to loopback. It does not replace another Caddy configuration.
See Caddy's [local HTTPS/trust documentation](https://caddyserver.com/docs/automatic-https#local-https)
and [global options](https://caddyserver.com/docs/caddyfile/options).

## 2. Trust HTTPS on the owner's phone

After the foreground proxy has started, open a second PowerShell window:

```powershell
.\setup\Set-LedgerRemoteAccess.ps1 -Action ExportCertificate -OwnerAuthorized
```

This exports **only the public CA** to
`%LOCALAPPDATA%\LedgerRemote\ledger-root.cer` and prints its SHA-256
fingerprint. Transfer that file privately (for example, an owner-controlled
cable/file transfer). Verify its fingerprint using an independent trusted
channel. Never transfer `*.key`, the `storage` directory or a backup of it.

- **iPhone/iPad:** install the certificate profile through Settings, then
  enable full trust for this specific root under
  **General → About → Certificate Trust Settings**. Apple documents the
  [manual trust step](https://support.apple.com/en-us/102390).
- **Android:** use **Security → Encryption & credentials → Install a
  certificate → CA certificate**, or the equivalent manufacturer menu.
  Google describes [install/remove certificates](https://support.google.com/pixelphone/answer/2844832).
  Chrome must trust the installed root; managed devices/browsers can forbid
  user-added roots. A native app may have a different trust policy.

Installing a CA grants it authority to authenticate sites on that phone,
not just this application. Only trust a root generated on your own secured
PC; protect its private key, and remove that root from the phone when
retiring the setup. A compromised PC/CA requires revoking that trust and
re-enrolling with a new CA. The helper never adds a root to any trust store.

Connect NetBird on the phone. Open the **exact HTTPS URL printed by Prepare**.
There must be **no certificate warning**, and Ledger must show its normal
sign-in screen. Sign in with the existing Ledger account, not a new default
password. Use **Add to Home Screen** after the certificate is trusted.

## 3. Verify before relying on it

1. On restaurant Wi-Fi, test the phone URL and existing Ledger sign-in.
2. Turn **phone Wi-Fi off**, leave NetBird connected, and test again over
   mobile data. A local PC health check is not proof of anywhere access.
3. Disconnect NetBird on the phone: the private endpoint must be unreachable.
   A cached home-screen shell can still appear; it must not retrieve fresh
   data. Check from an unenrolled/unapproved device too.
4. Confirm the PC is **not listening on 0.0.0.0/[::]:8080** or a public/LAN
   HTTPS interface. Do not open a router port or approve a broad Windows
   Firewall prompt to fix a failed test.
5. If Windows Firewall blocks the VPN connection, have its administrator
   permit only the approved Caddy executable, PC's NetBird IP, chosen TCP
   port and approved phones' NetBird source IPs. Keep other interfaces blocked.
   The helper intentionally does not create firewall rules.
6. On a trusted PC, this validates the certificate chain without disabling
   verification (replace the example address with yours):

   ```powershell
   curl.exe --cacert "$env:LOCALAPPDATA\LedgerRemote\storage\pki\authorities\local\root.crt" `
       "https://100.64.0.9:8443/api/health"
   ```

   Expect Ledger's healthy response. This certificate-authorized local test
   does not replace the external phone test.

## 4. Optional startup and removal

After the phone tests pass, keep the helper and Caddy at their prepared
locations. Stop the foreground proxy with Ctrl+C, then explicitly opt in:

```powershell
.\setup\Set-LedgerRemoteAccess.ps1 -Action EnableStartup -OwnerAuthorized -PolicyRestricted
```

This registers **Ledger Private HTTPS** for the current user's Windows
sign-in, without an account password or administrator privileges. It does
not start the task immediately. Start that named task through Task Scheduler
after approval, or sign out/in. Verify it is running and repeat the phone
test. Existing Ledger startup and NetBird's own service must also be working.
The task retries failed startup five times, one minute apart, to accommodate
normal startup ordering; it is not an unlimited watchdog. After prolonged
loss of NetBird/changes of IP, resolve the cause and restart the task.
No automatic access exists before this user signs in.

To remove only this helper's startup task and stop that task's proxy:

```powershell
.\setup\Set-LedgerRemoteAccess.ps1 -Action DisableStartup -OwnerAuthorized
```

Stop any manually launched proxy with Ctrl+C separately. Remove this CA from
the phone's trusted certificates and remove only this restaurant's peer
enrollment/access rules when retiring access. Delete `%LOCALAPPDATA%\LedgerRemote`
only when no proxy is using it and you intend to retire its CA. Never delete
another application's VPN account, tunnel, service or credentials.

## Troubleshooting and safe checks

| Symptom | Safe next step |
|---|---|
| NetBird missing or not enrolled | Owner installs/signs in via its UI. No setup key is requested or printed by this helper. |
| Corporate login/TLS/certificate failure | Stop; contact the network/account administrator. No certificate-verification disabling or proxy bypass. |
| Port 8080 absent | Start the **already installed** Ledger. This helper does not start a second database. |
| Backend listens beyond loopback | Stop that owner-managed instance, remove its `-Lan`/host override, restart normally. No listener is killed automatically. |
| Proxy address changed | Stop the proxy; confirm the actual peer identity, update narrow policy if needed, Prepare again, use its new URL. |
| Port 8443 already in use | Identify its owner; stop only your own Ledger proxy, or choose another approved port. Never kill by process name. |
| Certificate warning | Check URL, device clock, exact public CA/fingerprint and phone trust. Never click through it. |
| PC reachable locally but not by phone | Check enrollment, VPN connection, narrow policy and approved firewall rule. Wi-Fi-off testing is essential. |
| Scheduled task exits | Confirm approved script signature, stable paths, NetBird connection and existing Ledger loopback listener; run the helper in the foreground for its error. |
| Free limit or eligibility changed | Stop and reassess with the owner. No automatic upgrade, paid trial or billing enrollment. |

An isolated, dependency-free developer check is available:

```powershell
.\setup\Test-LedgerRemoteAccess.ps1
```

It checks parsing, input validation, private-only config, authorization,
loopback guards and task ownership using simulated listeners. It never
enrolls devices, changes listeners/firewalls/tasks, installs trust, or
accesses a database. Execute only under your approved script-signing policy.
