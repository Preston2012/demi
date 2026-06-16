#!/usr/bin/env python3
"""
Bench result-schema inventory (S78). Maps every bench's latest result JSON to
its per-question schema so the scorecard normalizer is built on real fields,
not guesses. Surfaces the distinct category / sub-type values each bench tags
(the native labels the scorecard will enrich beyond).
"""
import json
import glob
import os

RD = "/root/demiurge/benchmark-results"
CATFIELDS = ["category", "ability", "query_type", "question_type", "qtype", "type",
             "hop", "hops", "difficulty", "subcategory", "sub_category", "task", "adversarial"]
SCOREFIELDS = ["nugget_score", "score", "correct", "is_correct", "passed",
               "autoeval_label", "label", "judge_score", "f1", "em"]

benches = {}
for f in glob.glob(RD + "/*.json"):
    pre = os.path.basename(f).split("-")[0]
    if pre not in benches or os.path.getmtime(f) > os.path.getmtime(benches[pre]):
        benches[pre] = f

print(f"benches with result JSONs: {sorted(benches)}\n")
for pre, f in sorted(benches.items()):
    try:
        d = json.load(open(f))
        r = d.get("results") or d.get("perQuestion") or d.get("questions") or []
        rec = r[0] if (isinstance(r, list) and r) else {}
        catf = [k for k in CATFIELDS if k in rec]
        scf = [k for k in SCOREFIELDS if k in rec]
        print(f"=== {pre}  n={len(r) if isinstance(r,list) else 0}  ({os.path.basename(f)})")
        print(f"    top-keys:     {list(d.keys())[:12]}")
        print(f"    cat-fields:   {catf}")
        print(f"    score-fields: {scf}")
        for cf in catf[:3]:
            if isinstance(r, list):
                vals = sorted(set(str(x.get(cf)) for x in r))
                print(f"    {cf} ({len(vals)} distinct): {vals[:18]}")
        print(f"    rec-keys: {list(rec.keys())}")
        print()
    except Exception as e:
        print(f"=== {pre}: ERR {e}\n")
