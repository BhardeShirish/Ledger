"""Break the surplus-explanation rule on purpose and check its tests notice.

The rule's whole value is its asymmetry: a surplus inside the band is
arithmetic, a shortage never is. Every mutation below relaxes it in a way
that would either wave away a real shortage or keep crying wolf.

    python setup\\mutate_cashdoubt.py
"""
import io
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SRC = WEB / "src" / "lib" / "cashdoubt.ts"
TEST = "src/lib/cashdoubt.test.ts"

MUTATIONS = [
    ("explain a shortage as well, waving away money that has gone missing",
     "return variancePaise > 0 && variancePaise <= splitUnknownPaise;",
     "return Math.abs(variancePaise) <= splitUnknownPaise;"),

    ("explain a surplus of any size, however far past what could be cash",
     "return variancePaise > 0 && variancePaise <= splitUnknownPaise;",
     "return variancePaise > 0;"),

    ("explain nothing, so a busy day always looks like a discrepancy",
     "return variancePaise > 0 && variancePaise <= splitUnknownPaise;",
     "return false;"),

    ("call an exact count 'explained' rather than exact",
     "return variancePaise > 0 && variancePaise <= splitUnknownPaise;",
     "return variancePaise >= 0 && variancePaise <= splitUnknownPaise;"),

    ("stop at the band instead of including it, nagging about the exact case",
     "variancePaise <= splitUnknownPaise;",
     "variancePaise < splitUnknownPaise;"),
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
