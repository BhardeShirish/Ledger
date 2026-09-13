import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { useMemo, useRef, useState } from "react";
import { Camera, FileBadge, Pencil } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { DOW_LABELS, fmtDateShort, inr } from "../lib/format";
import { useDirtyDraft } from "../lib/useDirtyDraft";
import {
  Badge, Button, Card, ErrorNote, Field, Input, SectionLabel, Select,
  Sheet, Spinner,
} from "../components/ui";

export default function PersonDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["person", id], queryFn: () => api.get(`/staff/employees/${id}`) });
  const shifts = useQuery({ queryKey: ["shifts"], queryFn: () => api.get("/staff/shifts") });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) {
    return (
      <div className="space-y-3">
        <ErrorNote msg="Couldn't load this staff member. Check your connection and retry." />
        <Button variant="outline" disabled={q.isFetching} onClick={() => void q.refetch()}>
          {q.isFetching ? "Retrying staff member…" : "Retry staff member"}
        </Button>
      </div>
    );
  }
  const e = q.data;
  const shiftName = (sid: number | null) =>
    sid == null ? "off" : shifts.data?.find((s: any) => s.id === sid)?.name ?? "—";

  // What actually happens on a given weekday, and why — a bare "default"
  // told nobody which shift that resolves to.
  const effectiveDay = (dow: number): { label: string; source: string } => {
    const p = e.pattern?.find((x: any) => x.dow === dow);
    if (p) {
      return p.shift_id == null
        ? { label: "Off", source: "Set for this day" }
        : { label: shiftName(p.shift_id), source: "Set for this day" };
    }
    if (e.off_dow === dow) return { label: "Off", source: "Weekly off" };
    return e.default_shift_id != null
      ? { label: shiftName(e.default_shift_id), source: "Default shift" }
      : { label: "No shift set", source: "No default shift" };
  };

  const perDay = Math.round((e.per_day_rupees ?? 0) * 100);
  const monthly = Math.round((e.monthly_salary_rupees ?? 0) * 100);

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-xl font-semibold text-accent">
          {e.name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{e.name}</h1>
          <p className="text-sm text-ink-faint">
            {e.designation || "—"} · joined {e.join_date ? fmtDateShort(e.join_date) : "?"}
          </p>
        </div>
        {me?.role === "owner" && <EditPerson emp={e} shifts={shifts.data ?? []} />}
      </header>
      {shifts.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <ErrorNote msg="Couldn't load shift names." />
          <Button size="sm" variant="outline" disabled={shifts.isFetching}
                  onClick={() => void shifts.refetch()}>
            {shifts.isFetching ? "Retrying shifts…" : "Retry shifts"}
          </Button>
        </div>
      )}

      <Card className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-3">
        <Fact label="Phone" value={e.phone || "—"} />
        <Fact label="Status" value={<Badge tone={e.working_status === "active" ? "good" : "warn"}>{e.working_status}</Badge>} />
        <Fact label="Weekly off" value={e.off_dow != null ? DOW_LABELS[e.off_dow] : "—"} />
        <Fact label="Preferred off" value={e.pref_off_dow != null ? DOW_LABELS[e.pref_off_dow] : "—"} />
        <Fact label="Backup person"
              value={e.backup_employee_id
                ? <Link className="text-accent underline" to={`/staff/people/${e.backup_employee_id}`}>view</Link>
                : "—"} />
        <Fact label="Default shift" value={shiftName(e.default_shift_id)} />
        {me?.role === "owner" && (
          <>
            <Fact label="Monthly salary" value={inr(monthly)} />
            <Fact label="Per-day rate" value={`${inr(perDay)} / day`}
                  hint={monthly
                    ? `${inr(monthly)} a month ÷ ${e.divisor} paid days`
                    : `Monthly salary ÷ ${e.divisor} paid days`} />
          </>
        )}
      </Card>

      {/* Week pattern */}
      <Card className="px-4 py-4">
        <SectionLabel>Weekly shift pattern</SectionLabel>
        <p className="mt-1 text-xs text-ink-faint">
          What each day resolves to today — a day with nothing set falls back to the default shift.
        </p>
        {me?.role !== "owner" && (
          <p className="mt-2 text-xs text-ink-faint">Patterns are set by the owner.</p>
        )}
        {/* Mobile reads all seven days down the page; sideways scrolling hid
            the end of the week behind the card edge. */}
        <ul className="mt-3 divide-y divide-rule sm:hidden">
          {DOW_LABELS.map((d, i) => {
            const { label, source } = effectiveDay(i);
            return (
              <li key={d} className="flex items-baseline gap-3 py-2">
                <span className="w-10 shrink-0 text-sm font-medium">{d}</span>
                <span className="min-w-0 flex-1 text-sm">{label}</span>
                <span className="shrink-0 text-xs text-ink-faint">{source}</span>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 hidden grid-cols-7 gap-1.5 sm:grid">
          {DOW_LABELS.map((d, i) => {
            const { label, source } = effectiveDay(i);
            const set = e.pattern?.some((x: any) => x.dow === i);
            return (
              <div key={d} className={`min-w-0 rounded-md border px-1.5 py-2 text-center text-xs ${
                label === "Off" ? "border-rule bg-paper-3 text-ink-soft"
                : set ? "border-rule-strong" : "border-dashed border-rule"}`}>
                <div className="font-medium">{d}</div>
                <div className="mt-0.5 truncate" title={label}>{label}</div>
                <div className={`mt-0.5 truncate text-[11px] ${
                  label === "Off" ? "text-ink-soft" : "text-ink-faint"}`} title={source}>{source}</div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="px-4 py-4 text-sm leading-relaxed text-ink-soft">
        <SectionLabel>Notes</SectionLabel>
        <p className="mt-2 whitespace-pre-wrap">{e.notes || "—"}</p>
      </Card>

      {me?.role === "owner" && (
        <>
          <DocumentsCard emp={e} personUrl={`/api/staff/employees/${e.id}`} />
        </>
      )}
    </div>
  );
}

function DocumentsCard({ emp }: { emp: any; personUrl?: string }) {
  const qc = useQueryClient();
  const [aadhaar, setAadhaar] = useState<string | null>(null);
  const [pan, setPan] = useState<string | null>(null);

  const saveNums = useMutation({
    mutationFn: (body: any) => api.patch(`/staff/employees/${emp.id}/kyc`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["person", String(emp.id)] }),
  });
  const upload = useMutation({
    mutationFn: ({ kind, f }: { kind: string; f: File }) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.post(`/staff/employees/${emp.id}/doc/${kind}`, fd);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["person", String(emp.id)] }),
  });

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-rule bg-paper-3/50 px-4 py-2.5">
        <SectionLabel>Documents · visible only to you</SectionLabel>
      </div>
      <DocRecord kind="aadhaar" label="Aadhaar" placeholder="XXXX XXXX XXXX"
                 draft={aadhaar} setDraft={setAadhaar} saved={emp.aadhaar_no}
                 path={emp.aadhaar_doc_path} uploading={upload.isPending}
                 onSaveNumber={(v) => saveNums.mutate({ aadhaar_no: v })}
                 onPickFile={(f) => upload.mutate({ kind: "aadhaar", f })} />
      <DocRecord kind="pan" label="PAN" placeholder="ABCDE1234F"
                 draft={pan} setDraft={setPan} saved={emp.pan_no}
                 path={emp.pan_doc_path} uploading={upload.isPending}
                 onSaveNumber={(v) => saveNums.mutate({ pan_no: v })}
                 onPickFile={(f) => upload.mutate({ kind: "pan", f })} />
      <p className="px-4 py-2.5 text-xs text-ink-faint">
        Numbers save when you leave the field; images are stored privately — managers can never open them.
      </p>
    </Card>
  );
}

/** One document = one bounded record: its own title row, its own number field,
 * its own attach control. Defined at module level so typing a number never
 * remounts the field. */
function DocRecord({
  kind, label, placeholder, draft, setDraft, saved, path, uploading,
  onSaveNumber, onPickFile,
}: {
  kind: "aadhaar" | "pan"; label: string; placeholder: string;
  draft: string | null; setDraft: (v: string | null) => void;
  saved: string | null; path: string | null; uploading: boolean;
  onSaveNumber: (v: string) => void; onPickFile: (f: File) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const shown = draft ?? saved ?? "";
  const dirty = draft != null && draft !== (saved ?? "");
  return (
    <section className="border-b border-rule px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <FileBadge size={16} className="shrink-0 text-ink-faint" />
        <span className="text-sm font-medium">{label}</span>
        {dirty
          ? <Badge tone="warn">unsaved</Badge>
          : path ? <Badge tone="good">image on file</Badge>
                 : <Badge tone="neutral">no image</Badge>}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-center">
        <Input aria-label={`${label} number`} placeholder={placeholder} value={shown}
               onChange={(ev) => setDraft(ev.target.value)}
               onBlur={() => { if (dirty) onSaveNumber((draft ?? "").trim()); }} />
        <div className="flex items-center gap-2">
          <input ref={file} type="file" hidden accept="image/*,.pdf"
                 aria-label={`${label} image file`}
                 onChange={(ev) => {
                   const f = ev.target.files?.[0];
                   if (f) onPickFile(f);
                 }} />
          <Button size="sm" variant="outline" className="flex-1 sm:flex-none"
                  onClick={() => file.current?.click()}>
            <Camera size={14} /> {path ? "Replace image" : "Attach image"}
          </Button>
          {path && (
            <a href={path} target="_blank" rel="noreferrer" className="shrink-0"
               aria-label={`Open ${label} image`}>
              <img src={path} alt={`${label} document`}
                   className="h-11 w-14 rounded border border-rule object-cover hover:border-accent" />
            </a>
          )}
        </div>
      </div>
      {uploading && <p className="mt-1.5 text-xs text-ink-faint">Uploading {kind} image…</p>}
    </section>
  );
}

function Fact({ label, value, hint }: {
  label: string; value: React.ReactNode; hint?: string;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

function EditPerson({ emp, shifts }: { emp: any; shifts: any[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const saved = useMemo(() => ({
    name: emp.name, phone: emp.phone ?? "", designation: emp.designation ?? "",
    monthly_salary_rupees: String(emp.monthly_salary_rupees ?? ""),
    divisor: String(emp.divisor ?? 26),
    working_status: emp.working_status,
    default_shift_id: emp.default_shift_id ?? "",
    off_dow: emp.off_dow ?? "",
    pref_off_dow: emp.pref_off_dow ?? "",
    upi_id: emp.upi_id ?? "",
    notes: emp.notes ?? "",
  }), [emp]);
  const [f, setF] = useState<any>(() => saved);
  const [err, setErr] = useState("");
  const set = (k: string) => (ev: any) => setF((x: any) => ({ ...x, [k]: ev.target.value }));

  const save = useMutation({
    mutationFn: () => api.patch(`/staff/employees/${emp.id}`, {
      ...f,
      monthly_salary_rupees: Number(f.monthly_salary_rupees) || undefined,
      divisor: Number(f.divisor) || undefined,
      off_dow: f.off_dow === "" ? null : Number(f.off_dow),
      pref_off_dow: f.pref_off_dow === "" ? null : Number(f.pref_off_dow),
      default_shift_id: f.default_shift_id || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person", String(emp.id)] });
      qc.invalidateQueries({ queryKey: ["people"] });
      setOpen(false); setErr("");
    },
    onError: (ex: any) => setErr(ex.message),
  });
  const draft = useDirtyDraft({
    open, label: `edit of ${emp.name}`,
    values: f, pristine: saved,
    discard: () => { setF(saved); setErr(""); setOpen(false); },
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil size={14} /> Edit
      </Button>
      <Sheet open={open} onClose={draft.close} title={`Edit ${emp.name}`}>
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name"><Input value={f.name} onChange={set("name")} /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={set("phone")} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Designation"><Input value={f.designation} onChange={set("designation")} /></Field>
            <Field label="Status">
              <Select value={f.working_status} onChange={set("working_status")}>
                <option value="active">active</option>
                <option value="notice">notice</option>
                <option value="left">left</option>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Monthly salary (₹)">
              <Input inputMode="decimal" value={f.monthly_salary_rupees}
                     onChange={set("monthly_salary_rupees")} className="text-right" />
            </Field>
            <Field label="÷ divisor" hint={`per-day = salary ÷ ${f.divisor || 26}`}>
              <Input inputMode="numeric" value={f.divisor}
                     onChange={set("divisor")} className="text-right" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default shift">
              <Select value={f.default_shift_id} onChange={set("default_shift_id")}>
                <option value="">—</option>
                {shifts.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Weekly off">
              <Select value={f.off_dow} onChange={set("off_dow")}>
                <option value="">—</option>
                {DOW_LABELS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Preferred off">
              <Select value={f.pref_off_dow} onChange={set("pref_off_dow")}>
                <option value="">—</option>
                {DOW_LABELS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </Field>
            <Field label="UPI id"><Input value={f.upi_id} onChange={set("upi_id")} /></Field>
          </div>
          <Field label="Notes"><Input value={f.notes} onChange={set("notes")} /></Field>
          <ErrorNote msg={err} />
          <Button size="lg" className="w-full" disabled={!f.name.trim() || save.isPending}
                  onClick={() => save.mutate()}>
            Save changes
          </Button>
        </div>
      </Sheet>
    </>
  );
}
