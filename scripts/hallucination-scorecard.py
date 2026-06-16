#!/usr/bin/env python3
"""
Hallucination scorecard (S78).

Buckets every benchmark question into ABSTAINED / CORRECT / WRONG and reports
the two product targets:
  abstention_rate  (target <= 20%): fraction the engine declines
  wrong_rate       (target <  1%):  fraction answered-and-wrong = hallucination

Works on a SHADOW run: the abstention gate logs `wouldAbstain` per question
without changing output, so the scorecard simulates the live gate. It also
splits abstentions into GOOD-CATCH (would-decline a WRONG answer = win) vs
OVER-REFUSE (would-decline a CORRECT answer = cost), the precision read used to
tune the judge before flipping it live.

Inputs:
  --results path to a bench result JSON (default: latest beam-*mini*.json)
  --gate-log path to the run log holding abstention_gate lines
  --correct-threshold nugget_score >= this counts as correct (default 0.5)
  --json emit machine-readable JSON alongside the table (for a committed baseline)

Usage:
  python3 hallucination-scorecard.py --results <json> --gate-log <log>
"""
import json
import glob
import os
import sys
import argparse
from collections import defaultdict

RESULTS_DIR = "/root/demiurge/benchmark-results"


def load_gate_verdicts(log_path):
    """Map question-prefix -> gate verdict dict (q is the 80-char prefix logged)."""
    verdicts = {}
    if not log_path or not os.path.exists(log_path):
        return verdicts
    with open(log_path, errors="ignore") as f:
        for line in f:
            i = line.find('{"tag":"abstention_gate"')
            if i < 0:
                continue
            try:
                d = json.loads(line[i:])
                verdicts[d["q"]] = d
            except Exception:
                pass
    return verdicts


def match_verdict(question, verdicts):
    key = question[:80]
    if key in verdicts:
        return verdicts[key]
    for k, v in verdicts.items():
        if question.startswith(k) or k.startswith(question[:60]):
            return v
    return None


def pct(a, b):
    return f"{100 * a / b:.1f}%" if b else "n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=None)
    ap.add_argument("--gate-log", default=None)
    ap.add_argument("--correct-threshold", type=float, default=0.5)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    results_path = args.results
    if not results_path:
        cand = sorted(glob.glob(os.path.join(RESULTS_DIR, "beam-*mini*.json")), key=os.path.getmtime)
        results_path = cand[-1] if cand else None
    if not results_path or not os.path.exists(results_path):
        print("no results JSON found")
        sys.exit(1)

    data = json.load(open(results_path))
    rows = data.get("results", [])
    verdicts = load_gate_verdicts(args.gate_log)
    thr = args.correct_threshold

    blank = lambda: {"n": 0, "abstain": 0, "correct": 0, "wrong": 0, "good_catch": 0, "over_refuse": 0}
    cats = defaultdict(blank)
    ov = blank()
    ov["no_verdict"] = 0

    for r in rows:
        q = r.get("question", "")
        score = r.get("nugget_score", r.get("score", 0)) or 0
        scored_correct = score >= thr
        v = match_verdict(q, verdicts)
        ability = r.get("ability", r.get("query_type", "?"))
        c = cats[ability]
        c["n"] += 1
        ov["n"] += 1
        would_abstain = bool(v.get("wouldAbstain")) if v else False
        if v is None:
            ov["no_verdict"] += 1
        if would_abstain:
            c["abstain"] += 1
            ov["abstain"] += 1
            k = "over_refuse" if scored_correct else "good_catch"
            c[k] += 1
            ov[k] += 1
        else:
            k = "correct" if scored_correct else "wrong"
            c[k] += 1
            ov[k] += 1

    n = ov["n"]
    print("# Hallucination Scorecard")
    print(f"results: {os.path.basename(results_path)}  |  gate verdicts: {len(verdicts)}  |  questions: {n}")
    print("(SHADOW simulation: ABSTAINED = gate would-decline; these are the live numbers if the gate were on)")
    print()
    print(f"  abstention_rate : {pct(ov['abstain'], n)}    target <= 20%")
    print(f"  wrong_rate      : {pct(ov['wrong'], n)}    target <  1%   [answered AND wrong = hallucination]")
    print(f"  accuracy        : {pct(ov['correct'], n)}    [answered AND correct]")
    print(f"  good_catch      : {pct(ov['good_catch'], n)}    [would-decline a WRONG answer = win]")
    print(f"  over_refuse     : {pct(ov['over_refuse'], n)}    [would-decline a CORRECT answer = cost]")
    if ov["no_verdict"]:
        print(f"  (no gate verdict matched for {ov['no_verdict']} of {n} questions)")
    print()
    hdr = f"{'category':<24}{'n':>4}{'abstain':>10}{'correct':>10}{'wrong':>8}{'over-ref':>10}{'good-catch':>12}"
    print(hdr)
    print("-" * len(hdr))
    for ab in sorted(cats):
        c = cats[ab]
        print(
            f"{ab:<24}{c['n']:>4}{pct(c['abstain'], c['n']):>10}{pct(c['correct'], c['n']):>10}"
            f"{pct(c['wrong'], c['n']):>8}{pct(c['over_refuse'], c['n']):>10}{pct(c['good_catch'], c['n']):>12}"
        )

    if args.json:
        out = {"results_file": os.path.basename(results_path), "questions": n, "overall": ov,
               "by_category": {k: dict(v) for k, v in cats.items()}, "correct_threshold": thr}
        print()
        print("JSON_BASELINE:" + json.dumps(out))


if __name__ == "__main__":
    main()
