#!/usr/bin/env python3
"""
check-duplicate-config.py  --  bench dedup failsafe (S78)

Before running a bench, surface prior runs of the SAME config so a measured
config is never re-run. Matches on the SEMANTIC config (reranker / gating /
routing / answer model / scope), not just a hash, so it works even if the
hash recipe changes.

Usage (run with the SAME env the bench will use):
    RERANKER_ENABLED=true RERANK_QUERY_TYPE_GATING=false ANSWER_ROUTING=false \
    BENCH_SCOPE=mini python3 scripts/check-duplicate-config.py beam-100k-mini

Exit 0 = no duplicate, safe to run.
Exit 3 = duplicate config already measured (loud warning, do not re-run).
"""
import json, glob, os, sys


def nb(v):
    return "true" if str(v).strip().lower() == "true" else "false"


def intended():
    return {
        "RERANKER_ENABLED": nb(os.environ.get("RERANKER_ENABLED", "false")),
        "RERANK_QUERY_TYPE_GATING": nb(os.environ.get("RERANK_QUERY_TYPE_GATING", "false")),
        "ANSWER_ROUTING": nb(os.environ.get("ANSWER_ROUTING", "false")),
        "answer_model": os.environ.get("ANSWER_MODEL", os.environ.get("MODEL", "gpt-4.1-mini")),
        "scope": os.environ.get("BENCH_SCOPE", "mini"),
    }


def run_cfg(man):
    ec = man.get("env_config_inputs", {}) or {}
    mp = man.get("model_pins", {}) or {}
    return {
        "RERANKER_ENABLED": nb(ec.get("RERANKER_ENABLED", "false")),
        "RERANK_QUERY_TYPE_GATING": nb(ec.get("RERANK_QUERY_TYPE_GATING", "false")),
        "ANSWER_ROUTING": nb(ec.get("ANSWER_ROUTING", "false")),
        "answer_model": mp.get("answer", "?"),
        "scope": man.get("scope_label", "?"),
        "hash": (man.get("env_config_hash", "?") or "?")[:12],
        "commit": (man.get("commit_sha", "?") or "?")[:7],
        "has_gating_field": "RERANK_QUERY_TYPE_GATING" in ec,
    }


def score_of(j):
    s = j.get("overallScore")
    if s is None:
        s = (j.get("summary", {}) or {}).get("overallScore")
    return s


KEYS = ("RERANKER_ENABLED", "RERANK_QUERY_TYPE_GATING", "ANSWER_ROUTING", "answer_model", "scope")


def main():
    bench = sys.argv[1] if len(sys.argv) > 1 else ""
    if not bench:
        print("usage: check-duplicate-config.py BENCH (run with the bench's env)")
        sys.exit(2)
    rd = "benchmark-results"
    files = sorted(glob.glob(f"{rd}/{bench}*.json"), key=os.path.getmtime, reverse=True)
    want = intended()
    print(f"=== DUPLICATE-CONFIG CHECK: bench={bench} ===")
    print(f"intended: RERANKER={want['RERANKER_ENABLED']} GATING={want['RERANK_QUERY_TYPE_GATING']} "
          f"ROUTING={want['ANSWER_ROUTING']} model={want['answer_model']} scope={want['scope']}")
    if not files:
        print("no prior runs of this bench. Safe to run.")
        sys.exit(0)
    dups, shown, gating_gap = [], 0, False
    print("--- recent runs (R=reranker G=gating A=routing) ---")
    for f in files[:14]:
        try:
            j = json.load(open(f))
        except Exception:
            continue
        man = j.get("manifest", {}) or {}
        rc = run_cfg(man)
        if not rc["has_gating_field"]:
            gating_gap = True
        sc = score_of(j)
        scs = f"{sc * 100:.1f}%" if isinstance(sc, (int, float)) else str(sc)
        match = all(rc[k] == want[k] for k in KEYS)
        if shown < 12:
            print(f"  {os.path.basename(f)[:54]:54} R={rc['RERANKER_ENABLED'][0]} "
                  f"G={rc['RERANK_QUERY_TYPE_GATING'][0]} A={rc['ANSWER_ROUTING'][0]} "
                  f"{rc['answer_model']:12} {rc['scope']:5} -> {scs:>7}" + ("   <<< SAME CONFIG" if match else ""))
            shown += 1
        if match:
            dups.append((scs, os.path.basename(f), rc["commit"]))
    print("=" * 64)
    if gating_gap:
        print("NOTE: some manifests do not record RERANK_QUERY_TYPE_GATING; gated vs")
        print("      ungated may be indistinguishable on those. Add it to env_config_inputs.")
    if dups:
        print(f"!!! DUPLICATE CONFIG: you ALREADY have {len(dups)} run(s) of this EXACT config:")
        for s, fn, c in dups[:6]:
            print(f"    {s:>7}  {fn}  (commit {c})")
        print("    Re-running wastes time and money. Use the existing data.")
        print("    ONLY re-run if the Q set changed (mini expansion) -> then re-establish sigma.")
        sys.exit(3)
    print("OK: no prior run of this EXACT config found. Safe to run.")
    sys.exit(0)


main()
