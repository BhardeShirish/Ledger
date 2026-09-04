"""Run mutation checks in parallel instead of one at a time.

A mutation check is embarrassingly parallel — each mutation is independent
— but the obvious implementation isn't, because every mutation edits the
same file in the same tree. So each worker gets its own copy of the tree
and edits that.

Serially, the five mutation scripts took about twenty minutes between
them. Split across the cores of a normal machine they take about two.

Every script here shares the same shape: a source file, the tests that
should notice, and a list of (description, before, after). Each mutation
is anchored on an exact string that must appear exactly once, so a script
fails loudly rather than quietly mutating nothing.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Never copied into a worker: the real books, caches, and the scratch data
#: directories the suite writes. Copying data/ would be 27 MB per worker for
#: files no test may touch.
SKIP = shutil.ignore_patterns(
    "data", "__pycache__", ".pytest_cache", ".tmpdata*", "node_modules",
    "dist", ".vitest", "*.pyc")


def _workers() -> int:
    return max(1, min(8, (os.cpu_count() or 4)))


class Tree:
    """A throwaway copy of the part of the repo a check needs."""

    def __init__(self, kind: str):
        self.kind = kind
        # realpath, because Windows hands back an 8.3 short path here
        # ("BHARDE~1") and vite resolves imports to the long form, then
        # decides the file it just found doesn't exist.
        self.dir = Path(os.path.realpath(tempfile.mkdtemp(prefix="mutant-")))
        if kind == "backend":
            self.root = self.dir / "server"
            shutil.copytree(ROOT / "server", self.root, ignore=SKIP)
        else:
            self.root = self.dir / "web"
            self.root.mkdir()
            for name in ("src", "package.json", "vite.config.ts",
                         "tsconfig.json", "tsconfig.node.json", "index.html",
                         "postcss.config.js", "tailwind.config.js"):
                src = ROOT / "web" / name
                if not src.exists():
                    continue
                if src.is_dir():
                    shutil.copytree(src, self.root / name, ignore=SKIP)
                else:
                    shutil.copy(src, self.root / name)
            # node_modules is far too big to copy; a junction costs nothing
            # and the tests only ever read from it.
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(self.root / "node_modules"),
                 str(ROOT / "web" / "node_modules")],
                capture_output=True, check=False)

    def path_to(self, rel: str) -> Path:
        return self.root / Path(rel).relative_to(Path(rel).parts[0])

    def run(self, tests: list[str]) -> bool:
        if self.kind == "backend":
            cmd = [sys.executable, "-m", "pytest", *tests, "-x", "-n", "0",
                   "-q", "-p", "no:cacheprovider"]
        else:
            cmd = ["npx", "vitest", "run", *tests]
        r = subprocess.run(cmd, cwd=self.root, shell=(self.kind != "backend"),
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        return r.returncode == 0

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def check(tests: list[str], mutations: list[tuple[str, str, str, str]],
          kind: str = "backend") -> int:
    """Apply each mutation in its own copy of the tree and report survivors.

    Each mutation is (path, description, before, after), where path is
    relative to the repo root, e.g. "server/app/routers/pnl.py".
    """
    originals = {m[0]: (ROOT / m[0]).read_text(encoding="utf-8")
                 for m in mutations}

    # An anchor that doesn't appear exactly once would mutate the wrong
    # line, or nothing at all, and the run would look like a clean pass.
    for src, name, old, _new in mutations:
        hits = originals[src].count(old)
        if hits != 1:
            print(f"anchor for '{name}' appears {hits} times, expected once")
            return 1

    n = min(_workers(), len(mutations))
    print(f"{len(mutations)} mutations across {n} workers")

    trees = [Tree(kind) for _ in range(n)]
    try:
        if not trees[0].run(tests):
            print("baseline is already red — fix that first")
            return 1
        print("baseline green\n")

        # Each thread owns one tree for the whole run, so two threads can
        # never edit the same file.
        blocks: list[list] = [[] for _ in range(n)]
        for i, m in enumerate(mutations):
            blocks[i % n].append(m)

        def worker(slot_and_block):
            slot, block = slot_and_block
            tree = trees[slot]
            out = []
            for src, name, old, new in block:
                path = tree.path_to(src)
                path.write_text(originals[src].replace(old, new, 1),
                                encoding="utf-8")
                try:
                    out.append((name, tree.run(tests)))
                finally:
                    path.write_text(originals[src], encoding="utf-8")
            return out

        results: list[tuple[str, bool]] = []
        with ThreadPoolExecutor(max_workers=n) as ex:
            for part in ex.map(worker, enumerate(blocks)):
                results.extend(part)

        order = {name: i for i, (_s, name, _o, _n) in enumerate(mutations)}
        results.sort(key=lambda r: order[r[0]])

        missed = [name for name, survived in results if survived]
        for name, survived in results:
            print(("MISSED  " if survived else "caught  ") + name)
    finally:
        for t in trees:
            t.close()

    print()
    if missed:
        print(f"{len(missed)} mutation(s) survived — those rules are untested:")
        for m in missed:
            print(f"  - {m}")
        return 1
    print(f"all {len(mutations)} mutations caught")
    return 0
