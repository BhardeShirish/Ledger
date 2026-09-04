"""Break the Settings cards on purpose and check their tests notice.

These three cards are what make the P&L honest: standing costs stop rent
going missing, cost groups decide which line a spend lands on, and the
bands decide what "healthy" even means. A silent failure here does not
look like a bug — it looks like a verdict.

    python setup\\mutate_standingcosts.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

SRC = "web/src/components/StandingCosts.tsx"

MUTATIONS = [
    # --- standing costs -------------------------------------------------
    ("list costs the owner already stopped, as if they were still running",
     "{items.filter((r: any) => r.is_active).map((r: any) => (",
     "{items.map((r: any) => ("),

    ("drop the monthly total, so nobody sees what the fixed nut is",
     "{money(q.data.monthly_total_rupees)} a month",
     "a month"),

    ("hide the yearly weight, which is the number that actually stings",
     "{r.category} · day {r.day_of_month} · {money(r.yearly_rupees)}/year",
     "{r.category} · day {r.day_of_month}"),

    ("stay quiet when a shop has entered no standing costs at all",
     "Nothing set yet — your rent is missing from every report.",
     " "),

    ("show an empty card instead of admitting the list failed to load",
     '{q.isError && <ErrorNote msg="Couldn\'t load your standing costs." />}',
     "{null}"),

    ("stop a different cost from the one the owner clicked",
     "onClick={() => stop.mutate(r.id)}",
     "onClick={() => stop.mutate(1)}"),

    ("drop the promise that stopping a cost keeps its history",
     "Stopped costs keep the months they already posted — that rent was",
     "Stopped costs are removed from the books — that rent was"),

    # --- cost groups ----------------------------------------------------
    ("retag a category to the wrong P&L line",
     "retag.mutate({ id: c.id, group: e.target.value })",
     'retag.mutate({ id: c.id, group: "admin" })'),

    # --- healthy bands --------------------------------------------------
    ("send only the edited line, letting the others drift to default",
     "for (const row of items) {",
     "for (const row of items.filter((r: any) => draft[r.key])) {"),

    ("accept a reversed band and let the server decide what it means",
     "return !Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi",
     "return !Number.isFinite(lo) || !Number.isFinite(hi) || false",),

    ("accept a band outside 0-100, which is not a share of anything",
     "|| lo < 0 || hi > 100;",
     "|| false;"),

    ("let words through where a number belongs",
     "body[row.key] = [Number(lo), Number(hi)];",
     "body[row.key] = [Number(lo) || 0, Number(hi) || 100];"),

    ("swallow the reason a save was refused",
     "setErr(`${bad.label}: give a low and a high between 0 and 100, with the low smaller than the high.`);",
     'setErr("");'),

    ("swallow the server's complaint",
     "onError: (e: any) => { setSaved(\"\"); setErr(e.message); },",
     'onError: () => { setSaved(""); setErr(""); },'),

    ("restore something other than the published figures",
     "for (const row of items) body[row.key] = [row.default_low, row.default_high];",
     "for (const row of items) body[row.key] = [row.low, row.high];"),

    ("offer 'back to standard' to a shop that never left it",
     "{(anyCustom || dirty) && (",
     "{true && (",),

    ("let a save fire when nothing was changed",
     "<Button disabled={!dirty || save.isPending} onClick={submit}>",
     "<Button disabled={false} onClick={submit}>"),

    ("drop the explanation of what each band means",
     '<p className="text-xs text-ink-faint">{row.hint}</p>',
     '<p className="text-xs text-ink-faint" />'),

    ("show the high figure where the low one belongs",
     "const [lo, hi] = valueOf(row);\n            return (",
     "const [hi, lo] = valueOf(row);\n            return ("),

    ("say nothing when the bands cannot be loaded",
     '{q.isError && <ErrorNote msg="Couldn\'t load the bands." />}',
     "{null}"),
]


if __name__ == "__main__":
    raise SystemExit(check(['src/components/StandingCosts.test.tsx'], [(SRC, *m) for m in MUTATIONS], kind="web"))
