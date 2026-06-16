#!/usr/bin/env python3
"""S51 Wikidata stale-memory fixture builder.

Pulls real-world entity-attribute transitions from Wikidata via SPARQL and
emits a ProductFixture JSON ready for src/benchmark/product/stale-memory/.

Predicates queried by default (one transition family each):
  P39  position held              → "What position does X currently hold?"
  P36  capital                    → "What is the capital of X?"
  P26  spouse                     → "Who is X's spouse?"
  P488 chairperson                → "Who is the chairperson of X?"
  P54  member of sports team      → "What sports team does X play for?"

Output JSON shape: matches src/benchmark/product/types.ts:ProductFixture so
the runner doesn't need a custom adapter.

Usage:
  python3 scripts/fetch-wikidata-stale-fixture.py --mode mini \\
      --out fixtures/benchmark/product/stale-memory/mini.json
  python3 scripts/fetch-wikidata-stale-fixture.py --mode full \\
      --out fixtures/benchmark/product/stale-memory/full.json

Caches raw SPARQL responses to /tmp/wikidata-cache/ so re-runs are offline
unless --refresh is passed. Cache directory is .gitignored.
"""
import argparse
import json
import os
import random
import sys
import urllib.parse
import urllib.request
from pathlib import Path

WDQS_ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = "demiurge-bench/1.0 (https://github.com/preston2012/demiurge; bench-suite)"
CACHE_DIR = Path("/tmp/wikidata-cache")

PREDICATES = [
    {
        "id": "P39",
        "label": "position held",
        "claim_template": "{entity} held the position of {value}",
        "current_claim_template": "{entity} currently holds the position of {value}",
        "question_template": "What position does {entity} currently hold?",
    },
    {
        "id": "P36",
        "label": "capital",
        "claim_template": "The capital of {entity} is {value}",
        "current_claim_template": "The current capital of {entity} is {value}",
        "question_template": "What is the capital of {entity}?",
    },
    {
        "id": "P26",
        "label": "spouse",
        "claim_template": "{entity}'s spouse is {value}",
        "current_claim_template": "{entity}'s current spouse is {value}",
        "question_template": "Who is {entity}'s current spouse?",
    },
    {
        "id": "P488",
        "label": "chairperson",
        "claim_template": "{value} is the chairperson of {entity}",
        "current_claim_template": "{value} is the current chairperson of {entity}",
        "question_template": "Who is the chairperson of {entity}?",
    },
    {
        "id": "P54",
        "label": "member of sports team",
        "claim_template": "{entity} plays for {value}",
        "current_claim_template": "{entity} currently plays for {value}",
        "question_template": "What sports team does {entity} play for?",
    },
]


def sparql_template(predicate_id: str, limit: int) -> str:
    """SPARQL: entities with a past statement (P582 end time) AND a current one."""
    return f"""SELECT DISTINCT ?entity ?entityLabel ?old ?oldLabel ?new ?newLabel ?endDate WHERE {{
  ?entity p:{predicate_id} ?stmt1 .
  ?stmt1 ps:{predicate_id} ?old ;
         pq:P582 ?endDate .
  ?entity p:{predicate_id} ?stmt2 .
  ?stmt2 ps:{predicate_id} ?new .
  FILTER NOT EXISTS {{ ?stmt2 pq:P582 ?_anything }}
  FILTER (?old != ?new)
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
ORDER BY DESC(?endDate)
LIMIT {limit}
"""


def fetch_sparql(query: str, refresh: bool = False, cache_key: str = "") -> dict:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{cache_key}.json"
    if cache_path.exists() and not refresh:
        with open(cache_path) as f:
            return json.load(f)

    body = urllib.parse.urlencode({"query": query, "format": "json"}).encode("utf-8")
    req = urllib.request.Request(
        WDQS_ENDPOINT,
        data=body,
        method="POST",
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/sparql-results+json",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read().decode("utf-8"))
    with open(cache_path, "w") as f:
        json.dump(data, f)
    return data


def well_formed_label(s: str) -> bool:
    if not s or not isinstance(s, str):
        return False
    if s.startswith("Q") and s[1:].isdigit():
        return False  # Wikidata Qid label fallback (no English label found)
    if len(s) < 2 or len(s) > 120:
        return False
    return True


def build_scenarios(predicates, refresh: bool, raw_per_predicate: int):
    """Returns list of (predicate, entity, old, new, endDate) tuples."""
    raw_triples = []
    for pred in predicates:
        cache_key = f"{pred['id']}-en"
        try:
            data = fetch_sparql(sparql_template(pred["id"], raw_per_predicate), refresh, cache_key)
        except Exception as e:
            print(f"WARN: SPARQL failed for {pred['id']}: {e}", file=sys.stderr)
            continue
        bindings = data.get("results", {}).get("bindings", [])
        for b in bindings:
            entity = b.get("entityLabel", {}).get("value", "")
            old_v = b.get("oldLabel", {}).get("value", "")
            new_v = b.get("newLabel", {}).get("value", "")
            end_date = b.get("endDate", {}).get("value", "")
            if not (well_formed_label(entity) and well_formed_label(old_v) and well_formed_label(new_v)):
                continue
            if not end_date or len(end_date) < 4:
                continue
            raw_triples.append({
                "predicate": pred,
                "entity": entity,
                "old": old_v,
                "new": new_v,
                "end_date": end_date[:10] if "T" in end_date else end_date,  # YYYY-MM-DD
            })
        print(f"  {pred['id']} ({pred['label']}): {len([t for t in raw_triples if t['predicate']['id']==pred['id']])} triples", file=sys.stderr)
    return raw_triples


def to_fixture_scenarios(raw_triples, target_count: int, seed: int):
    """Balance across predicates, split 50/50 Mode A vs Mode B."""
    rng = random.Random(seed)
    by_pred = {}
    for t in raw_triples:
        by_pred.setdefault(t["predicate"]["id"], []).append(t)

    per_pred = max(1, target_count // max(1, len(by_pred)))
    selected = []
    for pid, triples in by_pred.items():
        rng.shuffle(triples)
        selected.extend(triples[:per_pred])
    rng.shuffle(selected)
    selected = selected[:target_count]

    # Determinstic Mode A/B alternation within selected list
    scenarios = []
    for i, t in enumerate(selected):
        mode = "A" if i % 2 == 0 else "B"
        pred = t["predicate"]
        entity = t["entity"]
        old_v = t["old"]
        new_v = t["new"]
        end_date = t["end_date"]
        scenario_id = f"sm-{pred['id']}-{i:03d}"

        end_year = int(end_date[:4]) if end_date[:4].isdigit() else 2020
        valid_from_old = f"{max(1700, end_year - 1)}-01-01T00:00:00Z"
        valid_from_new = f"{end_date}T00:00:00Z"
        asked_at = f"{min(2099, end_year + 1)}-12-31T00:00:00Z"

        old_claim = pred["claim_template"].format(entity=entity, value=old_v)
        new_claim = pred["current_claim_template"].format(entity=entity, value=new_v)

        facts = [{
            "claim": old_claim,
            "subject": "user",
            "source": "user",
            "validFrom": valid_from_old,
            "meta": {"role": "old", "predicate": pred["id"]},
        }]
        if mode == "B":
            facts.append({
                "claim": new_claim,
                "subject": "user",
                "source": "user",
                "validFrom": valid_from_new,
                "meta": {"role": "new", "predicate": pred["id"]},
            })

        question = pred["question_template"].format(entity=entity)
        expected = [new_v]  # canonical gold

        scenarios.append({
            "scenario_id": scenario_id,
            "facts": facts,
            "queries": [{
                "qid": f"{scenario_id}-q0",
                "category": pred["id"],
                "question": question,
                "expected": expected,
                "meta": {
                    "mode": mode,
                    "predicate": pred["id"],
                    "old_value": old_v,
                    "new_value": new_v,
                    "transition_date": end_date,
                    "asked_at": asked_at,
                },
            }],
            "meta": {"predicate": pred["id"], "mode": mode},
        })
    return scenarios


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["mini", "full"], required=True)
    ap.add_argument("--out", required=True, help="Output JSON path")
    ap.add_argument("--refresh", action="store_true", help="Skip /tmp cache, re-query SPARQL")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--predicates", default=",".join(p["id"] for p in PREDICATES),
                    help="Comma-separated predicate IDs")
    args = ap.parse_args()

    target_count = 75 if args.mode == "mini" else 300
    raw_per_predicate = 100 if args.mode == "mini" else 200

    selected_predicates = [p for p in PREDICATES if p["id"] in args.predicates.split(",")]
    if not selected_predicates:
        print(f"ERROR: no predicates matched {args.predicates}", file=sys.stderr)
        sys.exit(2)

    print(f"Fetching Wikidata stale-memory fixture ({args.mode}), {target_count} scenarios target", file=sys.stderr)
    raw = build_scenarios(selected_predicates, args.refresh, raw_per_predicate)
    print(f"  total raw triples: {len(raw)}", file=sys.stderr)
    if len(raw) < target_count // 2:
        print(f"WARN: only {len(raw)} raw triples (<{target_count // 2}). Output will be smaller than target.", file=sys.stderr)

    scenarios = to_fixture_scenarios(raw, target_count, args.seed)

    fixture = {
        "bench_id": "stale-memory",
        "upstream_version": "wikidata-2026-snapshot",
        "description": "Real-world entity-attribute transitions from Wikidata revision history. "
                       "Mode A: only old fact seeded → tests refusal-first. "
                       "Mode B: both seeded with proper validFrom → tests bi-temporal supersession at retrieval.",
        "mode": args.mode,
        "scenarios": scenarios,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"Wrote {out_path}: {len(scenarios)} scenarios "
          f"({len([s for s in scenarios if s['meta']['mode'] == 'A'])} A / "
          f"{len([s for s in scenarios if s['meta']['mode'] == 'B'])} B)", file=sys.stderr)


if __name__ == "__main__":
    main()
