# Demiurge

**Trust-first memory for AI agents.**

Alpha is the security that comes before Omega.

Demiurge is an adaptive memory system that gives any AI agent long-term memory across sessions. Every memory is untrusted until proven otherwise. The write pipeline rejects by default. Storage requires positive evidence of quality.

MCP + REST. SQLite. ARM. $6/month.

## Benchmarks

Full-corpus evaluation (April 2026):

| Benchmark | Score | Notes |
|-----------|-------|-------|
| **BEAM 100K** | **62.7%** | #2 among published systems (Hindsight: 64.1%) |
| **LOCOMO** | **60.2%** | 1,540 questions, 4 categories |
| **LongMemEval** | **62.4%** | 500 questions, 6 categories |

Answer model: GPT-4.1-mini ($0.40/M tokens). Embeddings: BGE-small-en-v1.5 (local ONNX). Judge: GPT-4o-mini. Hardware: Hetzner CAX11, ARM64, 4GB RAM.

### Answer Model Sensitivity

Same retrieval pipeline, different answer models, identical scores:

| Model | Cost | LOCOMO |
|-------|------|--------|
| GPT-4.1-mini (production) | $0.40/M | 61.5% |
| GPT-4.1 full | ~$2/M | 61.5% |
| GPT-5-mini | ~$1/M | 61.5% |

LOCOMO is retrieval-bound. Spending 5x more on the answer model buys nothing.

### Poisoning Defense

19/19 attack vectors blocked. 0/8,098 benign facts rejected (0.00% false positive rate). Nine categories tested: prompt injection, code dumps, credential extraction, unicode tricks, contradictions, duplicate flooding, feedback loops, supersede escalation, bulk import.

## Architecture

TypeScript. Single Docker container. SQLite + sqlite-vec + FTS5.

**Write pipeline:** Zod validation, deterministic content validators (zero LLM), BGE-small embedding, semantic dedup (cosine 0.95), four-branch trust classification, multi-model consensus escalation (17.8% of writes), hash-chained audit log.

**Retrieval pipeline:** 10-type deterministic query classifier, parallel FTS5/BM25 + vector search, entity expansion for multi-hop, per-type injection prompts, conflict surfacing. Zero LLM calls. Mean retrieval: 28ms.

**Answer routing:** Simple queries (single-hop, open-domain) go to GPT-4.1-mini. Complex queries (temporal, multi-hop, synthesis) go to Grok reasoning. Per-type output guidance prevents reasoning trace leakage.

## Quick Start

```bash
# Clone and configure
git clone https://github.com/Preston2012/demi.git
cd demi
cp .env.example .env
# Edit .env with your API keys

# Download embedding model
mkdir -p models
# Download bge-small-en-v1.5.onnx to models/

# Run
docker compose up
```

MCP endpoint: `POST /mcp`
REST endpoint: `http://localhost:3100`

## Cost

| Component | Cost |
|-----------|------|
| Infrastructure | $6.09/month (Hetzner CAX11) |
| Retrieval | $0.00 (zero LLM calls) |
| Write consensus (17.8% of writes) | ~$0.003/escalation |
| Answer generation | ~$0.0004/query |

## Project

Built by Preston Winters with Claude, GPT, Gemini, and Grok via multi-model council methodology.

MIT License.

Paper: [forthcoming]
