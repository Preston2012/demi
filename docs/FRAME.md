# FRAME: Fair Retrieval and Adversarial Memory Evaluation

A product-level evaluation framework for AI memory systems, measuring what
users actually feel, not just what retrieval benchmarks score.

## Why FRAME

Academic memory benchmarks (LOCOMO, BEAM, LongMemEval) measure retrieval
quality against synthetic conversations. They do not measure:

1. Whether a memory system knows what it doesn't know (abstention precision).
2. Whether a memory system refuses poisoned writes (poisoning defense).
3. Whether contradictions are contained at write time, retrieval time, or leak.
4. How quickly a memory system updates when a user corrects it.

FRAME reports 4 numbers:

- **Poison Acceptance Rate (PAR)**, % of adversarial writes accepted as valid.
- **Abstention Precision (AP)**, % of "I don't know" questions where the
  system correctly refuses to manufacture an answer.
- **Contradiction Containment Rate (CCR)**, % of contradiction events that
  are surfaced at write time OR retrieval time (vs leaked to injection).
- **Time-to-Correction (TTC)**, average retrieval turns until a corrected
  claim replaces the original in top-1 results.

Each is a single number. Each is reproducible. Each runs via
`scripts/metrics/*.ts` and emits a JSON result file.

## Protocol

### Target

FRAME targets a running memory system exposing MCP tools `memory_add`,
`memory_search`, `memory_correct`, and optionally `self_play_run`.

### Corpus

- **AP:** 25 curated questions where the correct behavior is abstention.
- **PAR:** 100 adversarial writes across 8 attack vectors, interleaved with
  100 legitimate writes.
- **CCR:** 8 contradiction pairs (same subject, opposing claims).
- **TTC:** 10 correction scenarios (original claim → correction → polling).

Corpora are versioned in `scripts/metrics/` and change-tracked. Report
results with corpus version.

### Scoring

- PAR: `accepted_adversarial / total_adversarial`. Lower is better.
- FRR (reported alongside PAR): `refused_legit / total_legit`. Lower is better.
- AP: `correct_abstentions / total_abstention_questions`. Higher is better.
- CCR:
  - Write-time CCR: `write_flagged_conflicts / total_pairs`.
  - Retrieval-time CCR: `(no_both_present OR conflicts_flagged) / total_pairs`.
  - Unified CCR: average of the two. Higher is better.
- TTC: average turns until corrected claim wins top-1. Lower is better.

### Reproducibility

Every FRAME run emits `metric-results/frame-<ts>.json` containing:

- Target MCP URL.
- Per-metric status, numeric scores, and elapsed time.
- Full trace of individual test cases in per-metric JSON files.

To reproduce:

```bash
export AUTH_TOKEN=<your token>
export DEMI_MCP_URL=http://localhost:3101/mcp  # clone or test instance
npx tsx scripts/metrics/frame.ts
```

DO NOT run against production brains, CCR, TTC, and PAR all write test
memories.

## Reporting

When citing FRAME results, always state:
- Target brain identifier and memory count.
- Corpus version (commit hash of `scripts/metrics/`).
- Date of run.
- Model versions used by the brain under test (embedding, classifier, answer).
- **Reproducibility caveat: OpenAI API models (gpt-4.1-mini, gpt-4o-mini) are not version-pinned for minor updates. A score from 2026-04-18 may not reproduce on 2026-04-19 without any code change.** Always measure fresh, never re-cite stale scores as current.

Example citation:

> On a production brain of 912 memories, Demiurge achieved: PAR 0.5%,
> FRR 0.0%, AP 96%, unified CCR 87.5%, TTC 1.2 turns
> (FRAME v1.0, corpus commit abc1234, measured 2026-04-20,
> answer=gpt-4.1-mini, judge=gpt-4o-mini, embed=bge-small-en-v1.5).

## Relation to existing benchmarks

FRAME is orthogonal to LOCOMO/BEAM/LongMemEval. A system can score 95% on
BEAM and have a Poison Acceptance Rate of 80% (unsafe for production). A
system can score 60% on BEAM and have PAR below 1% (production-grade).

Both matter. FRAME does not replace academic benchmarks. FRAME measures
what academic benchmarks cannot.

## API drift and version discipline

All FRAME metrics that call an LLM (abstention precision via retrieval
thinness is the only one that currently does not) are subject to silent
drift when the underlying API model updates. OpenAI does not version-pin
minor updates on gpt-4.1-mini or gpt-4o-mini. A measurement is valid for
the date and model version it was taken with.

Options for mitigating drift in published claims:

1. Cite every number with measurement date and model version. Re-measure
   quarterly. Publish as a range, not a point.
2. Pin to an explicit model snapshot if the provider offers one
   (e.g. `gpt-4.1-mini-2025-XX-XX`). Accept that snapshots are retired
   on provider timelines.
3. Switch answer and judge to a locally-hosted model with pinnable
   weights (e.g. Llama-3.1-8B, Qwen2.5) for reproducibility-first
   claims. Accept the quality gap vs frontier APIs.

FRAME itself does not prescribe a choice, it prescribes the disclosure.

## Limitations

- Corpus is small (25-100 items per metric). Suited for tracking regressions
  across runs, not for claiming absolute superiority over another system at
  <3pp resolution.
- AP uses a retrieval-thinness proxy, not answer-model behavior. Future
  versions should integrate an answer model and verify via LLM judge.
- TTC measures retrieval win, not user-perceived correction. Real user
  behavior includes follow-up questions and conversation context.

## Versioning

FRAME v1.0 is defined by this document and the scripts committed alongside
it. Future versions track changes in `CHANGELOG.md`.
