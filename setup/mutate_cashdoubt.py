"""Break the surplus-explanation rule on purpose and check its tests notice.

The rule's whole value is its asymmetry: a surplus inside the band is
arithmetic, a shortage never is. Every mutation below relaxes it in a way
that would either wave away a real shortage or keep crying wolf.

    python setup\\mutate_cashdoubt.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

SRC = "web/src/lib/cashdoubt.ts"

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


if __name__ == "__main__":
    raise SystemExit(check(['src/lib/cashdoubt.test.ts'], [(SRC, *m) for m in MUTATIONS], kind="web"))
