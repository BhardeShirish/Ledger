# PyInstaller spec for the standalone Windows build.
#
#   python -m PyInstaller packaging/ledger.spec --noconfirm
#
# Build the web bundle first (npm run build in web/) - this only packages it.

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = [("../web/dist", "web/dist")]
hiddenimports = ["app.main"]
binaries = []

# Windows has no IANA timezone database, so zoneinfo cannot resolve
# Asia/Kolkata. app/util.py builds a ZoneInfo at import time, which means a
# build without these data files does not merely lose timezone support - it
# will not start at all.
for pkg in ("tzdata",):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# uvicorn picks its event loop and HTTP protocol by importing them at run
# time from strings, so static analysis alone leaves them out.
hiddenimports += collect_submodules("uvicorn")

a = Analysis(
    ["ledger_desktop.py"],
    pathex=["../server"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=["tkinter", "pytest", "playwright"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="OotaaLedger",
    console=True,          # the window is how you stop it, and where errors show
    disable_windowed_traceback=False,
    upx=False,
    strip=False,
    bootloader_ignore_signals=False,
    runtime_tmpdir=None,
    icon=None,
)
