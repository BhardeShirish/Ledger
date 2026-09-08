import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import { useGuarded } from "../lib/auth";
import {
  Button, Card, ErrorNote, Field, Input, SectionLabel, Select, Spinner,
} from "./ui";

const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

function thisMonth() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Rent, internet, licences and insurance — the costs most often missing
 * from a small restaurant's books.
 *
 * Their absence does not merely understate spending: it makes margin,
 * break-even and every benchmark ratio wrong, which is worse than having
 * no figures at all, because a wrong figure gets believed. Recorded once
 * here, they post themselves every month.
 */
export function StandingCostsCard() {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const [adding, setAdding] = useState(false);

  const q = useQuery({ queryKey: ["recurring"], queryFn: () => api.get("/recurring") });
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get("/lists/categories"),
  });

  const stop = useMutation({
    mutationFn: (id: number) => guarded(() => api.del(`/recurring/${id}`)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring"] }),
  });
  const review = useMutation({
    mutationFn: (id: number) => guarded(() => api.post(`/recurring/${id}/review`)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurring"] });
      qc.invalidateQueries({ queryKey: ["intelligence-brief"] });
    },
  });

  const items = q.data?.items ?? [];
  const catList = Array.isArray(cats.data) ? cats.data : (cats.data?.items ?? []);

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Costs that repeat every month</SectionLabel>
        {q.data && (
          <span className="text-xs text-ink-faint">
            {money(q.data.monthly_total_rupees)} a month
          </span>
        )}
      </div>

      <p className="text-xs text-ink-faint">
        Enter rent, internet, licences and insurance once. They post
        themselves on the day you choose, so your margin and break-even stop
        being guesses. Nothing is posted for a month that hasn't arrived.
      </p>

      {q.isLoading && <Spinner />}
      {q.isError && <ErrorNote msg="Couldn't load your standing costs." />}

      {items.length > 0 && (
        <ul className="divide-y divide-rule">
          {items.filter((r: any) => r.is_active).map((r: any) => (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {r.name || r.category}
                </p>
                <p className="text-xs text-ink-faint">
                  {r.category} · day {r.day_of_month} · {money(r.yearly_rupees)}/year
                  {r.review_due ? " · review due" : ` · next review ${r.next_review_date}`}
                </p>
              </div>
              <span className="shrink-0 tabular-nums text-sm font-semibold">
                {money(r.amount_rupees)}
              </span>
              <button type="button" aria-label={`Review ${r.name || r.category}`}
                      title={r.review_due ? "Record owner review" : "Reviewed"}
                      onClick={() => review.mutate(r.id)}
                      className={`shrink-0 rounded p-1 ${r.review_due ? "text-amber-700 hover:text-good" : "text-good hover:text-accent"}`}>
                <Check size={16} />
              </button>
              <button type="button" aria-label={`Stop ${r.name || r.category}`}
                      onClick={() => stop.mutate(r.id)}
                      className="shrink-0 rounded p-1 text-ink-faint hover:text-bad">
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {items.filter((r: any) => r.is_active).length === 0 && !q.isLoading && (
        <p className="text-sm text-ink-faint">
          Nothing set yet — your rent is missing from every report.
        </p>
      )}

      {adding ? (
        <AddStandingCost categories={catList}
                         onDone={() => {
                           setAdding(false);
                           qc.invalidateQueries({ queryKey: ["recurring"] });
                           qc.invalidateQueries({ queryKey: ["pnl"] });
                         }}
                         onCancel={() => setAdding(false)} />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus size={16} /> Add a monthly cost
        </Button>
      )}

      {items.some((r: any) => !r.is_active) && (
        <p className="text-xs text-ink-faint">
          Stopped costs keep the months they already posted — that rent was
          really paid, and removing it would silently improve a closed month.
        </p>
      )}
    </Card>
  );
}

function AddStandingCost({ categories, onDone, onCancel }: {
  categories: any[]; onDone: () => void; onCancel: () => void;
}) {
  const guarded = useGuarded();
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState("1");
  const [reviewCadence, setReviewCadence] = useState("90");
  const [start, setStart] = useState(thisMonth());
  const [err, setErr] = useState("");

  const add = useMutation({
    mutationFn: () => guarded(() => api.post("/recurring", {
      category_id: Number(categoryId),
      name: name.trim(),
      amount_rupees: Number(amount),
      day_of_month: Number(day),
      start_month: start,
      review_cadence_days: Number(reviewCadence),
    })),
    onSuccess: onDone,
    onError: (e: any) => setErr(e?.message || "Couldn't save that."),
  });

  const ready = categoryId && Number(amount) > 0 && Number(reviewCadence) >= 1
    && /^\d{4}-\d{2}$/.test(start);

  return (
    <div className="space-y-3 rounded-md border border-rule-strong bg-paper-2 p-3">
      <Field label="What is it?" hint="Shop rent, internet, FSSAI licence…">
        <Input value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Shop rent" />
      </Field>
      <Field label="Category">
        <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Pick one…</option>
          {categories.map((c: any) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.cost_group_label ? ` — ${c.cost_group_label}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Amount (₹)">
          <Input inputMode="decimal" value={amount} className="text-right"
                 onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Day of month" hint="Short months use their last day">
          <Input inputMode="numeric" value={day} className="text-right"
                 onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Paying since" hint="YYYY-MM">
          <Input value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Review every (days)">
          <Input inputMode="numeric" value={reviewCadence} className="text-right"
                 onChange={(e) => setReviewCadence(e.target.value)} />
        </Field>
      </div>
      {err && <ErrorNote msg={err} />}
      <p className="text-xs text-ink-faint">
        Every month from “paying since” up to today will be posted now, so
        your past months stop looking cheaper than they were.
      </p>
      <div className="flex gap-2">
        <Button disabled={!ready || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * Which P&L line each category belongs to.
 *
 * Grouping is what turns a spend log into a P&L: every published
 * restaurant benchmark is stated per group, never per category. The
 * guesses here are only a starting point — an owner who puts packaging
 * under running costs rather than food is not wrong, and their choice is
 * what the report uses.
 */
export function CostGroupsCard() {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const groups = useQuery({
    queryKey: ["cost-groups"], queryFn: () => api.get("/lists/cost-groups"),
  });
  const cats = useQuery({
    queryKey: ["categories"], queryFn: () => api.get("/lists/categories"),
  });

  const retag = useMutation({
    mutationFn: ({ id, group }: { id: number; group: string }) =>
      guarded(() => api.patch(`/lists/categories/${id}/group`, { cost_group: group })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
    },
  });

  const groupList = Array.isArray(groups.data) ? groups.data : (groups.data?.items ?? []);
  const catList = Array.isArray(cats.data) ? cats.data : (cats.data?.items ?? []);

  return (
    <Card className="space-y-4 p-5">
      <SectionLabel>Which line each cost sits on</SectionLabel>
      <p className="text-xs text-ink-faint">
        Your P&amp;L compares food, labour, rent and running costs against the
        bands a healthy restaurant sits in. If something is on the wrong
        line, change it here and the report follows.
      </p>

      {(groups.isLoading || cats.isLoading) && <Spinner />}
      {(groups.isError || cats.isError) && (
        <ErrorNote msg="Couldn't load your categories." />
      )}

      <ul className="divide-y divide-rule">
        {catList.map((c: any) => (
          <li key={c.id} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
            <Select aria-label={`P&L line for ${c.name}`}
                    className="w-44 shrink-0"
                    value={c.cost_group ?? "operating"}
                    onChange={(e) =>
                      retag.mutate({ id: c.id, group: e.target.value })}>
              {groupList.map((g: any) => (
                <option key={g.key} value={g.key}>{g.label}</option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
    </Card>
  );
}


/**
 * The healthy bands the P&L judges every line against.
 *
 * Published restaurant benchmarks assume a high-street dine-in room. A
 * cloud kitchen pays almost no rent and a mall counter pays a fortune, so
 * a fixed band would tell one of them off for running a good business —
 * and worse, the report treats a figure far below its band as unlogged
 * rather than excellent. Getting these right is what makes the verdicts
 * mean anything.
 */
export function HealthyBandsCard() {
  const qc = useQueryClient();
  const guarded = useGuarded();
  const [draft, setDraft] = useState<Record<string, [string, string]>>({});
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");

  const q = useQuery({ queryKey: ["pnl-bands"], queryFn: () => api.get("/pnl/bands") });
  const items = q.data?.items ?? [];

  const valueOf = (row: any): [string, string] =>
    draft[row.key] ?? [String(row.low), String(row.high)];

  const edit = (key: string, which: 0 | 1, v: string) =>
    setDraft((d) => {
      const row = items.find((r: any) => r.key === key);
      const cur: [string, string] = d[key] ?? [String(row.low), String(row.high)];
      const next: [string, string] = which === 0 ? [v, cur[1]] : [cur[0], v];
      return { ...d, [key]: next };
    });

  const save = useMutation({
    mutationFn: (body: Record<string, number[]>) =>
      guarded(() => api.put("/pnl/bands", body)),
    onSuccess: () => {
      setDraft({});
      setErr("");
      setSaved("Saved — the report now judges you against these.");
      qc.invalidateQueries({ queryKey: ["pnl-bands"] });
      qc.invalidateQueries({ queryKey: ["pnl"] });
    },
    onError: (e: any) => { setSaved(""); setErr(e.message); },
  });

  const submit = () => {
    const body: Record<string, number[]> = {};
    for (const row of items) {
      const [lo, hi] = valueOf(row);
      body[row.key] = [Number(lo), Number(hi)];
    }
    const bad = items.find((row: any) => {
      const [lo, hi] = body[row.key];
      return !Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi
        || lo < 0 || hi > 100;
    });
    if (bad) {
      setSaved("");
      setErr(`${bad.label}: give a low and a high between 0 and 100, with the low smaller than the high.`);
      return;
    }
    save.mutate(body);
  };

  const restore = () => {
    const body: Record<string, number[]> = {};
    for (const row of items) body[row.key] = [row.default_low, row.default_high];
    save.mutate(body);
  };

  const dirty = Object.keys(draft).length > 0;
  const anyCustom = items.some((r: any) => r.is_custom);

  return (
    <Card className="space-y-4 p-5">
      <SectionLabel>Healthy bands</SectionLabel>
      <p className="text-xs text-ink-faint">
        What counts as normal for your shop, as a share of sales before GST.
        The standard figures suit a high-street dine-in place; a cloud
        kitchen or a mall counter should change the rent line. Leave them
        alone if you are not sure.
      </p>

      {q.isLoading && <Spinner />}
      {q.isError && <ErrorNote msg="Couldn't load the bands." />}

      {items.length > 0 && (
        <ul className="divide-y divide-rule">
          {items.map((row: any) => {
            const [lo, hi] = valueOf(row);
            return (
              <li key={row.key} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.label}</p>
                  <p className="text-xs text-ink-faint">{row.hint}</p>
                </div>
                <Input inputMode="decimal" aria-label={`${row.label} low`}
                       value={lo} className="w-16 text-center"
                       onChange={(e) => edit(row.key, 0, e.target.value)} />
                <span className="text-xs text-ink-faint">to</span>
                <Input inputMode="decimal" aria-label={`${row.label} high`}
                       value={hi} className="w-16 text-center"
                       onChange={(e) => edit(row.key, 1, e.target.value)} />
                <span className="w-3 text-xs text-ink-faint">%</span>
              </li>
            );
          })}
        </ul>
      )}

      {err && <ErrorNote msg={err} />}
      {saved && !dirty && <p className="text-xs text-good">{saved}</p>}

      <div className="flex flex-wrap gap-2">
        <Button disabled={!dirty || save.isPending} onClick={submit}>
          Save bands
        </Button>
        {(anyCustom || dirty) && (
          <Button variant="outline" disabled={save.isPending}
                  onClick={() => { setDraft({}); restore(); }}>
            Back to standard
          </Button>
        )}
      </div>
    </Card>
  );
}