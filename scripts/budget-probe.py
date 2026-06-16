#!/usr/bin/env python3
"""Wall-time budget probe for pre-bench-gate.sh.

Reads the most recent same-bench result file and surfaces:
- QA-phase total wall time
- Question count
- 2x soft-warning threshold

Output goes to stdout. Errors go to stderr (non-fatal).

Usage: python3 scripts/budget-probe.py <bench_name>
"""
import json
import os
import sys
from glob import glob

if len(sys.argv) < 2:
    print("usage: budget-probe.py <bench_name>", file=sys.stderr)
    sys.exit(0)

bench = sys.argv[1]
candidates = sorted(glob(f"benchmark-results/{bench}*.json"), key=os.path.getmtime, reverse=True)
if not candidates:
    print(f"No prior results for bench '{bench}', no budget reference available")
    sys.exit(0)

# Skip smoke runs (under 50Q) when picking budget reference, they are not
# representative of mini/full wall time.
recent = None
for c in candidates:
    try:
        peek = json.load(open(c))
        ps = peek.get("summary") or {}
        nq = ps.get("totalQuestions") or ps.get("scoredQuestions") or len(peek.get("results", []) or [])
        if nq >= 50:
            recent = c
            d = peek
            break
    except Exception:
        continue
if recent is None:
    print(f"No mini/full prior results for bench '{bench}' (only smokes available), no budget reference")
    sys.exit(0)

total_ms = 0
if isinstance(d.get("results"), list):
    total_ms = sum(r.get("total_time_ms", 0) for r in d["results"])
if total_ms == 0 and isinstance(d.get("summary"), dict):
    total_ms = d["summary"].get("totalElapsedMs", 0)

s = d.get("summary", {}) or {}
n_q = (
    s.get("totalQuestions")
    or s.get("scoredQuestions")
    or len(d.get("results", []) or [])
    or "?"
)
ts = (d.get("timestamp", "?") or "?")[:19]

if total_ms > 0:
    qa_min = round(total_ms / 60000, 1)
    cap_min = round(total_ms / 60000 * 2, 1)
    print(f"  prior run: {qa_min}min QA-phase ({n_q}Q) at {ts}")
    print(f"  -> if THIS run exceeds {cap_min}min wall, investigate (likely slow-path firing)")
else:
    print(f"  No timing data in most recent result {os.path.basename(recent)}")
