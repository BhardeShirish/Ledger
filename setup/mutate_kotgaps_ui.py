"""Break the kitchen-ticket screen on purpose and check the tests notice.

The arithmetic is proven server-side; this proves the screen doesn't
quietly misrepresent it — by leading with the flattering figure, hiding
the numbers an owner would look up, or claiming a clean sheet when the
import simply carried nothing.

    python setup\\mutate_kotgaps_ui.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

MUTATIONS = [
    ("lead with the flattering figure instead of the cautious one",
     'value={t.missing_at_least.toLocaleString("en-IN")}\n'
     '                    note="at least"',
     'value={t.missing_at_most.toLocaleString("en-IN")}\n'
     '                    note="at least"'),

    ("drop the upper end, hiding how wide the doubt is",
     '<Figure label="Could be as high as" value={t.missing_at_most.toLocaleString("en-IN")}\n'
     '                    note="if no bill lost its number" />',
     ""),

    ("stop printing the ticket numbers, leaving nothing to look up",
     "{w.missing_numbers.join(\", \")}",
     '{""}'),

    ("show the numbers without saying which day they belong to",
     '<span className="font-medium">{w.date}</span>',
     '<span className="font-medium" />'),

    ("hide the findings, so the plain-words verdict never appears",
     "<FindingList findings={findings} />",
     ""),

    ("drop the explanation, so the figure can't be argued with",
     '<p className="text-xs leading-relaxed text-ink-faint">{d.how}</p>',
     ""),

    ("treat an import with no ticket numbers as a clean sheet",
     "t.days_measurable === 0 ?",
     "false ?"),

    ("list days to look into even when nothing is missing",
     "{worst.length > 0 && worst[0].missing_at_least > 0 && (",
     "{worst.length > 0 && ("),

    ("show every day at once, burying the worst ones",
     "worst.slice(0, open ? worst.length : 5)",
     "worst.slice(0, worst.length)"),

    ("never expand, so the rest of the days stay unreachable",
     "{worst.length > 5 && (",
     "{false && ("),

    ("leave the expander stuck open once clicked",
     "onClick={() => setOpen(!open)}",
     "onClick={() => setOpen(true)}"),

    ("offer an expander even when every day already fits",
     "{worst.length > 5 && (",
     "{worst.length > 0 && ("),

    ("show the rupee figure without saying what it is based on",
     'note="at your own average bill"',
     'note=""'),

    ("ask the server for the wrong period",
     "`/patterns/kot-gaps?start=${start}&end=${end}` +",
     "`/patterns/kot-gaps?start=${end}&end=${end}` +"),

    ("ignore the chosen outlet and answer for the whole business",
     '(outletId ? `&outlet_id=${outletId}` : "")',
     '""'),

    ("stay silent when the books can't be read",
     '{q.isError && <ErrorNote msg="Couldn\'t read your kitchen tickets." />}',
     ""),
]


if __name__ == "__main__":
    SRC = "web/src/components/KotGaps.tsx"
    raise SystemExit(check(["src/components/KotGaps.test.tsx"],
                           [(SRC, *m) for m in MUTATIONS], kind="web"))
