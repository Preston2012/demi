# Custom Benches (Packets C1 + C2)

Six benchmarks that measure capabilities Demiurge actually claims, rather than
chasing public-bench style sensitivity (LOCOMO/LME). Each writes JSON to
`benchmark-results/<bench>-<ISO>.json`, mirroring `benchmark-locomo-official.ts`.

C1 covers correction propagation, cross-session temporal, multi-hop chain.
C2 covers skin persona, cold-warm transition, intent inference under ambiguity.

## Bench 1, Correction Propagation

`src/benchmark/correction-propagation/`

Plants a fact, then a correction. Asks four question types per trace:
`current` / `historical` / `change` / `list`. Fresh `:memory:` SQLite per
trace. Facts inserted via `repo.insert()` with explicit `supersedes` and
`validAt`/`invalidAt`, because `dispatch.addMemory` cannot set `supersedes`
(see `src/schema/memory.ts:317`).

Runs both `BI_TEMPORAL_ENABLED=true` and `=false` modes; the dual-mode
comparison surfaces whether the bi-temporal read filter satisfies the
"correction propagation" claim. Historical questions under `=true` are
expected to return 0%, that is itself the bench's primary finding.

Sizes: mini = 8 traces × 4 = 32 Q. Full = 50 traces × 4 = 200 Q.

## Bench 2, Cross-Session Temporal

`src/benchmark/cross-session-temporal/`

One persistent `:memory:` repo for the whole run. 50 sessions × 5-10 facts,
spanning ~6 months, one session every ~3.5 days. Each fact gets explicit
`validFrom`. Five question types: `recent` / `mid` / `distant` /
`time-anchored` / `order-aware`. Deterministic judge (≥3 distinctive nouns
for recall; literal "before"/"after" for order). `TEST_MODE=true` bypasses
conflict-quarantine across the ~350 facts.

Sizes: mini = 20 sessions, ~120 facts, 30 Q. Full = 50 sessions, ~350 facts,
150 Q.

## Bench 3, Multi-Hop Chain

`src/benchmark/multi-hop-chain/`

Closed-world entity-chain reasoning. Per scenario: 3-8 entities, 4-12 atomic
facts, 2 questions (one 2-hop, one 3-hop) with `evidence_chain` listing the
fact_ids needed to answer. Fresh `:memory:` repo per scenario, embeddings
init for semantic recall.

LLM judge (`gpt-4o-mini`) for answer correctness, plus deterministic
`evidence-chain coverage` = `|retrieved ∩ chain| / |chain|`. Hallucination
rate = % correct answers with coverage < 1.0 (model nailed the answer
without all the facts).

Sizes: mini = 15 scenarios = 30 Q. Full = 60 scenarios = 120 Q.

The committed fixture (`fixtures/scenarios.json`) is a hand-crafted starter
with 15 scenarios. Re-run the generator to expand to 60 LLM-generated
scenarios:

```bash
npx tsx src/benchmark/multi-hop-chain/generator.ts --target 60
```

Cost estimate: ~150 LLM calls × ~2K tokens output × $0.4/1M ≈ $0.12.

## Bench 4, Skin Persona Consistency

`src/benchmark/skin-persona/`

A persona = one strong constraint about the user (vegetarian, sober,
peanut allergy, kosher, type-1 diabetic, etc.) + neutral facts. Each persona
gets three Q types: `direct-relevant`, `adjacent-relevant`, `unrelated-control`.
Fresh `:memory:` repo per persona-trace. Facts inserted via `dispatch.addMemory`.

Deterministic judge: relevant Qs require ≥1 expected keyword AND no forbidden
keyword (e.g. for vegetarian dinner: must not contain "steak"). Unrelated
controls require persona keyword to be ABSENT (persona-leak metric).

Sizes: mini = 4 personas × 6 Q = 24 Q. Full = 8 personas × 3 traces × 12 Q
= 288 Q.

Reportable metrics: per-type accuracy, persona-leak rate (orthogonal Qs that
mention persona), exclusion-violation rate (relevant Qs that mention forbidden
item), persona-injection rate (% of relevant Qs where retrieval surfaced ≥1
constraint claim).

## Bench 5, Cold-Warm Transition

`src/benchmark/cold-warm/`

Demiurge supports two product modes: **fresh** (cold start) and **smart**
(pre-populated). This bench measures the transition. Each scenario has a
seed pack (8-12 facts, `source: 'import'` → `provenance: IMPORTED`) and a user
stream (6-10 facts, `source: 'user'` → `provenance: USER_CONFIRMED`). No new
env flag needed, source maps to provenance via the existing trust-branch
pipeline (`src/write/trust-branch.ts:94-98`).

Four Q types: `seed-only`, `user-only`, `hybrid` (must mention both with
attribution), `conflict` (user version wins).

Sizes: mini = 4 packs × 1 trace × ~8 Q ≈ 32 Q. Full = 4 packs × 4 traces ≈
80-150 Q.

Reportable metrics: per-type accuracy, seed-leakage rate on user-only Qs,
user-leakage rate on seed-only Qs, conflict resolution accuracy, hybrid
attribution accuracy (does retrieved set contain both provenances?).

## Bench 6, Intent Inference Under Ambiguity

`src/benchmark/intent-ambiguity/`

Closed-world disambiguation. Each scenario has 3-5 entities, 4-15 facts, and
2-5 deliberately ambiguous questions (pronoun, partial-name, time-relative,
polysemy, default-reference). Each question carries both a `preferred`
interpretation (contextually correct) and an `incorrect` interpretation (also
plausible, that's the ambiguity).

Fresh `:memory:` repo per scenario, embeddings init for semantic recall.

Two scores per question, kept independent:
- LLM judge (`gpt-4o-mini`) returns 1.0 / 0.5 / 0.0 (preferred / incorrect-but-
  plausible / wrong)
- Deterministic disambiguation rate = % of retrieved facts about the
  preferred entity vs the incorrect one

Reportable metrics: mean LLM score, exact-correct %, disambiguation rate by
ambiguity type, confusion rate (% wrong answers where preferred-entity facts
WERE retrieved, model failed to use them).

Sizes: mini = 12 scenarios = 36 Q. Full = 50 scenarios ≈ 200 Q.

Committed starter fixture has 15 scenarios. Re-run the generator to expand to
50 LLM-generated scenarios:

```bash
npx tsx src/benchmark/intent-ambiguity/generator.ts --target 50
```

Cost estimate: ~150 LLM calls × ~2K tokens × $0.4/1M ≈ $0.12.

## Reproduction

```bash
# C1
bash scripts/run-correction-propagation-mini.sh
bash scripts/run-correction-propagation-full.sh
bash scripts/run-cross-session-temporal-mini.sh
bash scripts/run-cross-session-temporal-full.sh
bash scripts/run-multi-hop-chain-mini.sh
bash scripts/run-multi-hop-chain-full.sh

# C2
bash scripts/run-skin-persona-mini.sh
bash scripts/run-skin-persona-full.sh
bash scripts/run-cold-warm-mini.sh
bash scripts/run-cold-warm-full.sh
bash scripts/run-intent-ambiguity-mini.sh
bash scripts/run-intent-ambiguity-full.sh
```

Each script accepts `EXTRA_FLAGS` for A/B testing Packet A toggles, e.g.:

```bash
EXTRA_FLAGS="ENTITY_BOOST_ENABLED=true HYBRID_FUSION_MODE=additive" \
  bash scripts/run-correction-propagation-mini.sh
```

Results land in `benchmark-results/`; logs land in `scripts/logs/`.

## Tests

Unit tests live at `tests/unit/benchmark-{correction-propagation,cross-session-temporal,multi-hop-chain,skin-persona,cold-warm,intent-ambiguity}.test.ts`.

```bash
npx vitest run tests/unit/benchmark-*.test.ts
```
