# Installing and operating Ledger

This guide covers installation, updates, data ownership, recovery, private
access, and local development. See the [README](../README.md) for a short
product overview and [FEATURES.md](FEATURES.md) for the complete feature list.

## Windows

### New installation

1. Download the repository with **Code → Download ZIP** or pull the latest
   `main` branch.
2. Extract the ZIP with Windows **Extract All**.
3. Open the extracted Ledger folder and double-click
   `setup\Install-Ledger.cmd`.

Alternatively, download the `Ledger-Fresh-Install` artifact from the latest
successful [Build Windows install package workflow](../.github/workflows/build-windows-install.yml)
run. Extract it, then double-click its top-level `Install-Ledger.cmd`.

The installer checks that Windows is 64-bit, Python is available or
installable, disk space and write access are sufficient, and port 8080 is
free. It creates an owner login on a fresh installation, starts Ledger after
verifying it responds, and opens the browser.

### Daily use, update, and removal

| Task | Run |
|---|---|
| Start Ledger | `Start-Ledger.cmd` |
| Stop Ledger | `Stop-Ledger.cmd` |
| Install or update | `Install-Ledger.cmd` |
| Build a package for another PC | `setup\Create-Package.cmd` |
| Erase all local Ledger data | `setup\Remove-Ledger-Data.cmd` |

Updates preserve records, uploads, and logins. The installer takes a verified
database backup before replacing the program and retains the prior program
copy for rollback.

Installed records live in `%LOCALAPPDATA%\Ledger\server\data`, separate from
the program. When Ledger runs directly from a source folder, records live in
that folder's `server\data`.

### Move Ledger to another Windows PC

On the working computer, run `setup\Create-Package.cmd` and choose **3**, then
transfer the resulting `Ledger-New-PC.zip` privately. Extract it completely on
the new computer and run the top-level `Install-Ledger.cmd`.

Use the `-Fresh` package option when the new computer must start with no
records. Do not keep entering records on both PCs after a transfer: Ledger does
not synchronize two independent databases.

## Docker

Docker needs no Python, Node, or build tools:

```bash
docker run -d --name ledger -p 127.0.0.1:8080:8080 \
  -v ledger-data:/data \
  -e LEDGER_OWNER_PASSWORD='choose-a-long-password' \
  --restart unless-stopped \
  ghcr.io/bhardeshirish/ledger:latest
```

The image supports `linux/amd64` and `linux/arm64`, including common Linux,
NAS, Raspberry Pi, and Apple Silicon environments. Records live in the
`ledger-data` volume, not in the image, so replacing the image does not change
the records.

To build locally instead:

```bash
cp .env.example .env
docker compose up -d
```

Set `LEDGER_OWNER_PASSWORD` in `.env` before starting Compose.

For an offline target computer, save and carry the image:

```bash
docker save ghcr.io/bhardeshirish/ledger:latest | gzip > ledger-image.tar.gz
gunzip -c ledger-image.tar.gz | docker load
```

Then use the normal `docker run` command. To copy Docker data out:

```bash
docker cp ledger:/data ./ledger-backup
```

## Backups and recovery

Windows creates a verified full recovery ZIP on first start and daily
thereafter in `%USERPROFILE%\Documents\Ledger Backups`. The newest 30 daily
copies are retained. Each archive contains the database, receipt uploads, and
the session-signing key.

Use **Settings → Data safety** to see or change the recovery folder. A
restaurant-controlled Google Drive for desktop folder can be used as an
external recovery location; Ledger writes files there but never receives a
Google password, token, or API key. Enable MFA and verify that Drive finishes
syncing after the first backup.

To restore a Windows recovery archive:

```powershell
Set-Location "$env:LOCALAPPDATA\Ledger"
.\setup\Restore-LedgerBackup.ps1 `
  -BackupPath "$env:USERPROFILE\Documents\Ledger Backups\ledger-recovery-YYYY-MM-DD.zip" `
  -OwnerAuthorized -ConfirmRestore
```

The helper validates the archive and SQLite database, preserves current data
in a pre-restore backup, then restores and starts Ledger. Do not unzip an
archive over a running data folder.

Recovery archives protect against accidental application-folder deletion, not
theft, disk failure, fire, ransomware, or deletion of the entire user profile.
Keep an occasional encrypted copy on a separate device you control.

## Phone and private remote access

Ledger is responsive and can be installed to a phone home screen. For safe
access outside the restaurant, use the [private-access guide](REMOTE-ACCESS.md).
It explains the recommended NetBird and Caddy setup, HTTPS, approved-device
policy, and alternatives.

Do not expose port 8080 to the public internet, forward router ports, use
plain HTTP on a cafe network, or bypass browser certificate warnings.

When a connection drops, selected sales, expense, and attendance entries can
queue on the device and replay safely when it reconnects. Reports are
deliberately not served from stale offline data.

## Security and data controls

- Managers cannot view salaries, payroll, or advances.
- Editing an older record requires the owner's live password.
- Signing out immediately revokes the database-backed session.
- Cookies have CSRF protections and repeated bad passwords are rate-limited.
- Ledger keeps an append-only audit history.
- Ledger binds to `127.0.0.1` unless configured otherwise.

Report a security issue privately through a GitHub security advisory, not a
public issue.

## Development

```bash
cd server && python -m pip install -r requirements.txt -r requirements-dev.txt
export LEDGER_OWNER_PASSWORD='choose-a-strong-password'
uvicorn app.main:app --reload --port 8000
cd ../web && npm install && npm run dev
```

Before opening a pull request, run:

```bash
(cd server && python -m pytest -q)
(cd web && npx vitest run && npx tsc --noEmit && npx eslint src)
```

When adding a queued offline write, prove its endpoint is idempotent with a
test before adding it to `OFFLINE_OK` in `web/src/api/client.ts`.
