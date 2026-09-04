"""Break the Settings cards on purpose and check their tests notice.

These three cards are what make the P&L honest: standing costs stop rent
going missing, cost groups decide which line a spend lands on, and the
bands decide what "healthy" even means. A silent failure here does not
look like a bug — it looks like a verdict.

    python setup\\mutate_standingcosts.py
"""
import io
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SRC = WEB / "src" / "components" / "StandingCosts.tsx"
TEST = "src/components/StandingCosts.test.tsx"

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


def run_tests() -> bool:
    r = subprocess.run(["npx", "vitest", "run", TEST],
                       cwd=WEB, capture_output=True, text=True, shell=True,
                       encoding="utf-8", errors="replace")
    return r.returncode == 0


def main() -> int:
    original = SRC.read_text(encoding="utf-8")

    if not run_tests():
        print("baseline is already red — fix that first")
        return 1
    print("baseline green\n")

    missed = []
    try:
        for name, old, new in MUTATIONS:
            if original.count(old) != 1:
                print(f"SKIP  {name}\n      anchor hit {original.count(old)} times")
                return 1
            SRC.write_text(original.replace(old, new, 1), encoding="utf-8")
            if run_tests():
                print(f"MISSED  {name}")
                missed.append(name)
            else:
                print(f"caught  {name}")
    finally:
        SRC.write_text(original, encoding="utf-8")

    print()
    if missed:
        print(f"{len(missed)} mutation(s) survived — those rules are untested:")
        for m in missed:
            print(f"  - {m}")
        return 1
    print(f"all {len(MUTATIONS)} mutations caught")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
