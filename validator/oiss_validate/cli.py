"""Command line: oiss-validate FILE_OR_DIR ...

Each file holds one record, or a JSON array of records. Use - to read from
stdin, or a .jsonl file for one record per line. Exits 1 if anything fails.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterator

from .core import DEFAULT_SCHEMA_DIR, Validator


def _records(path: str) -> Iterator[tuple[str, Any]]:
    if path == "-":
        text, label, jsonl = sys.stdin.read(), "<stdin>", False
    else:
        p = Path(path)
        if p.is_dir():
            for child in sorted(p.rglob("*.json*")):
                yield from _records(str(child))
            return
        text, label, jsonl = p.read_text(), path, p.suffix == ".jsonl"
    if jsonl:
        for n, line in enumerate(text.splitlines(), 1):
            if line.strip():
                yield f"{label}:{n}", json.loads(line)
        return
    doc = json.loads(text)
    if isinstance(doc, list):
        for i, record in enumerate(doc):
            yield f"{label}[{i}]", record
    else:
        yield label, doc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="oiss-validate", description="Validate OISS records.")
    parser.add_argument("paths", nargs="+", help="files or directories of records, or - for stdin")
    parser.add_argument("--schemas", default=str(DEFAULT_SCHEMA_DIR), help="schema directory (default: %(default)s)")
    parser.add_argument("-q", "--quiet", action="store_true", help="print only failures")
    args = parser.parse_args(argv)

    validator = Validator(args.schemas)
    failed = checked = 0
    for path in args.paths:
        for label, record in _records(path):
            checked += 1
            problems = validator.problems(record)
            if problems:
                failed += 1
                print(f"FAIL {label}")
                for problem in problems:
                    print(f"  {problem}")
            elif not args.quiet:
                print(f"ok   {label}")
    print(f"{checked - failed} of {checked} records valid")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
