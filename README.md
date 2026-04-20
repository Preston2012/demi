# Demiurge

**Trust-first memory for AI agents.**

Alpha is the security that comes before Omega.

Demiurge is an adaptive memory system that gives any AI agent long-term memory across sessions. Every memory is untrusted until proven otherwise. The write pipeline rejects by default. Storage requires positive evidence of quality.

MCP + REST. SQLite. ARM. $6/month.

## Benchmarks

Full-corpus evaluation (April 2026):

| Benchmark | Score | Questions |
|-----------|-------|-----------|
| **LOCOMO** | **60.4%** | 1,540 across 10 conversations |
| **LongMemEval** | **64.8%** | 500 across 6 categories |
| **BEAM 100K** | **62.7%** | 400 across 20 conversations |
| **BEAM 500K** | **58.8%** | 700 across 35 conversations |
| **BEAM 1M** | **57.4%** | 700 across 35 conversations |

BEAM 10M tier: deferred (cost).

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

### Safety: FRAME Suite

Five harnesses run against the refusal-first write pipeline. Latest run (tester brain, April 20, 2026):

| Metric | Value |
|--------|-------|
| Abstention Precision | 88.0% (22/25) |
| Poison Acceptance Rate | 6.00% (3/50) |
| False Refusal Rate | 0.00% (0/50) |
| Contradiction Containment | 93.8% (100% write / 87.5% retrieval) |
| Time-to-Correction | 1.80 turns average |

FRAME is shipped and runs in CI against an isolated clone of the engine. Full harness: `src/frame/`.

Prior adversarial harness (9 attack categories, 19 vectors) remains green: all 19 blocked, zero false positives on 8,098 benign facts from the LOCOMO corpus.

## Architecture

TypeScript. Single Docker container. SQLite + sqlite-vec + FTS5.

**Write pipeline:** Zod validation, deterministic content validators (zero LLM), BGE-small embedding, semantic dedup (cosine 0.95), four-branch trust classification, multi-model consensus escalation (~17.8% of writes in benchmark evaluation), hash-chained audit log with periodic HMAC snapshots.

**Retrieval pipeline:** 10-type deterministic query classifier, parallel FTS5/BM25 + vector search, entity expansion for multi-hop, per-type injection prompts, conflict surfacing. Zero LLM calls on the read path. Mean retrieval latency 47ms, p95 109ms (full 1,540-question LOCOMO run). 91% of queries complete under 100ms. Vector search dominates (~30ms), driven by BGE-small ONNX encode (~20ms) and sqlite-vec KNN scan (~9ms). Dual-phrasing extraction doubles the fact corpus and accounts for part of the per-query scoring cost; int8 quantization was tested and rejected (1.7% real-world gain did not justify the migration cost).

**Answer routing:** Simple queries (single-hop, open-domain, current-state) go to GPT-4.1-mini. Complex queries (multi-hop, temporal, synthesis, narrative) go to Grok 4.1 Fast Reasoning. Routing is default-on for BEAM and LongMemEval; LOCOMO uses GPT-4.1-mini only because single-hop questions dominate the weighting.

**Shipped since the last public release:** STONE (immutable conversation log with turn-level search), Memory Autopsy (failure tracing through extraction, retrieval, injection, and answer), specialist pipeline, temporal specialist (flag-gated), compression router, entity-split temporal retrieval, answer escalation, bge-reranker-base, Pro-tier consensus gate, claims graph V2 Phase 1a schema.

## Quick Start

```bash
git clone https://github.com/Preston2012/demi.git
cd demi
cp .env.example .env
# Edit .env with your API keys

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

A consumer product on top of Demiurge is in development: mobile-first, BYOK multi-model routing, transcript-import onboarding. Early API scaffold at [demi-api](https://github.com/Preston2012/demi-api).

## Project

Built by Preston Winters with Claude, GPT, Gemini, and Grok via multi-model council methodology.

MIT License.

Paper: forthcoming. See `docs/ADDENDUM.md` for supplementary material (security controls mapping, FRAME protocol, roadmap).
