#!/usr/bin/env python3
"""
S69 C4 matrix aggregator.

Reads /root/demiurge/benchmark-results/locomo-official-mini-ad30d77-*.json,
groups by config × p25b, computes averages + variance, prints lock summary.

Run on CAX21. Exit 0 if >= EXPECTED_CELLS cells present, 1 otherwise.

Usage:
  python3 c4-aggregate-matrix.py [--commit COMMIT]
"""
import json
import glob
import os
import sys
import statistics
from collections import defaultdict

RESULTS_DIR = "/root/demiurge/benchmark-results"
DEFAULT_COMMITS = ["ad30d77", "9e08f7a"]  # S69 wave1 revised + S70 staging (engine identical)
EXPECTED_CELLS = 27

def config_label(env):
    """Map env vars to short config label."""
    flags = []
    if str(env.get("EPISODES_ENABLED", "")).lower() == "true":
        flags.append("EP")
    if str(env.get("ENTITY_BOOST_ENABLED", "")).lower() == "true":
        flags.append("EB")
    hf = env.get("HYBRID_FUSION_MODE", "")
    if hf and hf not in ("disabled", "", None):
        flags.append(f"H={hf}")
    if str(env.get("ENTITY_SPLIT_TEMPORAL", "")).lower() == "true":
        flags.append("EST")
    return "+".join(flags) or "none"


def main():
    commits = DEFAULT_COMMITS[:]
    if "--commit" in sys.argv:
        commits = [sys.argv[sys.argv.index("--commit") + 1]]
    if "--commits" in sys.argv:
        commits = sys.argv[sys.argv.index("--commits") + 1].split(",")

    files = []
    for c in commits:
        pat = os.path.join(RESULTS_DIR, f"locomo-official-mini-{c}-*.json")
        files.extend(sorted(glob.glob(pat)))
    if not files:
        print(f"ERROR: no result files for commits {commits}", file=sys.stderr)
        return 1
    commit = "+".join(commits)

    rows = []
    parse_errors = 0
    for f in files:
        try:
            d = json.load(open(f))
        except Exception as e:
            print(f"WARN: failed to parse {f}: {e}", file=sys.stderr)
            parse_errors += 1
            continue
        m = d.get("manifest", {})
        env = m.get("env_config_inputs", {}) if isinstance(m.get("env_config_inputs"), dict) else {}
        acc = d.get("summary", {}).get("jScore")
        if acc is None:
            continue
        p25 = str(env.get("RETRIEVAL_FRESHEST_BY_SUBJECT", "?"))
        cfg = config_label(env)
        ts = os.path.basename(f)
        for c in commits:
            ts = ts.replace(f"locomo-official-mini-{c}-", "")
        ts = ts.rstrip(".json")
        rows.append((cfg, p25, acc, ts, f))

    if not rows:
        print(f"ERROR: parsed {len(files)} files but found zero valid results", file=sys.stderr)
        return 1

    g = defaultdict(list)
    for cfg, p25, acc, ts, f in rows:
        g[(cfg, p25)].append((acc, ts))

    print("=" * 100)
    print(f"S69 C4 MATRIX AGGREGATION - commit {commit}")
    print(f"Cells parsed: {len(rows)} / expected {EXPECTED_CELLS}")
    if parse_errors:
        print(f"Parse errors: {parse_errors}")
    print("=" * 100)
    print(f"\n{'CONFIG':30s} {'p25b':6s} {'N':>3s} {'AVG':>8s} {'STDEV':>7s}  scores")
    print("-" * 100)

    summary = {}
    for (cfg, p25), entries in sorted(g.items()):
        accs = [e[0] for e in entries]
        avg = sum(accs) / len(accs)
        sd = statistics.stdev(accs) if len(accs) > 1 else 0.0
        s = "  ".join(f"{a*100:.2f}" for a in accs)
        print(f"{cfg:30s} {p25:6s} {len(accs):>3d} {avg*100:>7.2f}% {sd*100:>6.2f}%  {s}")
        summary[f"{cfg}|p25b={p25}"] = {
            "n": len(accs),
            "avg_jScore": round(avg, 4),
            "stdev": round(sd, 4),
            "raw_scores": [round(a, 4) for a in accs],
        }

    print()
    print("=" * 100)
    print("HEAD-TO-HEAD: p25b OFF vs ON (per config)")
    print("=" * 100)
    configs_with_both = sorted({cfg for (cfg, p25) in g.keys()})
    for cfg in configs_with_both:
        off = g.get((cfg, "off"))
        on = g.get((cfg, "on"))
        if off and on:
            off_avg = sum(a for a, _ in off) / len(off)
            on_avg = sum(a for a, _ in on) / len(on)
            delta = (on_avg - off_avg) * 100
            print(f"  {cfg:30s}  OFF {off_avg*100:>6.2f}%  ON {on_avg*100:>6.2f}%  Delta {delta:+.2f}pp")

    print()
    print("=" * 100)
    print("LOCK DECISION HEURISTIC (Occam-simplest within variance band)")
    print("=" * 100)
    all_avgs = sorted(
        ((k, v["avg_jScore"], v["n"]) for k, v in summary.items() if v["n"] >= 2),
        key=lambda x: -x[1],
    )
    if all_avgs:
        top_avg = all_avgs[0][1]
        BAND = 0.015
        winners = [(k, a, n) for k, a, n in all_avgs if (top_avg - a) <= BAND]
        print(f"\nTop avg: {top_avg*100:.2f}%. Within-band candidates (delta <= 1.5pp):")
        for k, a, n in winners:
            print(f"  {a*100:>6.2f}%  n={n}  {k}")
        def complexity(label):
            cfg_part = label.split("|")[0]
            return 0 if cfg_part == "none" else cfg_part.count("+") + 1
        winners_by_complexity = sorted(winners, key=lambda x: (complexity(x[0]), -x[1]))
        chosen = winners_by_complexity[0]
        print(f"\nSIMPLEST WINNER (Occam): {chosen[0]} @ {chosen[1]*100:.2f}% n={chosen[2]}")

    print()
    print("=" * 100)
    out_path = f"/tmp/s69-matrix-summary-{commit.replace(chr(43), chr(95))}.json"
    with open(out_path, "w") as f:
        json.dump({"commit": commit, "expected": EXPECTED_CELLS, "actual": len(rows),
                   "groups": summary}, f, indent=2)
    print(f"JSON written: {out_path}")

    return 0 if len(rows) >= EXPECTED_CELLS else 2


if __name__ == "__main__":
    sys.exit(main())
