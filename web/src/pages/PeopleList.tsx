import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router-dom";
import { useRef, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";
import { ExportButton } from "../components/DataButtons";
import { DOW_LABELS, inr, todayISO } from "../lib/format";
import {
  Badge, Button, Card, ErrorNote, Field, Input, SectionLabel, Select,
  Sheet, Spinner,
} from "../components/ui";

type Ctx = { outletId: number };

export default function PeopleList() {
  const { outletId } = useOutletContext<Ctx>();
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["people", outletId],
    queryFn: () => api.get(`/staff/employees?outlet_id=${outletId}&include_inactive=true`),
  });
  const shifts = useQuery({ queryKey: ["shifts"], queryFn: () => api.get("/staff/shifts") });
  const [open, setOpen] = useState(false);

  if (q.isLoading) return <Spinner />;
  const rows: any[] = q.data ?? [];
  // The heading counts active staff, so showing everyone in one list makes the
  // number look wrong. Keep past staff reachable, just not in the way.
  const active = rows.filter((r) => r.working_status === "active");
  const former = rows.filter((r) => r.working_status !== "active");

  const personRow = (e: any, dim = false) => (
    <Link key={e.id} to={`/staff/people/${e.id}`}
          className={`flex items-center gap-3 px-4 py-3 hover:bg-paper-3/50 ${dim ? "opacity-60" : ""}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent">
        {e.name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{e.name}</span>
        <span className="block text-xs text-ink-faint">{e.designation || "—"}</span>
      </span>
      {"monthly_salary_rupees" in e && e.monthly_salary_rupees != null && (
        <span className="num hidden text-right text-sm sm:block">
          {e.monthly_salary_rupees > 0 ? (
            <>
              {inr(Math.round(e.monthly_salary_rupees * 100))}
              <span className="text-[10px] uppercase tracking-wide text-ink-faint"> /mo</span>
            </>
          ) : (
            // ₹0 a month is almost always a blank that was never filled in,
            // and payroll would quietly pay nothing.
            <span className="text-xs text-bad">salary not set</span>
          )}
        </span>
      )}
      {e.off_dow != null && <Badge>{DOW_LABELS[e.off_dow]} off</Badge>}
      {e.working_status !== "active" && <Badge tone="warn">{e.working_status}</Badge>}
    </Link>
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel>Staff · People</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight">{active.length} on the team</h1>
        </div>
        {me?.role === "owner" && (
          <div className="flex flex-wrap gap-2">
            <ExportButton entity="employees" params={{ outlet_id: outletId }} />
            <ImportSheetButton outletId={outletId} />
            <Button size="sm" onClick={() => setOpen(true)}>+ Add staff</Button>
          </div>
        )}
      </header>

      <Card className="divide-y divide-rule">
        {active.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-ink-faint">
            No one on the team yet. Add your staff to start marking attendance.
          </p>
        )}
        {active.map((e) => personRow(e))}
      </Card>

      {former.length > 0 && (
        <Card className="divide-y divide-rule">
          <div className="border-b border-rule px-4 py-2.5">
            <SectionLabel>No longer working here · {former.length}</SectionLabel>
          </div>
          {former.map((e) => personRow(e, true))}
        </Card>
      )}

      <AddPerson open={open} onClose={() => setOpen(false)} outletId={outletId}
                 shifts={shifts.data ?? []}
                 people={rows} />
    </div>
  );
}

function ImportSheetButton({ outletId }: { outletId: number }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const imp = useMutation({
    mutationFn: ({ file, confirm }: { file: File; confirm: boolean }) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post(
        `/staff/import-sheet?outlet_id=${outletId}&confirm=${confirm}`, fd,
      );
    },
    onSuccess: (d) => {
      setResult(d);
      if (d.committed) {
        setPendingFile(null);
        qc.invalidateQueries({ queryKey: ["people"] });
      }
    },
    onError: (e: any) => setErr(e.message),
  });

  return (
    <>
      <input ref={fileRef} type="file" accept=".xlsx,.xls" hidden
             onChange={(e) => {
               const file = e.target.files?.[0];
               if (file) {
                 setErr(""); setPendingFile(file);
                 imp.mutate({ file, confirm: false });
               }
             }} />
      <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
        <FileSpreadsheet size={14} /> Import from Excel
      </Button>
      <Sheet open={result != null || err !== ""} onClose={() => { setResult(null); setErr(""); }}
             title="Staff import result">
        {err ? <ErrorNote msg={err} /> : result && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-paper-2 px-2 py-2.5">
                <div className="num text-xl font-semibold">{result.created}</div>
                <div className="text-xs text-ink-faint">{result.committed ? "added" : "to add"}</div>
              </div>
              <div className="rounded-md bg-paper-2 px-2 py-2.5">
                <div className="num text-xl font-semibold">{result.updated}</div>
                <div className="text-xs text-ink-faint">{result.committed ? "updated" : "to update"}</div>
              </div>
              <div className="rounded-md bg-paper-2 px-2 py-2.5">
                <div className="num text-xl font-semibold">{result.backups_linked}</div>
                <div className="text-xs text-ink-faint">backups linked</div>
              </div>
            </div>
            {result.errors?.length > 0 && (
              <ul className="space-y-1 rounded-md border border-bad/30 bg-bad/10 p-2 text-bad">
                {result.errors.map((x: any) => <li key={x.name}>{x.name}: {x.error}</li>)}
              </ul>
            )}
            <p className="text-ink-faint">
              {result.committed
                ? "Import complete. Historical attendance and payroll were not changed."
                : `Review this preview. All staff will be assigned to the selected outlet before anything changes.`}
            </p>
            {result.committed ? (
              <Button className="w-full" onClick={() => setResult(null)}>Done</Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1"
                        onClick={() => { setResult(null); setPendingFile(null); }}>
                  Cancel
                </Button>
                <Button className="flex-1" disabled={!pendingFile || imp.isPending}
                        onClick={() => pendingFile &&
                          imp.mutate({ file: pendingFile, confirm: true })}>
                  Confirm import
                </Button>
              </div>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}

function AddPerson({ open, onClose, outletId, shifts, people }: any) {
  const qc = useQueryClient();
  const [f, setF] = useState<any>({
    name: "", phone: "", designation: "", monthly_salary_rupees: "",
    join_date: todayISO(), off_dow: "", pref_off_dow: "", default_shift_id: "",
    divisor: 26,
  });
  const [err, setErr] = useState("");
  const set = (k: string) => (e: any) => setF((x: any) => ({ ...x, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () => api.post("/staff/employees", {
      ...f,
      outlet_id: outletId,
      monthly_salary_rupees: Number(f.monthly_salary_rupees) || undefined,
      off_dow: f.off_dow === "" ? null : Number(f.off_dow),
      pref_off_dow: f.pref_off_dow === "" ? null : Number(f.pref_off_dow),
      default_shift_id: f.default_shift_id || null,
      pattern: [],
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["people"] });
      onClose();
      setF((x: any) => ({ ...x, name: "", phone: "", monthly_salary_rupees: "" }));
    },
    onError: (e: any) => setErr(e.message),
  });

  return (
    <Sheet open={open} onClose={onClose} title="Add staff member">
      <div className="space-y-3.5">
        <Field label="Full name"><Input autoFocus value={f.name} onChange={set("name")} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><Input value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Designation"><Input placeholder="Chef, Steward…" value={f.designation} onChange={set("designation")} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monthly salary" hint="÷26 becomes their per-day rate">
            <Input inputMode="decimal" value={f.monthly_salary_rupees} onChange={set("monthly_salary_rupees")} className="text-right" />
          </Field>
          <Field label="Divisor" hint="26 unless told otherwise">
            <Input inputMode="numeric" value={f.divisor} onChange={set("divisor")} className="text-right" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Join date"><Input type="date" value={f.join_date} onChange={set("join_date")} /></Field>
          <Field label="Default shift">
            <Select value={f.default_shift_id} onChange={set("default_shift_id")}>
              <option value="">—</option>
              {shifts.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weekly off">
            <Select value={f.off_dow} onChange={set("off_dow")}>
              <option value="">—</option>
              {DOW_LABELS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Select>
          </Field>
          <Field label="Preferred off">
            <Select value={f.pref_off_dow} onChange={set("pref_off_dow")}>
              <option value="">—</option>
              {DOW_LABELS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </Select>
          </Field>
        </div>
        <ErrorNote msg={err} />
        <Button size="lg" className="w-full" disabled={!f.name.trim() || create.isPending}
                onClick={() => create.mutate()}>
          Save staff member
        </Button>
      </div>
    </Sheet>
  );
}
