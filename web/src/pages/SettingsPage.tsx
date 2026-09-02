import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import { Download, Lock, ShieldCheck, UserPlus } from "lucide-react";
import { api, downloadFile } from "../api/client";
import { useAuth, useGuarded } from "../lib/auth";
import { useMoney } from "../lib/money";
import { DOW_LABELS } from "../lib/format";
import {
  Badge, Button, Card, ErrorNote, Field, Input, SectionLabel, Select,
  Sheet, Spinner,
} from "../components/ui";

export default function SettingsPage() {
  const { me } = useAuth();
  const { pathname } = useLocation();
  if (me?.role !== "owner") {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <ShieldCheck className="mx-auto text-ink-faint" size={28} />
        <h1 className="mt-2 font-semibold">Owner area</h1>
        <p className="text-sm text-ink-faint">Settings are only visible to you-know-who.</p>
      </Card>
    );
  }
  const sub = pathname.split("/")[2] || "";
  if (sub === "account") return <AccountPage />;
  return (
    <div className="space-y-5">
      <header>
        <SectionLabel>Settings</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">House rules</h1>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <RulesCard />
        <DivisorCard />
        <MoneyCard />
        <OcrCard />
        <ChannelsCard />
        <UsersCard />
        <OutletsCard />
        <AuditCard />
        <BackupCard />
      </div>
    </div>
  );
}

const OCR_PRESETS = [
  { name: "Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  { name: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { name: "Groq", base: "https://api.groq.com/openai/v1", model: "llama-3.2-90b-vision-preview" },
  { name: "Ollama (local)", base: "http://localhost:11434/v1", model: "qwen2.5vl:7b" },
];

function OcrCard() {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const st = useQuery({ queryKey: ["ocr-status"], queryFn: () => api.get("/ocr/status") });
  const [f, setF] = useState<any>(null);
  const [key, setKey] = useState("");
  const [ping, setPing] = useState<any>(null);
  const [models, setModels] = useState<string[]>([]);

  const saveConfig = () => guarded(() => api.put("/ocr/config", {
    enabled: cfg.enabled ?? true, provider: cfg.provider ?? "openai_compat",
    base_url: cfg.base_url ?? "", model: cfg.model ?? "",
    api_key: key || undefined,
  })).then(() => { setKey(""); qc.invalidateQueries({ queryKey: ["ocr-status"] }); });

  const save = useMutation({ mutationFn: saveConfig,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ocr-status"] }) });

  const test = useMutation({
    mutationFn: async () => {
      await saveConfig();                       // typed key must be saved to be used
      return guarded(() => api.get("/ocr/ping"));
    },
    onSuccess: (r) => {
      setPing(r);
      const list: string[] = r.models ?? [];
      if (list.length) {
        setModels(list);
        setF((x: any) => ({
          ...(x ?? {}), base_url: r.savedBase ?? x?.base_url ?? cfg.base_url,
          model: (!x?.model || !list.includes(x.model))
            ? (list.find((m) => m.includes("flash")) ?? list[0])
            : x.model,
          enabled: true, provider: "openai_compat",
        }));
      }
    },
    onError: (e: any) => setPing({ ok: false, error: e.message }),
  });

  const stData = st.data;
  const cfg = f ?? {
    enabled: stData?.enabled ?? false,
    provider: stData?.provider ?? "openai_compat",
    base_url: "", model: stData?.model ?? "",
  };
  const configured = st.data?.configured;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <SectionLabel>Bill photo OCR</SectionLabel>
        <Badge tone={configured ? "good" : "neutral"}>
          {configured ? `configured · ${st.data.model}` : "not set up"}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed text-ink-faint">
        Snap a bill → the app reads vendor, date &amp; total and pre-fills your
        expense. You always confirm before it saves. Works with handwritten bills.
      </p>

      {!f && !configured && (
        <div className="flex flex-wrap gap-1.5">
          {OCR_PRESETS.map((p) => (
            <button key={p.name} onClick={() => setF({
              enabled: true, provider: "openai_compat",
              base_url: p.base, model: p.model,
            })} className="rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
              Use {p.name}
            </button>
          ))}
        </div>
      )}

      {(f || configured) && (
        <>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={cfg.enabled}
                   onChange={(e) => setDraft(setF, cfg, "enabled", e.target.checked)} />
            Enable bill reading
          </label>
          <Field label="API base URL"><Input value={cfg.base_url}
                   onChange={(e) => setDraft(setF, cfg, "base_url", e.target.value)}
                   placeholder="https://generativelanguage.googleapis.com/v1beta/openai" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model"
                   hint={models.length ? "fetched from your account" : "Test connection fills this list"}>
              {models.length > 0 ? (
                <Select value={cfg.model}
                        onChange={(e) => setDraft(setF, cfg, "model", e.target.value)}>
                  {models.filter((m) => !/(embed|aqa|tts|image|audio|veo)/i.test(m))
                         .map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              ) : (
                <Input value={cfg.model} onChange={(e) => setDraft(setF, cfg, "model", e.target.value)}
                       placeholder="gemini-2.0-flash" />
              )}
            </Field>
            <Field label="API key" hint={st.data?.has_key ? "saved — leave blank to keep" : "from Google AI Studio"}>
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save OCR settings"}
            </Button>
            <Button size="sm" variant="outline" disabled={test.isPending}
                    onClick={() => test.mutate()}
                    title="Saves first, then checks the key and lists models">
              {test.isPending ? "Testing…" : "Save & test connection"}
            </Button>
          </div>
          {ping && (
            <>
              <p className={`text-xs ${ping.ok ? "text-good" : "text-bad"}`}>
                {ping.ok ? `Connection OK — ${ping.models?.length ?? 0} models available ✓`
                         : `Failed (${ping.http_status ?? ""}): ${ping.body ?? ping.error ?? "check key"}`}
              </p>
              {ping.ok && models.length > 0 && (
                <p className="text-xs text-good">Model list filled — pick one above.</p>
              )}
            </>
          )}
          <ErrorNote msg={save.error?.message ?? test.error?.message ?? ""} />
        </>
      )}
    </Card>
  );
}

function setDraft(setF: any, cfg: any, k: string, v: any) {
  setF({ ...cfg, [k]: v });
}

const DENOM_PRESETS: Record<string, number[]> = {
  INR: [500, 200, 100, 50, 20, 10, 5, 2, 1],
  USD: [100, 50, 20, 10, 5, 2, 1],
  EUR: [500, 200, 100, 50, 20, 10, 5, 2, 1],
  AED: [500, 200, 100, 50, 20, 10, 5, 1],
  GBP: [50, 20, 10, 5, 2, 1],
};

function MoneyCard() {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const { refresh: refreshMoney } = useMoney();
  const s = useQuery({ queryKey: ["settings"], queryFn: () => api.get("/admin/settings") });
  const [draft, setDraft] = useState<any>(null);
  const [msg, setMsg] = useState("");

  const cfg = draft ?? {
    currency_code: s.data?.currency_code ?? "INR",
    currency_symbol: s.data?.currency_symbol ?? "₹",
    currency_locale: s.data?.currency_locale ?? "en-IN",
    timezone_name: s.data?.timezone_name ?? "Asia/Kolkata",
    denominations: (s.data?.denominations ?? [500, 200, 100, 50, 20, 10, 5, 2, 1]).join(", "),
  };
  const set = (k: string, v: string) => setDraft({ ...cfg, [k]: v });

  const save = useMutation({
    mutationFn: () => guarded(() => api.put("/admin/settings/bulk", {
      values: {
        currency_code: cfg.currency_code,
        currency_symbol: cfg.currency_symbol,
        currency_locale: cfg.currency_locale,
        timezone_name: cfg.timezone_name,
        denominations: cfg.denominations.split(",")
          .map((x: string) => Number(x.trim()))
          .filter((n: number) => n > 0),
      },
    })),
    onSuccess: async () => {
      await refreshMoney();
      setMsg("Saved — the whole app now uses this money format.");
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e: any) => setMsg(e.message),
  });

  return (
    <Card className="space-y-3.5 p-5">
      <SectionLabel>Money & region</SectionLabel>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Currency"><Input value={cfg.currency_code} onChange={(e) => set("currency_code", e.target.value)} /></Field>
        <Field label="Symbol"><Input value={cfg.currency_symbol} onChange={(e) => set("currency_symbol", e.target.value)} /></Field>
        <Field label="Locale" hint="number grouping"><Input value={cfg.currency_locale} onChange={(e) => set("currency_locale", e.target.value)} /></Field>
      </div>
      <Field label="Note / coin denominations" hint="comma separated — drives the drawer calculator">
        <Input value={cfg.denominations} onChange={(e) => set("denominations", e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(DENOM_PRESETS).map(([code, list]) => (
          <button key={code} onClick={() => setDraft({
            ...cfg, currency_code: code,
            currency_symbol: code === "INR" ? "₹" : code === "USD" ? "$" : code === "EUR" ? "€" : code === "GBP" ? "£" : code === "AED" ? "د.إ" : code,
            currency_locale: code === "INR" ? "en-IN" : "en-US",
            denominations: list.join(", "),
          })} className="rounded-full border border-rule-strong px-2.5 py-1 text-xs hover:bg-paper-3">
            {code} preset
          </button>
        ))}
      </div>
      <Field label="Timezone" hint="business-day boundary; applies after restart">
        <Input value={cfg.timezone_name} onChange={(e) => set("timezone_name", e.target.value)} />
      </Field>
      <Button disabled={!draft || save.isPending} onClick={() => save.mutate()}>
        Save money settings
      </Button>
      {msg && <p className="text-xs text-good">{msg}</p>}
    </Card>
  );
}

function ChannelsCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["channels-admin"],
    queryFn: async () => {
      const active = await api.get("/sales/channels");
      return active;
    },
  });
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.post("/sales/channels", { name, kind: "aggregator" }),
    onSuccess: () => { setName(""); qc.invalidateQueries({ queryKey: ["channels-admin"] }); },
  });
  const rename = useMutation({
    mutationFn: ({ id, newName, kind }: any) =>
      api.patch(`/sales/channels/${id}`, { name: newName, kind }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channels-admin"] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/sales/channels/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channels-admin"] }),
  });
  return (
    <Card className="space-y-3 p-5">
      <SectionLabel>Sales channels</SectionLabel>
      <div className="space-y-1.5 text-sm">
        {(q.data ?? []).map((c: any) => (
          <div key={c.id} className="flex items-center gap-2">
            <input defaultValue={c.name}
                   onBlur={(e) => e.target.value.trim() && e.target.value !== c.name &&
                     rename.mutate({ id: c.id, newName: e.target.value, kind: c.kind })}
                   className="min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 hover:border-rule focus:border-accent focus:outline-none" />
            <Badge>{c.kind}</Badge>
            <button aria-label={`Delete channel ${c.name}`}
                    onClick={() => confirm(`Delete the sales channel "${c.name}"?`) && del.mutate(c.id)}
                    disabled={del.isPending}
                    className="text-ink-faint hover:text-bad">✕</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input placeholder="New channel (Zomato, Swiggy…)" value={name}
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && name.trim() && !add.isPending && add.mutate()} />
        <Button variant="outline" disabled={!name.trim() || add.isPending}
                onClick={() => add.mutate()}>{add.isPending ? "Adding…" : "Add"}</Button>
      </div>
    </Card>
  );
}

function AuditCard() {
  const [entity, setEntity] = useState("");
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["audit", entity, page],
    queryFn: () => api.get(`/admin/audit?${entity ? `entity=${entity}&` : ""}page=${page}`),
  });
  return (
    <Card className="p-5 lg:col-span-2">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Audit trail — every change, who & when</SectionLabel>
        <select value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }}
                className="rounded-md border border-rule-strong bg-paper px-2 py-1 text-sm">
          <option value="">All entities</option>
          {["expense", "attendance", "day_closure", "payroll_run", "payslip",
            "vendor_entry", "user", "employee", "import_batch"].map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto text-xs">
        {(q.data?.rows ?? []).map((a: any) => (
          <div key={a.id} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-paper-3/60">
            <span className="num w-36 shrink-0 text-ink-faint">
              {new Date(a.ts).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
            </span>
            <span className="w-28 shrink-0 font-medium">{a.action}</span>
            <span className="w-24 shrink-0 truncate text-ink-faint">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}</span>
            <span className="num w-14 shrink-0 text-ink-faint">u{a.user_id ?? "-"}</span>
            <span className="min-w-0 flex-1 truncate">{a.note}</span>
          </div>
        ))}
        {(q.data?.rows ?? []).length === 0 && (
          <p className="py-4 text-center text-ink-faint">Nothing recorded yet.</p>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
        <span>{q.data?.total ?? 0} entries</span>
        <span className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}
                  className="rounded border border-rule-strong px-2 py-0.5 disabled:opacity-40">‹ prev</button>
          <button disabled={page * 100 >= (q.data?.total ?? 0)}
                  onClick={() => setPage(page + 1)}
                  className="rounded border border-rule-strong px-2 py-0.5 disabled:opacity-40">next ›</button>
        </span>
      </div>
    </Card>
  );
}

function DivisorCard() {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const s = useQuery({ queryKey: ["settings"], queryFn: () => api.get("/admin/settings") });
  const [val, setVal] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const cur = val ?? String(s.data?.salary_divisor_default ?? 26);

  const apply = useMutation({
    mutationFn: (applyAll: boolean) => guarded(() => api.post("/staff/set-divisor", {
      divisor: Number(cur), apply_to_all: applyAll,
    })),
    onSuccess: (r) => {
      setMsg(r.employees_updated
        ? `Applied ÷${cur} to ${r.employees_updated} staff — payroll recalculates on next run.`
        : `New staff will default to ÷${cur}.`);
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (e: any) => setMsg(e.message),
  });

  return (
    <Card className="space-y-3 p-5">
      <SectionLabel>Salary formula</SectionLabel>
      <p className="text-sm leading-relaxed text-ink-faint">
        Per-day rate = monthly salary ÷ divisor, credited days × rate − advances.
        Change the divisor here; per-person overrides stay editable in each profile.
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm">÷</span>
        <Input inputMode="numeric" value={cur} onChange={(e) => setVal(e.target.value)}
               className="w-20 text-center text-lg font-semibold" />
        <Button variant="outline"
                disabled={Number(cur) === Number(s.data?.salary_divisor_default ?? 26)}
                onClick={() => apply.mutate(false)}>
          Set as default
        </Button>
        <Button disabled={apply.isPending || !Number(cur)}
                onClick={() => apply.mutate(true)}>
          Apply to all staff
        </Button>
      </div>
      {msg && <p className="text-xs text-good">{msg}</p>}
    </Card>
  );
  }


function AccountPage() {
  const { me, setMe } = useAuth();
  const [fullName, setFullName] = useState(me?.full_name ?? "");
  const [saved, setSaved] = useState("");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const nav = useNavigate();

  const saveProfile = useMutation({
    mutationFn: () => api.patch("/auth/profile", { full_name: fullName }),
    onSuccess: () => {
      setSaved("Saved ✓");
      api.get("/auth/me").then(setMe);
    },
    onError: (e: any) => setSaved(e.message),
  });
  const chPw = useMutation({
    mutationFn: () => api.post("/auth/change-password", { old_password: oldPw, new_password: newPw }),
    onSuccess: () => { setOldPw(""); setNewPw(""); setPwMsg("Password changed ✓"); },
    onError: (e: any) => setPwMsg(e.message),
  });

  if (!me) return null;
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <header className="flex items-center gap-3">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent">
          {(me.full_name || me.username).slice(0, 1).toUpperCase()}
        </span>
        <div>
          <SectionLabel>My account</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">{me.full_name || me.username}</h1>
          <p className="text-sm text-ink-faint">
            @{me.username} · <Badge tone={me.role === "owner" ? "accent" : "neutral"}>{me.role}</Badge>
          </p>
        </div>
      </header>

      <Card className="space-y-3.5 p-5">
        <SectionLabel>Profile</SectionLabel>
        <Field label="Display name" hint="Shown on the avatar and audit trail">
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <FactInline label="Username" value={`@${me.username}`} />
          <FactInline label="Outlets" value={String(me.outlet_ids.length)} />
        </div>
        <Button variant="outline" disabled={saveProfile.isPending || !fullName.trim()}
                onClick={() => saveProfile.mutate()}>Save profile</Button>
        {saved && <p className="text-xs text-good">{saved}</p>}
      </Card>

      <Card className="space-y-3.5 p-5">
        <SectionLabel>Password</SectionLabel>
        <Field label="Current password"><Input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} /></Field>
        <Field label="New password" hint="at least 8 characters">
          <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </Field>
        <Button variant="outline"
                disabled={!oldPw || newPw.length < 8 || chPw.isPending}
                onClick={() => chPw.mutate()}>Change password</Button>
        {pwMsg && <p className={pwMsg.includes("✓") ? "text-xs text-good" : "text-xs text-bad"}>{pwMsg}</p>}
      </Card>

      <Card className="flex items-center justify-between gap-3 p-5">
        <div className="text-sm text-ink-soft">
          {me.role === "owner"
            ? me.elevated_until && new Date(me.elevated_until).getTime() > Date.now()
              ? "Owner mode is unlocked for sensitive actions."
              : "Sensitive actions will ask for your password."
            : "You're signed in as a manager."}
        </div>
        <Button onClick={() => nav("/")}>Back to home</Button>
      </Card>
    </div>
  );
}

function FactInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-paper-2 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="num font-medium">{value}</div>
    </div>
  );
}

function RulesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get("/admin/settings") });
  const guarded = useGuarded();
  const save = async (key: string, value: unknown) => {
    await guarded(() => api.put("/admin/settings", { key, value }));
    qc.invalidateQueries({ queryKey: ["settings"] });
  };
  if (q.isLoading) return null;
  const s = q.data ?? {};
  return (
    <Card className="space-y-4 p-5">
      <SectionLabel>Rules & thresholds</SectionLabel>
      <NumRule label="Edit window (hours)"
               hint="Records older than this need your password to change"
               initial={s.edit_cutoff_hours}
               onSave={(v: number) => save("edit_cutoff_hours", v)} />
      <NumRule label="Cash variance alert (₹)"
               hint="Days whose drawer count differs more than this get flagged red"
               initial={Math.round((s.variance_alert_paise ?? 0) / 100)}
               rupees
               onSave={(v: number) => save("variance_alert_paise", Math.round(v * 100))} />
    </Card>
  );
}

function NumRule({ label, hint, initial, onSave, rupees }: any) {
  const [v, setV] = useState<string | null>(null);
  const cur = v ?? String(initial ?? "");
  return (
    <div>
      <Field label={label} hint={hint}>
        <div className="flex gap-2">
          <Input inputMode="decimal" value={cur} onChange={(e) => setV(e.target.value)} className="text-right" />
          <Button variant="outline" disabled={Number(cur) === Number(initial)}
                  onClick={() => onSave(Number(cur))}>Save</Button>
        </div>
      </Field>
    </div>
  );
}

function UsersCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get("/users") });
  const outlets = useQuery({ queryKey: ["outlets-all"], queryFn: () => api.get("/outlets") });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [f, setF] = useState({ username: "", full_name: "", password: "", role: "manager", outlet_ids: [] as number[] });
  const [err, setErr] = useState("");

  const create = useMutation({
    mutationFn: () => api.post("/users", f),
    onSuccess: () => { setOpen(false); setErr(""); setF({ username: "", full_name: "", password: "", role: "manager", outlet_ids: [] }); qc.invalidateQueries({ queryKey: ["users"] }); },
    onError: (e: any) => setErr(e.message),
  });

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>People with logins</SectionLabel>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <UserPlus size={13} /> Add login
        </Button>
      </div>
      <div className="space-y-2">
        {(q.data ?? []).map((u: any) => (
          <button key={u.id} onClick={() => setEditing(u)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-paper-3">
            <span className="min-w-0 flex-1 truncate font-medium">{u.username}</span>
            {u.full_name && <span className="truncate text-xs text-ink-faint">{u.full_name}</span>}
            <Badge tone={u.role === "owner" ? "accent" : "neutral"}>{u.role}</Badge>
            {!u.is_active && <Badge tone="warn">disabled</Badge>}
          </button>
        ))}
        <p className="px-2 pt-1 text-[11px] text-ink-faint">Tap a login to edit role, outlets or password.</p>
      </div>

        <EditUser key={editing?.id ?? "none"} user={editing} onClose={() => setEditing(null)} />

      <Sheet open={open} onClose={() => setOpen(false)} title="Add a login">
        <div className="space-y-3.5">
          <Field label="Username"><Input autoFocus value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
          <Field label="Full name"><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
          <Field label="Role" hint="Managers never see salary screens or anything older than the edit window">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="manager">Manager</option><option value="owner">Owner</option>
            </Select>
          </Field>
          <Field label="Password"><Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label="Can work in outlets">
            <div className="flex flex-wrap gap-2">
              {(outlets.data ?? []).map((o: any) => (
                <button key={o.id}
                  onClick={() => setF((x: any) => ({
                    ...x,
                    outlet_ids: x.outlet_ids.includes(o.id)
                      ? x.outlet_ids.filter((i: number) => i !== o.id)
                      : [...x.outlet_ids, o.id],
                  }))}
                  className={`rounded-full border px-3 py-1 text-sm ${f.outlet_ids.includes(o.id) ? "border-accent bg-accent-soft text-accent" : "border-rule-strong"}`}>
                  {o.name}
                </button>
              ))}
            </div>
          </Field>
          <ErrorNote msg={err} />
          <Button className="w-full" disabled={!f.username || !f.password || create.isPending} onClick={() => create.mutate()}>
            Create login
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

function EditUser({ user, onClose }: { user: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const outlets = useQuery({ queryKey: ["outlets-all"], queryFn: () => api.get("/outlets") });
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [role, setRole] = useState(user?.role ?? "manager");
  const [active, setActive] = useState(user?.is_active ?? true);
  const [pw, setPw] = useState("");
  const [ids, setIds] = useState<number[]>(user?.outlet_ids ?? []);
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: () => api.patch(`/users/${user.id}`, {
      username: user.username,
      full_name: fullName,
      role,
      is_active: active,
      outlet_ids: ids,
      password: pw || undefined,
    }),
    onSuccess: () => { setPw(""); onClose(); qc.invalidateQueries({ queryKey: ["users"] }); },
    onError: (e: any) => setErr(e.message),
  });

  if (!user) return null;

  return (
    <Sheet open onClose={onClose} title={`Edit login · ${user.username}`}>
      <div className="space-y-3.5">
        <Field label="Full name"><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="manager">Manager</option><option value="owner">Owner</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Login enabled
        </label>
        <Field label="New password" hint="leave blank to keep the current one">
          <Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Outlets">
          <div className="flex flex-wrap gap-2">
            {(outlets.data ?? []).map((o: any) => (
              <button key={o.id}
                onClick={() => setIds((x) =>
                  x.includes(o.id) ? x.filter((i) => i !== o.id) : [...x, o.id])}
                className={`rounded-full border px-3 py-1 text-sm ${ids.includes(o.id) ? "border-accent bg-accent-soft text-accent" : "border-rule-strong"}`}>
                {o.name}
              </button>
            ))}
          </div>
        </Field>
        <ErrorNote msg={err} />
        <Button size="lg" className="w-full" disabled={save.isPending} onClick={() => save.mutate()}>
          Save login
        </Button>
      </div>
    </Sheet>
  );
}

function OutletsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["outlets-all"], queryFn: () => api.get("/outlets") });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [float, setFloat] = useState("2000");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post("/outlets", { name, opening_float_rupees: Number(float) }),
    onSuccess: () => { setOpen(false); setName(""); qc.invalidateQueries({ queryKey: ["outlets-all"] }); },
  });
  const saveRename = useMutation({
    mutationFn: ({ id, newName }: { id: number; newName: string }) => {
      const cur = (q.data ?? []).find((o: any) => o.id === id);
      return api.patch(`/outlets/${id}`, {
        name: newName,
        address: cur?.address ?? "",
        phone: cur?.phone ?? "",
        opening_float_rupees: cur?.opening_float_rupees ?? 0,
      });
    },
    onSuccess: () => { setEditingId(null); qc.invalidateQueries({ queryKey: ["outlets-all"] }); },
  });

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Outlets</SectionLabel>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>+ Outlet</Button>
      </div>
      <div className="space-y-1.5 text-sm">
        {(q.data ?? []).map((o: any) => (
          <div key={o.id} className="flex items-center gap-2">
            {editingId === o.id ? (
              <>
                <Input autoFocus value={draftName}
                       onChange={(e) => setDraftName(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && saveRename.mutate({ id: o.id, newName: draftName })}
                       className="!py-1" />
                <Button size="sm" disabled={!draftName.trim() || saveRename.isPending}
                        onClick={() => saveRename.mutate({ id: o.id, newName: draftName })}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>✕</Button>
              </>
            ) : (
              <>
                <button className="min-w-0 flex-1 truncate text-left font-medium hover:text-accent"
                        title="Click to rename"
                        onClick={() => { setEditingId(o.id); setDraftName(o.name); }}>
                  {o.name}
                </button>
                <span className="num ml-auto text-xs text-ink-faint">float ₹{o.opening_float_rupees}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title="New outlet">
        <div className="space-y-3.5">
          <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Daily opening cash float" hint="what stays in the drawer overnight">
            <Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} className="text-right" />
          </Field>
          <Button className="w-full"
                  disabled={!name.trim() || !Number.isFinite(Number(float)) || create.isPending}
                  onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create outlet"}
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

function BackupCard() {
  const guarded = useGuarded();
  return (
    <Card className="space-y-3 p-5">
      <SectionLabel>Data safety</SectionLabel>
      <p className="text-sm leading-relaxed text-ink-faint">
        Everything lives on this PC, in Ledger's own data folder. Download a
        full backup (database + receipts) and keep a copy anywhere you like —
        restoring is just copying it back.
      </p>
      <Button variant="outline" onClick={() =>
        guarded(async () => downloadFile("/admin/backup/download",
          `ledger-backup-${new Date().toISOString().slice(0, 10)}.zip`))}>
        <Download size={14} /> Download backup (.zip)
      </Button>
      <p className="flex items-start gap-2 text-xs text-ink-faint">
        <Lock size={12} className="mt-0.5 shrink-0" /> Needs your password each time — treat backups like cash.
      </p>
    </Card>
  );
}

// keep unused imports referenced for ts builds
void Badge; void Select; void DOW_LABELS;
