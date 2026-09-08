"""Break the UX fixes on purpose and check their tests notice.

Three rules are under test here, each of which came from a real complaint:

  * the four daily jobs live in one nav group, and group ownership is decided
    by the longest matching route rather than a bare prefix;
  * "add line" follows the rows, fills the cursor into the new row, and Enter
    starts the next one;
  * a money field selects itself on focus, and a text field does not.

    python setup\\mutate_ux.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

NAV = "web/src/components/Layout.tsx"
EXP = "web/src/pages/ExpensesList.tsx"
UI = "web/src/components/ui.tsx"
HOME = "web/src/pages/Home.tsx"

HOME_MUTATIONS = [
    (HOME, "nag about expenses, so a no-spend day never looks finished",
     "const s = steps(mine).find((x) => !x.done && !x.optional);",
     "const s = steps(mine).find((x) => !x.done);"),

    (HOME, "keep pointing at the last step after the drawer is counted",
     "return s ? s.n : null;",
     "return s ? s.n : 4;"),

    (HOME, "highlight the last unfinished job instead of the next one",
     "const s = steps(mine).find((x) => !x.done && !x.optional);",
     "const s = [...steps(mine)].reverse().find((x) => !x.done && !x.optional);"),

    (HOME, "drop closing the day off the round entirely",
     '      n: 4, done: !!mine.closed, title: "Close the day",',
     '      n: 4, done: true, title: "Close the day",'),
]

NAV_MUTATIONS = [
    (NAV, "match on a bare prefix, so /salesman counts as /sales",
     'pathname === c.to || pathname.startsWith(c.to + "/")',
     'pathname === c.to || pathname.startsWith(c.to)'),

    (NAV, "let the shortest route win, so /sales/bills opens Every day",
     ".sort((a, b) => b.c.to.length - a.c.to.length)[0];",
     ".sort((a, b) => a.c.to.length - b.c.to.length)[0];"),

    (NAV, "stop sorting at all, so declaration order decides ownership",
     ".sort((a, b) => b.c.to.length - a.c.to.length)[0];",
     "[0];"),

    (NAV, "scatter the daily round again by filing sales elsewhere",
     '      { to: "/sales", label: "Enter sales" },\n',
     ""),

    (NAV, "put the cash count back under Suppliers & bank",
     '      { to: "/money/cash", label: "Cash & close day" },\n',
     ""),

    (NAV, "name the tab after the filing cabinet again",
     '{ to: "/staff/attendance", label: "Attendance", icon: CalendarCheck },',
     '{ to: "/staff/attendance", label: "Staff", icon: CalendarCheck },'),

    (NAV, "strand the cash count by skipping a whole group on the phone menu",
     "  return groups\n"
     "    .map((g) => ({ ...g, children: g.children.filter((c) => !tabbed.has(c.to)) }))\n"
     "    .filter((g) => g.children.length > 0);",
     '  return groups.filter((g) => g.key !== "today");'),

    (NAV, "repeat the bottom tabs inside the Everything else menu",
     "g.children.filter((c) => !tabbed.has(c.to))",
     "g.children.filter(() => true)"),

    (NAV, "keep an empty group heading in the phone menu",
     "    .filter((g) => g.children.length > 0);",
     "    .filter((g) => g.children.length >= 0);"),

    (NAV, "go back to naming the group after a list of its own members",
     'key: "spending", label: "Spending", icon: CircleDollarSign,',
     'key: "spending", label: "Suppliers & bank", icon: CircleDollarSign,'),

    (NAV, "stop leading with the daily round",
     '    key: "today", label: "Every day", icon: ClipboardList,',
     '    key: "daily", label: "Every day", icon: ClipboardList,'),
]

EXP_MUTATIONS = [
    (EXP, "add the row but leave the cursor where it was",
     "    setLines((x) => [...x, row]);\n    setFocusLine(row.id);",
     "    setLines((x) => [...x, row]);"),

    (EXP, "make Enter do nothing, so every row needs the mouse",
     'if (e.key === "Enter") { e.preventDefault(); addLine(); }',
     'if (e.key === "Escape") { e.preventDefault(); addLine(); }'),

    (EXP, "delete the last row rather than the one asked for",
     "setLines((x) => x.filter((_, j) => j !== i))",
     "setLines((x) => x.slice(0, -1))"),

    (EXP, "add new rows at the top, far from the button that made them",
     "setLines((x) => [...x, row]);",
     "setLines((x) => [row, ...x]);"),

    (EXP, "miscount the lines, so a long bill can't be checked off",
     "{lines.length} {lines.length === 1 ? \"line\" : \"lines\"}",
     "{lines.length - 1} {lines.length === 1 ? \"line\" : \"lines\"}"),
]

UI_MUTATIONS = [
    (UI, "never select, so correcting a figure means backspacing it first",
     "        if (numeric) e.currentTarget.select();\n",
     ""),

    (UI, "select every field, fighting anyone editing one word of a note",
     "if (numeric) e.currentTarget.select();",
     "e.currentTarget.select();"),

    (UI, "only treat inputMode=numeric as a number field",
     'const numeric = p.inputMode === "decimal" || p.inputMode === "numeric"\n    || p.type === "number";',
     'const numeric = p.inputMode === "numeric";'),

    (UI, "swallow the caller's own onFocus handler",
     "        onFocus?.(e);\n",
     ""),
]


if __name__ == "__main__":
    raise SystemExit(check(
        ["src/components/Layout.test.tsx", "src/pages/ExpensesList.test.tsx",
         "src/components/ui.test.tsx", "src/pages/Home.test.tsx"],
        NAV_MUTATIONS + EXP_MUTATIONS + UI_MUTATIONS + HOME_MUTATIONS, kind="web"))
