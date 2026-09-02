import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { useRef, useState } from "react";
import { Camera, FileBadge, Pencil } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { DOW_LABELS, fmtDateShort, inr } from "../lib/format";
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
  const e = q.data;
  const shiftName = (sid: number | null) =>
    sid == null ? "off" : shifts.data?.find((s: any) => s.id === sid)?.name ?? "—";

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
            <Fact label="Monthly salary" value={inr(Math.round((e.monthly_salary_rupees ?? 0) * 100))} />
            <Fact label="Per-day rate" value={`${inr(Math.round((e.per_day_rupees ?? 0) * 100))} ÷${e.divisor}`} />
          </>
        )}
      </Card>

      {/* Week pattern */}
      <Card className="px-4 py-4">
        <SectionLabel>Weekly shift pattern</SectionLabel>
        {me?.role !== "owner" && (
          <p className="mt-2 text-xs text-ink-faint">Patterns are set by the owner.</p>
        )}
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {DOW_LABELS.map((d, i) => {
            const dow = i;
            const p = e.pattern?.find((x: any) => x.dow === dow);
            return (
              <div key={d} className={`w-16 shrink-0 rounded-md border px-1 py-2 text-center text-xs ${
                p && p.shift_id == null ? "border-rule bg-paper-3 text-ink-faint"
                : p ? "border-rule-strong" : "border-dashed border-rule text-ink-faint"}`}>
                <div className="font-medium">{d}</div>
                <div className="mt-0.5 truncate">{p ? shiftName(p.shift_id) : "default"}</div>
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
  const aFile = useRef<HTMLInputElement>(null);
  const pFile = useRef<HTMLInputElement>(null);

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

  const DocRow = ({ kind, label, numberVal, setNumberVal, path }: {
    kind: "aadhaar" | "pan"; label: string;
    numberVal: string | null; setNumberVal: (v: string | null) => void;
    path: string | null;
  }) => {
    const savedNumber = kind === "aadhaar" ? emp.aadhaar_no : emp.pan_no;
    const shown = numberVal ?? savedNumber ?? "";
    const dirty = numberVal != null && numberVal !== savedNumber;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-3 last:border-0">
        <FileBadge size={16} className="shrink-0 text-ink-faint" />
        <span className="w-20 shrink-0 text-sm font-medium">{label}</span>
        <input
          placeholder={kind === "aadhaar" ? "XXXX XXXX XXXX" : "ABCDE1234F"}
          value={shown}
          onChange={(ev) => (kind === "aadhaar" ? setAadhaar : setPan)(ev.target.value)}
          onBlur={() => {
            const v = (numberVal ?? "").trim();
            if (dirty) saveNums.mutate(kind === "aadhaar" ? { aadhaar_no: v } : { pan_no: v });
          }}
          className="num w-44 rounded-md border border-rule-strong bg-paper px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
        {dirty && <Badge tone="warn">unsaved</Badge>}
        <input ref={kind === "aadhaar" ? aFile : pFile} type="file" hidden accept="image/*,.pdf"
               onChange={(ev) => {
                 const f = ev.target.files?.[0];
                 if (f) upload.mutate({ kind, f });
               }} />
        <Button size="sm" variant="ghost" onClick={() =>
          (kind === "aadhaar" ? aFile : pFile).current?.click()}>
          <Camera size={14} /> {path ? "Replace image" : "Attach image"}
        </Button>
        {upload.isPending && <span className="text-xs text-ink-faint">uploading…</span>}
        {path && (
          <a href={path} target="_blank" rel="noreferrer">
            <img src={path} alt={`${label} document`}
                 className="h-9 w-12 rounded border border-rule object-cover hover:border-accent" />
          </a>
        )}
      </div>
    );
  };

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-rule bg-paper-3/50 px-4 py-2.5">
        <SectionLabel>Documents · visible only to you</SectionLabel>
      </div>
      <DocRow kind="aadhaar" label="Aadhaar" numberVal={aadhaar}
              setNumberVal={setAadhaar} path={emp.aadhaar_doc_path} />
      <DocRow kind="pan" label="PAN" numberVal={pan}
              setNumberVal={setPan} path={emp.pan_doc_path} />
      <p className="px-4 py-2 text-xs text-ink-faint">
        Numbers save on blur; images are stored privately — managers can never open them.
      </p>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
    </div>
  );
}

function EditPerson({ emp, shifts }: { emp: any; shifts: any[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>(() => ({
    name: emp.name, phone: emp.phone ?? "", designation: emp.designation ?? "",
    monthly_salary_rupees: String(emp.monthly_salary_rupees ?? ""),
    divisor: String(emp.divisor ?? 26),
    working_status: emp.working_status,
    default_shift_id: emp.default_shift_id ?? "",
    off_dow: emp.off_dow ?? "",
    pref_off_dow: emp.pref_off_dow ?? "",
    upi_id: emp.upi_id ?? "",
    notes: emp.notes ?? "",
  }));
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

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil size={14} /> Edit
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Edit ${emp.name}`}>
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
