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
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={remember}
                   onChange={(e) => setRemember(e.target.checked)} />
            Keep me signed in on this computer
          </label>
          <Button size="lg" className="w-full" disabled={busy || !username || !password}>
            {busy ? "Opening…" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
