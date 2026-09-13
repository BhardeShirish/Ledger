import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { useState } from "react";
import { Download, Lock, ShieldCheck, UserPlus } from "lucide-react";
import { api, downloadFile } from "../api/client";
import { useAuth, useGuarded } from "../lib/auth";
import { useMoney } from "../lib/money";
import { DOW_LABELS, todayISO } from "../lib/format";
import {
  Badge, Button, Card, ConfirmSheet, ErrorNote, Field, Input, SectionLabel, Select,
  Sheet, Spinner,
} from "../components/ui";
import { CostGroupsCard, HealthyBandsCard, StandingCostsCard } from "../components/StandingCosts";

const DEFAULT_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];
const DEFAULT_SETTINGS = {
  restaurant_name: "My restaurant",
  currency_code: "INR",
  currency_symbol: "₹",
  currency_locale: "en-IN",
  timezone_name: "Asia/Kolkata",
  denominations: DEFAULT_DENOMINATIONS,
  edit_cutoff_hours: 48,
  salary_divisor_default: 26,
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeSettings(value: unknown) {
  let invalid = !isRecord(value);
  const source = isRecord(value) ? value : {};
  const text = (key: keyof typeof DEFAULT_SETTINGS) => {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    invalid = true;
    return DEFAULT_SETTINGS[key] as string;
  };
  const wholeNumber = (key: "edit_cutoff_hours" | "salary_divisor_default", min: number, max: number) => {
    const candidate = source[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)
        && candidate >= min && candidate <= max) return candidate;
    invalid = true;
    return DEFAULT_SETTINGS[key];
  };
  const denominations = source.denominations;
  const validDenominations = Array.isArray(denominations)
    && denominations.length > 0
    && denominations.every(isPositiveInt);
  if (!validDenominations) invalid = true;
  return {
    settings: {
      restaurant_name: text("restaurant_name"),
      currency_code: text("currency_code"),
      currency_symbol: text("currency_symbol"),
      currency_locale: text("currency_locale"),
      timezone_name: text("timezone_name"),
      denominations: validDenominations ? denominations : DEFAULT_DENOMINATIONS,
      edit_cutoff_hours: wholeNumber("edit_cutoff_hours", 0, 8760),
      salary_divisor_default: wholeNumber("salary_divisor_default", 1, 60),
    },
    invalid,
  };
}

function normalizeList<T>(value: unknown, parse: (row: RecordValue) => T | null) {
  if (!Array.isArray(value)) return { items: [] as T[], invalid: true };
  const items: T[] = [];
  let invalid = false;
  for (const entry of value) {
    const item = isRecord(entry) ? parse(entry) : null;
    if (item === null) invalid = true;
    else items.push(item);
  }
  return { items, invalid };
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return { items: [] as string[], invalid: true };
  const items = value.filter((item): item is string => typeof item === "string");
  return { items, invalid: items.length !== value.length };
}

function normalizeIds(value: unknown): number[] | null {
  return Array.isArray(value) && value.every(isPositiveInt) ? value : null;
}

function normalizeOutlets(value: unknown) {
  return normalizeList(value, (row) => (
    isPositiveInt(row.id) && typeof row.name === "string" && row.name.trim()
    && typeof row.opening_float_rupees === "number" && Number.isFinite(row.opening_float_rupees)
      ? {
        id: row.id,
        name: row.name,
        opening_float_rupees: row.opening_float_rupees,
        address: typeof row.address === "string" ? row.address : "",
        phone: typeof row.phone === "string" ? row.phone : "",
      }
      : null
  ));
}

export default function SettingsPage() {
  const { me } = useAuth();
  const { outletId } = useOutletContext<{ outletId: number }>();
  const { pathname } = useLocation();
  const sub = pathname.split("/")[2] || "";
  // Account recovery is deliberately available to every signed-in role;
  // administration below remains owner-only.
  if (sub === "account") return <AccountPage />;
  if (me?.role !== "owner") {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <ShieldCheck className="mx-auto text-ink-faint" size={28} />
        <h1 className="mt-2 font-semibold">Owner area</h1>
        <p className="text-sm text-ink-faint">Settings are only visible to you-know-who.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      <header>
        <SectionLabel>Settings</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight">House rules</h1>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <RulesCard />
        <OwnerPolicyCard outletId={outletId} />
        <DivisorCard />
        <StandingCostsCard outletId={outletId} />
        <CostGroupsCard />
        <HealthyBandsCard />
        <MoneyCard />
        <OcrCard />
        <ChannelsCard />
        <UsersCard />
        <OutletsCard />
        <AuditCard />
        <BackupCard />
        <SystemHealthCard outletId={outletId} />
      </div>
    </div>
  );
}

function OwnerPolicyCard({ outletId }: { outletId: number }) {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const q = useQuery({
    enabled: Boolean(outletId), queryKey: ["owner-policy", outletId],
    queryFn: () => api.get(`/owner/policies?outlet_id=${outletId}`),
  });
  const [draft, setDraft] = useState<any>(null);
  const p = draft ?? (isRecord(q.data) ? q.data : null);
  const save = useMutation({
    mutationFn: () => guarded(() => api.put("/owner/policies", {
      outlet_id: outletId,
      cash_variance_alert_rupees: Number(p.cash_variance_alert_rupees),
      minimum_data_coverage_percent: Number(p.minimum_data_coverage_percent),
      stock_count_cadence_days: Number(p.stock_count_cadence_days),
      stockout_lead_days: Number(p.stockout_lead_days),
      payable_overdue_days: Number(p.payable_overdue_days),
      purchase_approval_limit_rupees: Number(p.purchase_approval_limit_rupees),
      minimum_cash_buffer_rupees: p.minimum_cash_buffer_rupees === "" ? null : Number(p.minimum_cash_buffer_rupees),
    })),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["owner-policy", outletId] });
      qc.invalidateQueries({ queryKey: ["intelligence-brief"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const set = (key: string, value: string) => setDraft({ ...p, [key]: value });
  return (
    <Card className="space-y-3.5 p-5">
      <SectionLabel>Owner operating policies</SectionLabel>
      <p className="text-xs leading-relaxed text-ink-faint">
        These thresholds flag review work; they never edit cash, stock, bills, or purchase facts.
      </p>
      {q.isLoading && <Spinner />}
      {q.isError && <ErrorNote msg="Couldn't load owner policies. Try again after checking the Ledger server." />}
      {q.data !== undefined && !isRecord(q.data) && <ErrorNote msg="Owner-policy data was unreadable and was not shown. Try again." />}
      {p && <div className="grid gap-3 sm:grid-cols-2">
        <PolicyInput label="Cash variance alert (₹)" value={p.cash_variance_alert_rupees} onChange={(v: string) => set("cash_variance_alert_rupees", v)} />
        <PolicyInput label="Minimum data coverage (%)" value={p.minimum_data_coverage_percent} onChange={(v: string) => set("minimum_data_coverage_percent", v)} />
        <PolicyInput label="Stock count cadence (days)" value={p.stock_count_cadence_days} onChange={(v: string) => set("stock_count_cadence_days", v)} />
        <PolicyInput label="Stock-out lead time (days)" value={p.stockout_lead_days} onChange={(v: string) => set("stockout_lead_days", v)} />
        <PolicyInput label="Payable overdue after (days)" value={p.payable_overdue_days} onChange={(v: string) => set("payable_overdue_days", v)} />
        <PolicyInput label="Purchase warning limit (₹)" value={p.purchase_approval_limit_rupees} onChange={(v: string) => set("purchase_approval_limit_rupees", v)} />
        <PolicyInput label="Minimum cash buffer (₹)" hint="optional" value={p.minimum_cash_buffer_rupees ?? ""} onChange={(v: string) => set("minimum_cash_buffer_rupees", v)} />
      </div>}
      <Button disabled={!p || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save policies"}
      </Button>
      <ErrorNote msg={save.error?.message ?? ""} />
    </Card>
  );
}

function PolicyInput({ label, hint, value, onChange }: {
  label: string; hint?: string; value: string | number; onChange: (value: string) => void;
}) {
  return <Field label={label} hint={hint}>
    <Input inputMode="decimal" className="text-right" value={String(value)}
           onChange={(e) => onChange(e.target.value)} />
  </Field>;
}

function SystemHealthCard({ outletId }: { outletId: number }) {
  const q = useQuery({
    enabled: Boolean(outletId), queryKey: ["system-health", outletId],
    queryFn: () => api.get(`/owner/system-health?outlet_id=${outletId}`),
  });
  const raw = isRecord(q.data) ? q.data : {};
  const database = isRecord(raw.database) ? raw.database : {};
  const disk = isRecord(raw.disk) ? raw.disk : {};
  const backup = isRecord(raw.last_automatic_backup) ? raw.last_automatic_backup : {};
  const integrity = isRecord(backup.integrity) ? backup.integrity : {};
  const restore = normalizeStringList(raw.restore_playbook);
  const sizeOrNull = (value: unknown): number | null => (
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
  );
  const textOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;
  const validSize = (value: unknown) => value === null || sizeOrNull(value) !== null;
  const validText = (value: unknown) => value === null || textOrNull(value) !== null;
  const invalid = q.data !== undefined && (
    !isRecord(q.data) || !isRecord(raw.database) || !isRecord(raw.disk)
    || !isRecord(raw.last_automatic_backup) || !isRecord(backup.integrity)
    || !validSize(database.size_bytes) || !validSize(disk.free_bytes)
    || !validText(backup.name) || !validText(backup.download_path)
    || typeof integrity.status !== "string" || restore.invalid
  );
  const h = {
    database: { size_bytes: sizeOrNull(database.size_bytes) },
    disk: { free_bytes: sizeOrNull(disk.free_bytes) },
    last_automatic_backup: {
      name: textOrNull(backup.name),
      download_path: textOrNull(backup.download_path),
      integrity: { status: typeof integrity.status === "string" ? integrity.status : "unavailable" },
    },
    restore_playbook: restore.items,
  };
  const download = useMutation({
    mutationFn: () => downloadFile(
      `${h.last_automatic_backup.download_path}?outlet_id=${outletId}`,
      h.last_automatic_backup.name ?? "ledger-backup.db"),
  });
  return (
    <Card className="space-y-3.5 p-5">
      <SectionLabel>System health & recovery</SectionLabel>
      <p className="text-xs text-ink-faint">Read-only checks; restoring is deliberately an offline procedure.</p>
      {q.isLoading && <Spinner />}
      {q.isError && <ErrorNote msg="System health is unavailable. The Ledger server may not be able to read its data folder." />}
      {invalid && <ErrorNote msg="Some system-health details were unreadable. Safe unavailable values are shown; try again after checking the Ledger server." />}
      {q.data !== undefined && <>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <FactInline label="Database" value={h.database.size_bytes == null ? "unavailable" : `${Math.ceil(h.database.size_bytes / 1024)} KB`} />
          <FactInline label="Free disk" value={h.disk.free_bytes == null ? "unavailable" : `${Math.floor(h.disk.free_bytes / 1024 / 1024)} MB`} />
          <FactInline label="Latest backup" value={h.last_automatic_backup.name ?? "none"} />
          <FactInline label="Backup check" value={h.last_automatic_backup.integrity.status} />
        </div>
        {h.last_automatic_backup.download_path && <Button variant="outline" disabled={download.isPending}
          onClick={() => download.mutate()}><Download size={15} />{download.isPending ? "Downloading…" : "Download automatic backup"}</Button>}
        <ErrorNote msg={download.error?.message ?? ""} />
        <ol className="list-decimal space-y-1 pl-4 text-xs text-ink-faint">
          {h.restore_playbook.map((step: string) => <li key={step}>{step}</li>)}
        </ol>
      </>}
    </Card>
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
            })} className="min-h-11 rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
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
  const settings = normalizeSettings(s.data);

  const cfg = draft ?? { ...settings.settings, denominations: settings.settings.denominations.join(", ") };
  const set = (k: string, v: string) => setDraft({ ...cfg, [k]: v });

  const save = useMutation({
    mutationFn: () => guarded(() => api.put("/admin/settings/bulk", {
      values: {
        restaurant_name: cfg.restaurant_name,
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
      <SectionLabel>Business, money & region</SectionLabel>
      {s.isError && <ErrorNote msg="Couldn't load business settings. Safe defaults are shown; try again after checking the Ledger server." />}
      {s.data !== undefined && settings.invalid && <ErrorNote msg="Some business settings were unreadable. Safe defaults are shown; try again." />}
      <Field label="Business name" hint="shown on sign-in and in this browser tab">
        <Input value={cfg.restaurant_name} onChange={(e) => set("restaurant_name", e.target.value)} />
      </Field>
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
          })} className="min-h-11 rounded-full border border-rule-strong px-2.5 py-1 text-xs hover:bg-paper-3">
            {code} preset
          </button>
        ))}
      </div>
      <Field label="Timezone" hint="business-day boundary; applies after restart">
        <Input value={cfg.timezone_name} onChange={(e) => set("timezone_name", e.target.value)} />
      </Field>
      <Button disabled={!draft || save.isPending} onClick={() => save.mutate()}>
        Save business and money settings
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
  const [deleting, setDeleting] = useState<any>(null);
  const [error, setError] = useState("");
  const channels = normalizeList(q.data, (row) => (
    isPositiveInt(row.id) && typeof row.name === "string" && row.name.trim()
    && typeof row.kind === "string" && row.kind.trim()
      ? { id: row.id, name: row.name, kind: row.kind }
      : null
  ));
  const add = useMutation({
    mutationFn: () => api.post("/sales/channels", { name, kind: "aggregator" }),
    onMutate: () => setError(""),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["channels-admin"] });
    },
    onError: (e: any) => setError(e.message || "Couldn't add this sales channel. Try again."),
  });
  const rename = useMutation({
    mutationFn: ({ id, newName, kind }: any) =>
      api.patch(`/sales/channels/${id}`, { name: newName, kind }),
    onMutate: () => setError(""),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channels-admin"] }),
    onError: (e: any) => setError(e.message || "Couldn't rename this sales channel. Try again."),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/sales/channels/${id}`),
    onMutate: () => setError(""),
    onSuccess: () => {
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ["channels-admin"] });
    },
    onError: (e: any) => {
      setDeleting(null);
      setError(e.message || "Couldn't delete this sales channel. Try again.");
    },
  });
  return (
    <Card className="space-y-3 p-5">
      <SectionLabel>Sales channels</SectionLabel>
      {q.isLoading && <Spinner />}
      {q.isError && <ErrorNote msg="Couldn't load sales channels. Try again after checking the Ledger server." />}
      {q.data !== undefined && channels.invalid && <ErrorNote msg="Some sales-channel data was unreadable and was not shown. Try again." />}
      <div className="space-y-1.5 text-sm">
        {channels.items.map((c) => (
          <div key={c.id} className="flex items-center gap-2">
            <Input size="compact" defaultValue={c.name}
                   aria-label={`Sales channel name: ${c.name}`}
                   onBlur={(e) => e.target.value.trim() && e.target.value !== c.name &&
                     rename.mutate({ id: c.id, newName: e.target.value, kind: c.kind })}
                   className="min-w-0 flex-1" />
            <Badge>{c.kind}</Badge>
            <Button variant="ghost" size="sm" aria-label={`Delete channel ${c.name}`}
                    onClick={() => setDeleting(c)}
                    disabled={del.isPending}
                    className="text-bad">✕</Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input placeholder="New channel (Zomato, Swiggy…)" value={name}
               aria-label="New sales channel name"
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && name.trim() && !add.isPending && add.mutate()} />
        <Button variant="outline" disabled={!name.trim() || add.isPending}
                onClick={() => add.mutate()}>{add.isPending ? "Adding…" : "Add"}</Button>
      </div>
      <ErrorNote msg={error} />
      <ConfirmSheet
        open={deleting != null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) del.mutate(deleting.id);
        }}
        title="Delete sales channel?"
        description={deleting ? `Delete the sales channel "${deleting.name}"?` : ""}
        confirmLabel="Delete channel"
        pending={del.isPending}
        pendingLabel="Deleting…"
      />
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
  const source = isRecord(q.data) ? q.data : {};
  const rows = normalizeList(source.rows, (row) => (
    isPositiveInt(row.id) && typeof row.action === "string" && typeof row.entity === "string"
      ? {
        id: row.id,
        ts: typeof row.ts === "string" ? row.ts : null,
        action: row.action,
        entity: row.entity,
        entity_id: typeof row.entity_id === "string" || typeof row.entity_id === "number"
          ? row.entity_id : null,
        user_id: isPositiveInt(row.user_id) ? row.user_id : null,
        note: typeof row.note === "string" ? row.note : "",
      }
      : null
  ));
  const total = typeof source.total === "number"
    && Number.isSafeInteger(source.total) && source.total >= 0 ? source.total : 0;
  const invalid = q.data !== undefined && (
    !isRecord(q.data) || rows.invalid || total !== source.total
  );
  return (
    <Card className="min-w-0 p-5 lg:col-span-2">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Audit trail — every change, who & when</SectionLabel>
        <Select size="compact" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }}
                aria-label="Filter audit trail by entity"
                className="!w-auto">
          <option value="">All entities</option>
          {["expense", "attendance", "day_closure", "payroll_run", "payslip",
            "vendor_entry", "user", "employee", "import_batch"].map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </Select>
      </div>
      {q.isError && <ErrorNote msg="Couldn't load the audit trail. Try again after checking the Ledger server." />}
      {invalid && <ErrorNote msg="Some audit-trail data was unreadable and was not shown. Try again." />}
      {/* Keyboard focus is required to scroll this labelled region without a pointer. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div role="region" tabIndex={0} aria-label="Audit trail entries"
           className="max-h-72 min-w-0 w-full space-y-1 overflow-auto text-xs">
        {rows.items.map((a) => (
          <div key={a.id} className="flex min-w-[34rem] items-start gap-2 rounded px-2 py-1 hover:bg-paper-3/60">
            <span className="num w-36 shrink-0 text-ink-faint">
              {a.ts ? new Date(a.ts).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "unknown"}
            </span>
            <span className="w-28 shrink-0 font-medium">{a.action}</span>
            <span className="w-24 shrink-0 truncate text-ink-faint">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}</span>
            <span className="num w-14 shrink-0 text-ink-faint">u{a.user_id ?? "-"}</span>
            <span className="min-w-0 flex-1 truncate">{a.note}</span>
          </div>
        ))}
        {rows.items.length === 0 && !q.isError && (
          <p className="py-4 text-center text-ink-faint">Nothing recorded yet.</p>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
        <span>{total} entries</span>
        <span className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}
                  className="rounded border border-rule-strong px-2 py-0.5 disabled:opacity-40">‹ prev</button>
          <button disabled={page * 100 >= total}
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
               aria-label="Default salary divisor in days"
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
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} /></Field>
        <Field label="New password" hint="at least 8 characters">
          <Input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
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
  const settings = normalizeSettings(q.data);
  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: number }) =>
      guarded(() => api.put("/admin/settings", { key, value })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  return (
    <Card className="space-y-4 p-5">
      <SectionLabel>Rules & thresholds</SectionLabel>
      {q.isLoading && <Spinner />}
      {q.isError && <ErrorNote msg="Couldn't load rules. Safe defaults are shown; try again after checking the Ledger server." />}
      {q.data !== undefined && settings.invalid && <ErrorNote msg="Some rule settings were unreadable. Safe defaults are shown; try again." />}
      <NumRule label="Edit window (hours)"
               hint="Records older than this need your password to change"
               initial={settings.settings.edit_cutoff_hours}
               disabled={q.isLoading || save.isPending}
               onSave={(value: number) => save.mutate({ key: "edit_cutoff_hours", value })} />
      <ErrorNote msg={save.error?.message ?? ""} />
    </Card>
  );
}

function NumRule({ label, hint, initial, onSave, disabled = false }: {
  label: string; hint: string; initial: number; onSave: (value: number) => void; disabled?: boolean;
}) {
  const [v, setV] = useState<string | null>(null);
  const [error, setError] = useState("");
  const cur = v ?? String(initial ?? "");
  const parsed = Number(cur);
  const valid = cur.trim() !== "" && Number.isFinite(parsed) && Number.isInteger(parsed)
    && parsed >= 0 && parsed <= 8760;
  const save = () => {
    if (!valid) {
      setError("Enter a whole number from 0 to 8,760 hours.");
      return;
    }
    setError("");
    onSave(parsed);
  };
  return (
    <div>
      <Field label={label} hint={hint}>
        <div className="flex gap-2">
          <Input inputMode="numeric" value={cur} onChange={(e) => {
            setV(e.target.value);
            setError("");
          }} className="text-right" aria-invalid={Boolean(error)} />
          <Button variant="outline" disabled={disabled || (valid && parsed === initial)}
                  onClick={save}>Save</Button>
        </div>
      </Field>
      <ErrorNote msg={error} />
    </div>
  );
}

function UsersCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get("/users") });
  const outlets = useQuery({ queryKey: ["outlets-all"], queryFn: () => api.get("/outlets") });
  const users = normalizeList(q.data, (row) => {
    const outletIds = normalizeIds(row.outlet_ids);
    return isPositiveInt(row.id) && typeof row.username === "string" && row.username.trim()
      && typeof row.full_name === "string" && (row.role === "owner" || row.role === "manager")
      && typeof row.is_active === "boolean" && outletIds !== null
      ? {
        id: row.id, username: row.username, full_name: row.full_name, role: row.role,
        is_active: row.is_active, outlet_ids: outletIds,
      }
      : null;
  });
  const outletRows = normalizeOutlets(outlets.data);
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
      {q.isError && <ErrorNote msg="Couldn't load user logins. Try again after checking the Ledger server." />}
      {q.data !== undefined && users.invalid && <ErrorNote msg="Some user-login data was unreadable and was not shown. Try again." />}
      {outlets.isError && <ErrorNote msg="Couldn't load outlets for user assignments. Try again after checking the Ledger server." />}
      {outlets.data !== undefined && outletRows.invalid && <ErrorNote msg="Some outlet-assignment data was unreadable and was not shown. Try again." />}
      <div className="space-y-2">
        {users.items.map((u) => (
          <button key={u.id} onClick={() => setEditing(u)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-paper-3">
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
          <Field label="Password"><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink-soft">Can work in outlets</legend>
            <div className="flex flex-wrap gap-2">
              {outletRows.items.map((o) => (
                <button key={o.id}
                  type="button"
                  aria-pressed={f.outlet_ids.includes(o.id)}
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
          </fieldset>
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
  const outletRows = normalizeOutlets(outlets.data);
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
          <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-soft">Outlets</legend>
          <div className="flex flex-wrap gap-2">
            {outletRows.items.map((o) => (
              <button key={o.id}
                type="button"
                aria-pressed={ids.includes(o.id)}
                onClick={() => setIds((x) =>
                  x.includes(o.id) ? x.filter((i) => i !== o.id) : [...x, o.id])}
                className={`rounded-full border px-3 py-1 text-sm ${ids.includes(o.id) ? "border-accent bg-accent-soft text-accent" : "border-rule-strong"}`}>
                {o.name}
              </button>
            ))}
          </div>
        </fieldset>
        {outlets.isError && <ErrorNote msg="Couldn't load outlets for user assignments. Try again after checking the Ledger server." />}
        {outlets.data !== undefined && outletRows.invalid && <ErrorNote msg="Some outlet-assignment data was unreadable and was not shown. Try again." />}
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
  const outlets = normalizeOutlets(q.data);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [float, setFloat] = useState("2000");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState("");
  const create = useMutation({
    mutationFn: () => api.post("/outlets", { name, opening_float_rupees: Number(float) }),
    onMutate: () => setError(""),
    onSuccess: () => {
      setOpen(false);
      setName("");
      qc.invalidateQueries({ queryKey: ["outlets-all"] });
    },
    onError: (e: any) => setError(e.message || "Couldn't create this outlet. Try again."),
  });
  const saveRename = useMutation({
    mutationFn: ({ id, newName }: { id: number; newName: string }) => {
      const cur = outlets.items.find((outlet) => outlet.id === id);
      return api.patch(`/outlets/${id}`, {
        name: newName,
        address: cur?.address ?? "",
        phone: cur?.phone ?? "",
        opening_float_rupees: cur?.opening_float_rupees ?? 0,
      });
    },
    onMutate: () => setError(""),
    onSuccess: () => { setEditingId(null); qc.invalidateQueries({ queryKey: ["outlets-all"] }); },
    onError: (e: any) => setError(e.message || "Couldn't rename this outlet. Try again."),
  });

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Outlets</SectionLabel>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>+ Outlet</Button>
      </div>
      {q.isLoading && <Spinner />}
      {q.isError && <ErrorNote msg="Couldn't load outlets. Try again after checking the Ledger server." />}
      {q.data !== undefined && outlets.invalid && <ErrorNote msg="Some outlet data was unreadable and was not shown. Try again." />}
      <div className="space-y-1.5 text-sm">
        {outlets.items.map((o) => (
          <div key={o.id} className="flex items-center gap-2">
            {editingId === o.id ? (
              <>
                <Input size="compact" autoFocus value={draftName}
                       onChange={(e) => setDraftName(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && saveRename.mutate({ id: o.id, newName: draftName })} />
                <Button size="sm" disabled={!draftName.trim() || saveRename.isPending}
                        onClick={() => saveRename.mutate({ id: o.id, newName: draftName })}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>✕</Button>
              </>
            ) : (
              <>
                <button className="min-h-11 min-w-0 flex-1 truncate text-left font-medium hover:text-accent"
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
      {!open && <ErrorNote msg={error} />}
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
          <ErrorNote msg={error} />
        </div>
      </Sheet>
    </Card>
  );
}

function BackupCard() {
  const guarded = useGuarded();
  const qc = useQueryClient();
  const recovery = useQuery({
    queryKey: ["recovery-backup-status"],
    queryFn: () => api.get("/admin/backup/status"),
  });
  const [destination, setDestination] = useState<string | null>(null);
  const updateDestination = useMutation({
    mutationFn: (directory: string | null) => guarded(() =>
      api.put("/admin/backup/recovery-location", { directory })),
    onSuccess: () => {
      setDestination(null);
      qc.invalidateQueries({ queryKey: ["recovery-backup-status"] });
    },
  });
  const raw = isRecord(recovery.data) ? recovery.data : {};
  const downloadBackup = useMutation({
    mutationFn: () => guarded(() => downloadFile(
      "/admin/backup/download", `ledger-backup-${todayISO()}.zip`)),
  });
  const latest = isRecord(raw.latest) ? raw.latest : null;
  const latestName = latest && typeof latest.name === "string" ? latest.name : null;
  const latestSize = latest && typeof latest.size_bytes === "number"
    && Number.isFinite(latest.size_bytes) && latest.size_bytes >= 0 ? latest.size_bytes : null;
  const directory = typeof raw.directory === "string" ? raw.directory : "";
  const retentionDays = isPositiveInt(raw.retention_days) ? raw.retention_days : 30;
  const invalid = recovery.data !== undefined && (
    !isRecord(recovery.data) || typeof raw.directory !== "string"
    || !isPositiveInt(raw.retention_days)
    || (raw.latest !== null && (!isRecord(raw.latest) || latestName === null || latestSize === null))
  );
  const folder = destination ?? directory;
  return (
    <Card className="space-y-3 p-5">
      <SectionLabel>Data safety</SectionLabel>
      <p className="text-sm leading-relaxed text-ink-faint">
        Ledger automatically saves a full recovery copy outside its application
        folder each day: database, receipts and sign-in key. Deleting Ledger
        itself will not delete that separate copy.
      </p>
      {recovery.isLoading && <Spinner />}
      {recovery.isError && <ErrorNote msg="Automatic recovery backup status is unavailable. Download a backup now and check the Ledger server." />}
      {invalid && <ErrorNote msg="Some automatic-backup details were unreadable. Safe unavailable values are shown; try again." />}
      {recovery.data !== undefined && <div className="space-y-1 rounded-md border border-rule bg-paper-2 p-3 text-xs text-ink-faint">
        <p><b className="font-medium text-ink">Recovery folder:</b> <span className="break-all">{directory || "unavailable"}</span></p>
        <p><b className="font-medium text-ink">Latest full copy:</b> {latestName && latestSize !== null
          ? `${latestName} (${Math.ceil(latestSize / 1024)} KB)`
          : "not created yet — keep Ledger running briefly, then refresh."}</p>
        <p>Keeps the latest {retentionDays} daily copies. To recover after deletion, reinstall Ledger and use <span className="font-medium text-ink">setup\Restore-LedgerBackup.ps1</span>.</p>
      </div>}
      <Field label="Cloud or external recovery folder"
             hint="optional — use a Google Drive for desktop folder, USB drive, or another protected folder">
        <Input value={folder} placeholder="Example: G:\My Drive\Ledger Backups"
               onChange={(event) => setDestination(event.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!destination?.trim() || updateDestination.isPending}
                onClick={() => updateDestination.mutate(folder.trim())}>
          {updateDestination.isPending ? "Saving…" : "Use this recovery folder"}
        </Button>
        <Button variant="ghost" disabled={updateDestination.isPending}
                onClick={() => updateDestination.mutate(null)}>
          Use protected default
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-ink-faint">
        Google Sheets is not a complete backup. Install and sign in to Google Drive for desktop yourself, create a private folder there, then paste its File Explorer path above. Ledger stores no Google credentials; Drive syncs the encrypted-in-transit ZIP file after Ledger writes it.
      </p>
      <ErrorNote msg={updateDestination.error?.message ?? ""} />
      <Button variant="outline" disabled={downloadBackup.isPending}
              onClick={() => downloadBackup.mutate()}>
        <Download size={14} /> {downloadBackup.isPending ? "Preparing…" : "Download backup (.zip)"}
      </Button>
      <ErrorNote msg={(downloadBackup.error as any)?.handled ? "" : downloadBackup.error?.message ?? ""} />
      <p className="flex items-start gap-2 text-xs text-ink-faint">
        <Lock size={12} className="mt-0.5 shrink-0" /> Needs your password each time — treat backups like cash.
      </p>
    </Card>
  );
}

// keep unused imports referenced for ts builds
void Badge; void Select; void DOW_LABELS;
