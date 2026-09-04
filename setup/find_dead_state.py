"""Find dead affordances: state a button sets that nothing ever renders.

That is the exact shape of the "+ New category" bug - setNewCatOpen(true) was
wired to a button, but no JSX ever read newCatOpen, so clicking did nothing.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "web" / "src"

state_re = re.compile(r"const\s*\[\s*(\w+)\s*,\s*(set\w+)\s*\]\s*=\s*useState")
# a declared handler that nothing calls
fn_re = re.compile(r"^\s*(?:const|function)\s+(\w+)\s*=?\s*(?:async\s*)?\(")

problems = []
for path in sorted(ROOT.rglob("*.tsx")) + sorted(ROOT.rglob("*.ts")):
    if ".test." in path.name:
        continue
    text = path.read_text(encoding="utf-8")
    # strip the declaration lines so a name isn't counted by its own declaration
    for getter, setter in state_re.findall(text):
        decl = re.search(
            r"const\s*\[\s*%s\s*,\s*%s\s*\]\s*=\s*useState[^\n]*\n" % (getter, setter),
            text)
        body = text.replace(decl.group(0), "") if decl else text
        reads = len(re.findall(r"\b%s\b" % re.escape(getter), body))
        writes = len(re.findall(r"\b%s\b" % re.escape(setter), body))
        if writes and not reads:
            problems.append((path, f"state '{getter}' is set {writes}x but never read"))
        elif reads and not writes:
            problems.append((path, f"state '{getter}' is read but never set"))

for path, msg in problems:
    print(f"{path.relative_to(ROOT)}: {msg}")
print(f"\n{len(problems)} suspicious state pair(s)")
sys.exit(0)
