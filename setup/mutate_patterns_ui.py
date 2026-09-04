"""Break Patterns.tsx on purpose and check the component tests notice."""
import io
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

WEB = Path(__file__).resolve().parents[1] / "web"
SRC = WEB / "src" / "components" / "Patterns.tsx"

MUTATIONS = [
    ("draw hours the shop was shut, inventing a 03:00 trade",
     "const hours = (d?.hours ?? []).filter((h: any) => h.bills > 0);",
     "const hours = (d?.hours ?? []);"),

    ("draw weekdays the shop never opened",
     'weekdays.filter((w: any) => w.days_open > 0).map',
     'weekdays.map'),

    ("show an unforecastable day as ₹0 instead of admitting it",
     '{f.rupees == null ? "—" : money(f.rupees)}',
     '{money(f.rupees ?? 0)}'),

    ("colour a price fall like a rise",
     'const tone = pct > 0 ? "text-bad" : pct < 0 ? "text-good" : "text-ink-faint";',
     'const tone = "text-bad";'),

    ("treat a one-off purchase as a flat price rather than unknown",
     "if (pct == null) return <span className=\"text-ink-faint\">—</span>;",
     "pct = pct ?? 0;"),

    ("always send outlet_id, ignoring the all-outlets scope",
     '`?start=${start}&end=${end}` + (outletId ? `&outlet_id=${outletId}` : "")',
     '`?start=${start}&end=${end}&outlet_id=${outletId}`'),

    ("ignore the range and always ask for everything",
     "queryFn: () => api.get(`/patterns/bills${qs(start, end, outletId)}`),",
     "queryFn: () => api.get(`/patterns/bills`),"),

    ("dump every item on the page instead of the top few",
     "const shown = showAll ? items : items.slice(0, 8);",
     "const shown = items;"),

    ("show an empty period as if it had data",
     "{d && d.totals.bills === 0 ? (",
     "{false ? ("),
]


def run() -> bool:
    r = subprocess.run(["npx", "vitest", "run", "src/components/Patterns.test.tsx"],
                       cwd=WEB, capture_output=True, text=True, shell=True,
                       encoding="utf-8", errors="replace")
    return r.returncode == 0


def main() -> int:
    original = SRC.read_text(encoding="utf-8")
    if not run():
        print("baseline is already red — fix that first")
        return 1
    print("baseline green\n")

    missed = []
    try:
        for name, old, new in MUTATIONS:
            if old not in original:
                print(f"SKIP  {name}\n      anchor moved: {old!r}")
                return 1
            SRC.write_text(original.replace(old, new, 1), encoding="utf-8")
            if run():
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
