"""Prove the advisor tests fail when the advisor stops being honest.

A findings engine that quietly stops firing looks identical to a quiet
month, so every rule needs a test that dies when the rule dies.
"""
import io
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SRC = Path(__file__).resolve().parents[1] / "server" / "app" / "routers" / "advisor.py"
BAK = SRC.with_suffix(".py.mutbak")

MUTATIONS = [
    ("stop naming what drove the fixed-cost rise",
     'who = ", ".join(f"{c[\'category\']} {c[\'delta_rupees\']:+,.0f}"\n'
     '                        for c in movers[:4]) or "several small changes"',
     'who = "several small changes"'),
    ("suggest cutting a fixed cost",
     'variable = [c for c in f["categories"]\n'
     '                if not c["is_fixed"] and c["rupees"] > 0]',
     'variable = [c for c in f["categories"] if c["rupees"] > 0]'),
    ("send staff names to the model",
     's["joined"], s["left"] = len(s["joined"]), len(s["left"])',
     'pass'),
    ("compare a part month against a whole one",
     'phi_eff = min(phi, plo + timedelta(days=(hi_eff - lo).days)) if partial else phi',
     'phi_eff = phi'),
    ("invent a trend from a month nobody logged",
     'prev = t["prev_spend_percent_of_sales"] if comparable else None',
     'prev = t["prev_spend_percent_of_sales"]'),
    ("miss a supplier price rise",
     'if i["delta_percent"] is not None and i["delta_percent"] >= PRICE_RISE_PCT:',
     'if False:'),
]


def run() -> tuple[int, int, str]:
    p = subprocess.run([sys.executable, "-m", "pytest", "tests/test_advisor.py", "-q"],
                       cwd=SRC.parents[2], capture_output=True, text=True)
    m = re.search(r"(\d+) failed", p.stdout)
    passed = re.search(r"(\d+) passed", p.stdout)
    return (int(m.group(1)) if m else 0,
            int(passed.group(1)) if passed else 0,
            p.stdout.strip().splitlines()[-1] if p.stdout else "")


original = SRC.read_text(encoding="utf-8")
shutil.copy(SRC, BAK)
bad = []
try:
    for label, old, new in MUTATIONS:
        if old not in original:
            print(f"  SKIP  {label}  (anchor moved — update this script)")
            bad.append(label)
            continue
        SRC.write_text(original.replace(old, new), encoding="utf-8")
        failed, passed, tail = run()
        ok = failed > 0
        print(f"  {'caught' if ok else 'MISSED':>6}  {label}  ({failed} failed)")
        if not ok:
            bad.append(label)
finally:
    SRC.write_text(original, encoding="utf-8")
    BAK.unlink(missing_ok=True)

failed, passed, tail = run()
print(f"\nrestored: {tail}")
if failed:
    sys.exit("restore left tests failing!")
if bad:
    sys.exit(f"{len(bad)} mutation(s) went unnoticed: {bad}")
print("every mutation was caught.")
