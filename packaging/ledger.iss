; Installer for Ootaa Ledger.
;
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" packaging\ledger.iss
;
; Build the executable first (see packaging/ledger.spec) - this only wraps it.
;
; PrivilegesRequired=lowest is deliberate. A shop computer is often used by
; someone without an administrator password, and asking for one turns a
; double-click into a dead end. Installing under the user's own profile needs
; no permission from anybody and shows no UAC prompt.

#define AppName "Ootaa Ledger"
#define AppExe "OotaaLedger.exe"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{7B1F5C42-9D3E-4A17-8C6B-2E0A9F4D51C8}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Ootaa Ledger
AppSupportURL=https://github.com/OWNER/REPO
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist-exe
OutputBaseFilename=OotaaLedger-Setup
SetupIconFile=ledger.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Ledger holds its own program file open while it is running, so an upgrade
; over a running copy would otherwise fail with a locked-file error that
; means nothing to the person reading it.
;
; force, not yes: Ledger is a console server with no message loop, so the
; Restart Manager cannot ask it politely to quit and setup gives up instead
; (it exits with code 5, "cancelled" - measured, not guessed). Terminating it
; is safe because that is also what closing its window does, and SQLite's
; write-ahead log is crash-safe.
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Put a Ledger shortcut on my desktop"; GroupDescription: "Shortcuts:"
Name: "startupicon"; Description: "Start Ledger automatically when I sign in"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist-exe\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

; Created now so the Start Menu shortcut to it is not broken before the
; first run.
[Dirs]
Name: "{localappdata}\OotaaLedger\data"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Where my records are kept"; Filename: "{localappdata}\OotaaLedger\data"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startupicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent

[Messages]
; Said on the last page, because the single most common fear about a
; bookkeeping program is that removing it throws the books away.
FinishedLabel=Ledger is installed.%n%nThe first time it starts it will ask you to choose an owner password. Your records are kept in your own user folder, separately from the program, so updating or removing Ledger never touches them.

[Code]
{ The uninstaller deletes the program, never the books. Say so plainly, and
  say where they are, so nobody goes looking for them afterwards.

  SuppressibleMsgBox rather than MsgBox: a plain message box ignores
  /SUPPRESSMSGBOXES and leaves an unattended uninstall waiting forever on a
  dialog nobody can see. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('Ledger has been removed.'#13#10#13#10
           + 'Your records have been left untouched in:'#13#10
           + ExpandConstant('{localappdata}\OotaaLedger\data') + #13#10#13#10
           + 'Delete that folder yourself if you really want them gone.',
           mbInformation, MB_OK, IDOK);
end;
