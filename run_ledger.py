import os
import sys
import traceback
from datetime import datetime
from pathlib import Path


def resolve_binding(argv, env):
    """Work out the address to listen on.

    Loopback by default: a ledger should never become reachable by accident.
    Set LEDGER_HOST=0.0.0.0 deliberately to reach it from a phone.

    The installer passes --host/--port on the command line instead, because a
    scheduled task does not inherit environment variables set after logon.
    """
    def argument(name, fallback):
        flag = f"--{name}"
        if flag in argv and argv.index(flag) + 1 < len(argv):
            return argv[argv.index(flag) + 1]
        return fallback

    host = argument("host", env.get("LEDGER_HOST", "127.0.0.1")).strip() or "127.0.0.1"
    raw_port = argument("port", env.get("LEDGER_PORT", "8080"))
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        raise SystemExit("The port must be a number, e.g. LEDGER_PORT=8080")
    return host, port


def main():
    root = Path(__file__).resolve().parent
    server = root / "server"
    data = server / "data"
    data.mkdir(parents=True, exist_ok=True)

    os.chdir(server)
    sys.path.insert(0, str(server))
    os.environ["LEDGER_WEB_DIST"] = str(root / "web" / "dist")
    os.environ["LEDGER_DATA_DIR"] = str(data)

    pid_file = data / "server.pid"
    stdout = (data / "uvicorn.log").open("a", encoding="utf-8", buffering=1)
    stderr = (data / "uvicorn-error.log").open("a", encoding="utf-8", buffering=1)
    sys.stdout = stdout
    sys.stderr = stderr
    pid_file.write_text(str(os.getpid()), encoding="ascii")

    try:
        # Imported only after the log files exist. A scheduled task has no
        # console, so anything raised before this point would vanish.
        import uvicorn

        host, port = resolve_binding(sys.argv, os.environ)
        if host not in ("127.0.0.1", "localhost", "::1"):
            stderr.write(
                f"[ledger] listening on {host}:{port} - reachable from other "
                "devices. Use a private network (Tailscale) rather than an "
                "untrusted Wi-Fi, and keep a strong owner password.\n")
            stderr.flush()
        uvicorn.run("app.main:app", host=host, port=port)
    except BaseException:
        stderr.write("\n--- Ledger failed to start (%s) ---\n"
                     % datetime.now().isoformat(timespec="seconds"))
        stderr.write("python: %s\n" % sys.executable)
        traceback.print_exc(file=stderr)
        stderr.flush()
        raise
    finally:
        if pid_file.exists() and pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
            pid_file.unlink()
        stdout.close()
        stderr.close()


if __name__ == "__main__":
    main()
