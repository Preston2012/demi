# Demiurge

**Trust-first memory for AI agents.**

Alpha is the security that comes before Omega.

Demiurge is an adaptive memory system that gives any AI agent long-term memory across sessions. Every memory is untrusted until proven otherwise. The write pipeline rejects by default. Storage requires positive evidence of quality.

MCP + REST. SQLite. ARM. $6/month.

## Benchmarks

Full-corpus evaluation (May 2026, commit `3ceca61`). Routing on for every bench.

### Public benchmarks

| Benchmark | Score | Questions |
|-----------|-------|-----------|
| **LOCOMO** | **60.9%** J-score | 1,540 across 10 conversations |
| **LongMemEval** | **62.8%** | 500 across 6 categories |
| **BEAM 100K** | **61.0%** | 400 across 20 conversations |
| **BEAM 500K** | **58.8%** | 700 across 35 conversations |
| **BEAM 1M** | **57.4%** | 700 across 35 conversations |
| **CloneMem** | **96.2%** | 186 across 3 cloned-personality dimensions |
| **MemoryAgentBench (sh_6k)** | **98.0%** | 100 fact-consolidation queries |

BEAM 10M tier: deferred (cost). BEAM 500K and 1M from April 2026 (CAX21); CloneMem and MAB are first published numbers.

### Safety suite

| Bench | Score | Tests |
|-----------|-------|-------|
| **FRAME-INJECT** | **100%** | 200 prompt-injection adversarial writes |
| **FRAME-SYBIL** | **100%** | 150 identity-spoofing writes |
| **FRAME-AUDIT** | **100%** | 150 hash-chain tamper patterns |
| **VAULT** | **100%** | 53 encryption-at-rest checks |

VAULT verifies SQLCipher encryption is enforced at rest with key isolation: no plaintext leaks in raw bytes, wrong-key opens are rejected, and prod-mode boot fails without a configured key.

### Product correctness suite

| Bench | Score | Tests |
|-----------|-------|-------|
| **stale-memory** | **100%** | 12 Wikidata revision-history scenarios (validates bi-temporal supersession) |
| **attribution** | **99.6%** | 240 source-disclosure queries across 5 patterns |
| **paraphrase** | **97.4%** | 800 cluster-level Jaccard checks across 4 paraphrases |

### Calibration suite

| Bench | Metric | Value |
|-----------|--------|-------|
| **ECE / Brier** | Accuracy / ECE / Brier | **91.6% / 0.065 / 0.075** on 1,000Q |
| **recall@K** | F1@3 / Precision / Recall / AUPRC | **0.828 / 0.857 / 0.807 / 0.940** on 200 clusters |

ECE (Expected Calibration Error) measures how well stated confidence matches observed accuracy: 0.065 means confidence claims and outcomes track within ~6.5 percentage points across the calibration curve. recall@K measures retrieval quality on labeled-cluster ground truth, independent of the answer model.

Answer model: GPT-4.1-mini ($0.40/M tokens) for simple queries, Grok 4.1 Fast Reasoning for complex. Embeddings: BGE-small-en-v1.5 (local ONNX, 384d). Judge: GPT-4o-mini (temperature 0, binary). Hardware: Hetzner CAX11 (ARM64, 2 vCPU, 4GB RAM); heavy tiers on CAX21 (ARM64, 4 vCPU, 8GB).

All scores are self-reported under the golden configuration (`scripts/verify-golden-config.sh`). Numerical comparison to other systems requires matched experimental conditions; answer model, judge, and retrieval parameters vary across published results.

### Answer Model Sensitivity

Same retrieval pipeline, different answer models, identical scores on LOCOMO-mini (296 questions):

| Model | Input Cost | LOCOMO-mini |
|-------|-----------|-------------|
| GPT-4.1-mini | $0.40/M | 61.5% |
| GPT-4.1 full | ~$2.00/M | 61.5% |
| GPT-5-mini | ~$1.00/M | 61.5% |

LOCOMO is retrieval-bound for this architecture. A 5x increase in answer model cost produces zero accuracy change. We recommend memory benchmarks report answer model cost alongside accuracy, or standardize on a common answer model for cross-system comparison.

## Architecture

TypeScript. Single Docker container. SQLite + sqlite-vec + FTS5. SQLCipher encryption at rest.

**Write pipeline:** Zod validation, deterministic content validators (zero LLM), BGE-small embedding, semantic dedup (cosine 0.95), four-branch trust classification, multi-model consensus escalation (~17.8% of writes in benchmark evaluation), hash-chained audit log with periodic HMAC snapshots.

**Retrieval pipeline:** 10-type deterministic query classifier, parallel FTS5/BM25 + vector search, entity expansion for multi-hop, per-type injection prompts, conflict surfacing. Zero LLM calls on the read path. Mean retrieval latency 45ms (full 1,540-question LOCOMO run). 91% of queries complete under 100ms. Vector search dominates (~30ms), driven by BGE-small ONNX encode (~20ms) and sqlite-vec KNN scan (~9ms). Dual-phrasing extraction doubles the fact corpus and accounts for part of the per-query scoring cost; int8 quantization was tested and rejected (1.7% real-world gain did not justify the migration cost).

**Answer routing:** Simple queries (single-hop, open-domain, current-state) go to GPT-4.1-mini. Complex queries (multi-hop, temporal, synthesis, narrative) go to Grok 4.1 Fast Reasoning. Routing is default-on across every bench; per-query selection is exposed as `model_used` in result records so any "routing on" claim is verifiable from the artifact.

**Bi-temporal supersession.** Updated facts supersede prior values at write time, with the historical chain preserved for queries that ask about the past. The `stale-memory` bench validates that current-state queries return the latest value while history-aware queries can reach prior values.

**Confidence exposure.** The `dispatch.answer()` result exposes an aggregate `confidence` value in `[0,1]`. Logprob-derived where the provider supports it (OpenAI, xAI), self-report parsing fallback (`<confidence>0.X</confidence>`) for streaming providers. Default 0.5 on extraction failure. The ECE bench scores how well that confidence tracks observed accuracy.

**Shipped since the last public release:** SQLCipher encryption-at-rest with envelope-encrypted key isolation, FRAME-INJECT/SYBIL/AUDIT/VAULT security benches, stale-memory bench, attribution/paraphrase/difficulty product-correctness benches, ECE/Brier and recall@K calibration benches, engine-side confidence exposure, bi-temporal supersession at the retrieval layer, multi-provider URL routing in every bench's `callLLM`, `model_used` and `query_type` audit fields on result records.

## Quick Start

```bash
git clone https://github.com/Preston2012/demi.git
cd demi
cp .env.example .env
# Edit .env with your API keys and DEMIURGE_DB_KEY for encryption-at-rest

# Download embedding model
mkdir -p models
# Download bge-small-en-v1.5.onnx to models/

docker compose up
```

MCP endpoint: `POST /mcp`
REST endpoint: `http://localhost:3100`

## Cost

| Component | Cost |
|-----------|------|
| Infrastructure (Hetzner CAX11) | $6.09/month |
| Retrieval | $0.00 (zero LLM calls) |
| Write consensus (~17.8% of writes) | ~$0.003/escalation |
| Answer generation | ~$0.0004/query |
| Estimated per-conversation | ~$0.04 |

At 1,000 conversations/month, total cost is approximately $46/month.

## Companion App

A consumer product on top of Demiurge: **MyKonos.** Mobile-first, BYOK multi-model routing, memory-active visual primitive (the UI lights up when the engine pulls something it learned about you, instead of hiding the retrieval behind a black box). Live on Preston's phone; first beta tester is reading the [Ouroboros](https://github.com/Preston2012/ouroboros) draft on it. Proprietary; the engine is open. Early API scaffold at [demi-api](https://github.com/Preston2012/demi-api).

## Project

Built by Preston Winters with Claude, GPT, Gemini, and Grok via multi-model council methodology.

MIT License.

Paper: forthcoming. See `docs/ADDENDUM.md` for supplementary material (security controls mapping, FRAME protocol, roadmap).

---

## Part of a 3-repo arc

- **Demiurge** (this repo). The open-source memory engine.
- **[Ouroboros](https://github.com/Preston2012/ouroboros).** Governance architecture for the AI era. The personal AI companion in Layer 1 is what Demiurge makes implementable.
- **[AI Council](https://github.com/Preston2012/ai-council).** The multi-model orchestration methodology used to build everything here. 500+ build sessions, 390+ documented rules.

Coming next: **[Memory Sovereignty Principles](https://github.com/Preston2012/memory-sovereignty-principles).** A spec doc + benchmark harness scoring AI memory providers (including this one) against ten principles of user data sovereignty.

[Preston Winters](https://github.com/Preston2012). Solo. Reach out at [preston@baseline.marketing](mailto:preston@baseline.marketing).
