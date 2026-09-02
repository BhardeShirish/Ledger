import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "../api/client";
import { Button, ErrorNote, Field, Input, Sheet } from "../components/ui";
import { setOutboxIdentity } from "./outbox";

export type Me = {
  id: number;
  username: string;
  full_name: string;
  role: "owner" | "manager";
  outlet_ids: number[];
  elevated_until: string | null;
};

type StepUpFn = () => Promise<boolean>;

const AuthCtx = createContext<{
  me: Me | null;
  ready: boolean;
  offline: boolean;
  setMe: (m: Me | null) => void;
  refresh: () => Promise<void>;
  requireStepUp: StepUpFn;
}>(null as any);

export const useAuth = () => useContext(AuthCtx);

/** Last known identity, so the app can open without a network.
 *
 * This only decides what the CLIENT renders. Every API call is still
 * authorised by the server against the real session cookie, so a stale copy
 * here can never grant access to data. */
const ME_CACHE = "ledger_me";

function readCachedMe(): Me | null {
  try {
    const raw = localStorage.getItem(ME_CACHE);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

export function clearCachedMe() {
  localStorage.removeItem(ME_CACHE);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpResolve, setStepUpResolve] = useState<((v: boolean) => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.get("/auth/me");
      localStorage.setItem(ME_CACHE, JSON.stringify(fresh));
      setMe(fresh);
      setOffline(false);
    } catch (e: any) {
      // "I cannot reach the server" is not "you are signed out". Treating them
      // alike sent a phone with no signal to the login screen — precisely when
      // the offline queue is the point of opening the app.
      if (e?.status === 0) {
        const cached = readCachedMe();
        setMe(cached);
        setOffline(cached !== null);
      } else {
        clearCachedMe();
        setMe(null);
        setOffline(false);
      }
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setOutboxIdentity(me?.id ?? null);
  }, [me?.id]);
  useEffect(() => {
    const expire = () => { clearCachedMe(); setMe(null); setOffline(false); };
    window.addEventListener("ledger:session-expired", expire);
    return () => window.removeEventListener("ledger:session-expired", expire);
  }, []);

  // Coming back online must re-check the session, or the app would keep
  // trusting a cached identity after the session was revoked.
  useEffect(() => {
    const back = () => { void refresh(); };
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, [refresh]);

  const requireStepUp = useCallback<StepUpFn>(() => {
    return new Promise((resolve) => {
      setStepUpResolve(() => resolve);
      setStepUpOpen(true);
    });
  }, []);

  return (
    <AuthCtx.Provider value={{ me, ready, offline, setMe, refresh, requireStepUp }}>
      {children}
      {stepUpOpen && (
        <StepUpModal
          onClose={(ok) => {
            setStepUpOpen(false);
            if (ok) void refresh();
            stepUpResolve?.(ok);
          }}
        />
      )}
    </AuthCtx.Provider>
  );
}

function StepUpModal({ onClose }: { onClose: (ok: boolean) => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pw) return;
    setBusy(true);
    setErr("");
    try {
      await api.post("/auth/stepup", { password: pw });
      onClose(true);
    } catch (e: any) {
      setErr(e.message || "Wrong password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={() => onClose(false)} title="Owner confirmation">
      <div>
        <div className="label-caps mb-1">Owner confirmation</div>
        <h2 className="text-lg font-semibold leading-tight">Enter your password to continue</h2>
        <p className="mt-1 text-sm text-ink-soft">
          This action touches salary or old records, so we verify it's really you.
        </p>
        <Field label="Password" className="mt-4">
          <Input autoFocus type="password" value={pw}
                 onChange={(e) => setPw(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        <div className="mt-2"><ErrorNote msg={err} /></div>
        <div className="mt-4 flex gap-2 justify-end">
          <Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button>
          <Button disabled={busy || !pw} onClick={submit}>
            {busy ? "Checking…" : "Confirm"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Helper hook for mutations that may need elevation on 403/428. */
export function useGuarded() {
  const { me, requireStepUp } = useAuth();
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if ((e?.status === 428 || e?.status === 403) && me?.role === "owner") {
        const ok = await requireStepUp();
        if (ok) return fn();
        // The owner deliberately cancelled, so don't also shout an error
        // toast at them. Every other 403 still surfaces.
        e.handled = true;
      }
      throw e;
    }
  };
}
