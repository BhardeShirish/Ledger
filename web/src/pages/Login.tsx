import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { Button, ErrorNote, Field, Input } from "../components/ui";
import { useMoney } from "../lib/money";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [done, setDone] = useState("");
  const nav = useNavigate();
  const { setMe } = useAuth();
  const { config } = useMoney();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await api.post("/auth/login", { username, password, remember });
      setMe(r.user);
      nav("/", { replace: true });
    } catch (ex: any) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper-2 p-4">
      <div className="w-full max-w-sm rounded-xl border border-rule-strong bg-paper p-8 shadow-sheet">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-accent">
          The Counter Book
        </div>
        <h1 className="text-2xl font-semibold">{config.restaurant_name}</h1>
        <p className="mt-1 text-sm text-ink-faint">
          Sales, staff and every rupee — in one register.
        </p>
        {recovering ? (
          <ForgotPassword
            username={username}
            onCancel={() => setRecovering(false)}
            onDone={(name) => {
              setRecovering(false);
              setUsername(name);
              setPassword("");
              setErr("");
              setDone("Password changed. Sign in with it now.");
            }}
          />
        ) : (
          <>
            <form onSubmit={submit} className="mt-6 space-y-3">
              <Field label="Username">
                <Input autoFocus autoComplete="username" value={username}
                       onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label="Password">
                <Input type="password" autoComplete="current-password" value={password}
                       onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <ErrorNote msg={err} />
              {done && <p className="text-sm text-ink-soft">{done}</p>}
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" checked={remember}
                       onChange={(e) => setRemember(e.target.checked)} />
                Keep me signed in on this computer
              </label>
              <Button size="lg" className="w-full" disabled={busy || !username || !password}>
                {busy ? "Opening…" : "Sign in"}
              </Button>
            </form>
            <button type="button"
                    className="mt-4 text-sm text-ink-faint underline underline-offset-4 hover:text-ink"
                    onClick={() => { setDone(""); setErr(""); setRecovering(true); }}>
              Forgot password?
            </button>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * Recovery without an email server.
 *
 * The code is written to a file on the Ledger PC and never sent to the
 * browser, so this screen can only be completed by someone who can reach
 * that machine. Said plainly on screen, because a person who has just been
 * locked out of their own books deserves to know why they are being sent to
 * a folder rather than to their inbox.
 */
function ForgotPassword({ username, onCancel, onDone }: {
  username: string;
  onCancel: () => void;
  onDone: (username: string) => void;
}) {
  const [name, setName] = useState(username || "owner");
  const [file, setFile] = useState("");
  const [minutes, setMinutes] = useState(0);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const requestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await api.post("/auth/forgot", { username: name });
      setFile(r.file);
      setMinutes(r.expires_minutes);
    } catch (ex: any) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api.post("/auth/reset", { username: name, code, new_password: password });
      onDone(name.trim().toLowerCase());
    } catch (ex: any) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  };

  if (!file) {
    return (
      <form onSubmit={requestCode} className="mt-6 space-y-3">
        <h2 className="text-sm font-semibold">Forgot password</h2>
        <p className="text-sm text-ink-faint">
          There is no email here — your books live on your own PC. Ledger will
          write a one-time code into a file on that PC, and you type it back in.
          Anyone who cannot open that folder cannot reset your password.
        </p>
        <Field label="Username">
          <Input autoFocus autoComplete="username" value={name}
                 onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorNote msg={err} />
        <Button size="lg" className="w-full" disabled={busy || !name.trim()}>
          {busy ? "Writing the code…" : "Write my reset code"}
        </Button>
        <button type="button" onClick={onCancel}
                className="w-full text-sm text-ink-faint underline underline-offset-4 hover:text-ink">
          Back to sign in
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={finish} className="mt-6 space-y-3">
      <h2 className="text-sm font-semibold">Enter the code</h2>
      <p className="text-sm text-ink-faint">
        On the PC that runs Ledger, open this file and copy the code from it.
        It is valid for {minutes} minutes.
      </p>
      <p className="select-all break-all rounded-lg border border-rule bg-paper-2 px-3 py-2 font-mono text-xs text-ink-soft">
        {file}
      </p>
      <Field label="Reset code">
        <Input autoFocus value={code} spellCheck={false}
               placeholder="XXXX-XXXX-XXXX"
               onChange={(e) => setCode(e.target.value.toUpperCase())} />
      </Field>
      <Field label="New password">
        <Input type="password" autoComplete="new-password" value={password}
               onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <p className="text-xs text-ink-faint">
        At least 12 characters. Everyone signed in elsewhere will be signed out.
      </p>
      <ErrorNote msg={err} />
      <Button size="lg" className="w-full"
              disabled={busy || !code.trim() || password.length < 12}>
        {busy ? "Changing…" : "Set new password"}
      </Button>
      <button type="button" onClick={onCancel}
              className="w-full text-sm text-ink-faint underline underline-offset-4 hover:text-ink">
        Back to sign in
      </button>
    </form>
  );
}
