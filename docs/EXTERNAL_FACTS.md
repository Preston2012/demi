# Demiurge external facts

Provenance for every number in the README, so the claims are auditable against the result files. All runs unrouted (the shipping configuration): GPT-4.1-mini answer model, GPT-4o-mini judge, one config across every benchmark.

Every benchmark was measured at a single commit, `bea5522`. The quality benchmarks (LOCOMO, LongMemEval, BEAM, CloneMem, MemoryAgentBench) were recorded 2026-06-12. The safety, product-correctness, and calibration suites were re-run at the same commit on 2026-06-15, so the whole table sits on one commit and reproduces from a single `git checkout`.

## Public benchmarks (commit bea5522)

| Benchmark | Score (correct / N) | Result file |
|---|---|---|
| LOCOMO full | 57.3% J-score (882 / 1,540 scored; 1,986 total, 446 category-5 excluded) | locomo-official-full-bea5522 |
| LongMemEval full | 48.0% (240 / 500) | longmemeval-full-bea5522 |
| BEAM 100K | 45.9% (0.4587 over 400 q, 20 conversations) | beam-100k-full-bea5522 |
| BEAM 500K | 47.3% (0.4727 over 700 q, 35 conversations) | beam-500k-full-bea5522 |
| CloneMem | 96.2% (179 / 186) | clonemem-100k-full (engine bea5522) |
| MemoryAgentBench sh_6k | 65.0% (65 / 100) | mab-conflict-resolution-sh_6k (engine bea5522) |

## Safety (commit bea5522)

| Suite | Result (pass / N) | Result file |
|---|---|---|
| FRAME-INJECT | 100% (200 / 200) | security-frame-inject-full |
| FRAME-SYBIL | 100% (150 / 150) | security-frame-sybil-full |
| FRAME-AUDIT | 100% (150 / 150) | security-frame-audit-full |
| VAULT | 98.1% (52 / 53) | security-vault-full |

VAULT: the one miss is the `vault-no-key-prod-rejection` case. The in-memory benchmark DB has no encryption layer, so the no-key open returns success instead of rejecting; the check cannot fire in the harness. Zero plaintext leaks across all 53 cases. Encryption-at-rest key enforcement is active in the encrypted production store.

## Product correctness (commit bea5522)

| Suite | Score (correct / N) | Result file |
|---|---|---|
| paraphrase | 91.9% (735 / 800) | paraphrase-full |
| stale-memory | 37.7% (113 / 300) | stale-memory-full |
| attribution | 39.6% (95 / 240) | attribution-full |

stale-memory runs the generator-built full fixture: 300 scenarios (150 capital transitions plus 150 chairperson transitions from Wikidata revision history, `wikidata-2026-snapshot`), produced by `scripts/fetch-wikidata-stale-fixture.py --mode full`. The committed `full.json` is a 12-scenario placeholder, so reproducing this number means running the generator first; the script caches its SPARQL responses, so re-runs are deterministic and offline.

## Calibration (commit bea5522)

| Metric | Value (N) | Result file |
|---|---|---|
| Accuracy | 87.2% (872 / 1,000) | ece-brier-full |
| ECE | 0.100 (1,000) | ece-brier-full |
| Brier | 0.117 (1,000) | ece-brier-full |
| recall@K AUPRC | 0.917 (200 clusters) | recall-full |

## Retrieval latency

Served latency and benchmark-harness latency are different measurements. The served path is what a request actually costs; the harness runs every query cold against the full seeded corpus through the whole pipeline.

| Path | Latency | Notes |
|---|---|---|
| Served (live store) | median ~45 ms, 31 to 174 ms | 8 varied connector queries against a ~3.6K-memory store; simple lookups ~30 ms, temporal ~175 ms |
| Benchmark harness (LOCOMO full, bea5522) | mean 1,148 ms, p50 1,014 ms, p95 2,768 ms | cold per query against the full seeded corpus; evaluation path, not served |
| Lexical and vector scoring step | ~47 ms | engine-internal sub-step, 50 ms SLO |

## Measurement notes

- **Judge noise** is about 2.5 points (three-way judge analysis, 86.8% agreement; disagreement concentrated on hedging, partial answers, temporal edge cases). LongMemEval full-500Q standard error is about 2.2 points, mini about 5 points. LOCOMO floor is about 1.4 points. Treat gaps under 3 points between systems as noise.
- **Small categories swing hard.** CloneMem counterfactual (n=8) and LongMemEval knowledge-update (n=16) move 13 to 25 points on a single judgment.
- **Answer-model sensitivity differs by benchmark.** LOCOMO is retrieval-bound: three answer models across an 8x cost range score identically. LongMemEval is model-sensitive: a published system gained 10.7 points swapping GPT-4o for GPT-5-mini. All scores here use gpt-4.1-mini unrouted, the shipping config.
- **Most wrong answers are fact-present.** On LongMemEval and BEAM the correct fact was retrieved and the answer model miscounted or misread it, which is an answer-model ceiling rather than a retrieval miss.
- **LOCOMO metric.** Reported as LLM-judge score (57.3%); token-F1 on the same run is 0.13, because LOCOMO answers are long-form and F1 penalizes them. The judge score is the comparable metric.

stale-memory and attribution share one root cause: the write-time deduplication comparator (cosine 0.95) collapses claims that read alike but carry different validity dates, so a superseded value can stay in retrieval while the current one is dropped. The recency-preserving exception is the active engine fix. Both numbers are published as measured.
