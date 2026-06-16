# Demiurge

**Trust-first memory for AI agents.**

*Alpha is the security that comes before Omega.*

Demiurge gives any AI agent durable memory across sessions, built on a single inversion: every memory is untrusted until it earns a place. The write pipeline rejects by default. Storage requires positive evidence of quality. Most memory systems keep everything and inherit a junk problem. Demiurge refuses first.

It speaks MCP and REST, stores to SQLite, embeds locally, encrypts at rest, and runs on a $6/month ARM box.

---

## Why it is built this way

A memory an agent will act on has to be trustworthy, not just present. Demiurge treats every incoming write as a claim to be adjudicated, not a fact to be filed.

- **Refusal-first writes.** Each claim runs a gauntlet: content validation, prompt-injection screening, and duplicate detection. Anything that fails never enters the retrieval pool. Borderline imports are quarantined for an explicit confirm step instead of being stored blind.
- **Trust classes and provenance.** Every stored memory carries a trust class (confirmed, quarantined, rejected) and a provenance record. Retrieval serves only memory that earned its place.
- **Tamper-evident history.** Writes are linked in a per-user hash chain with signed snapshots and a per-user epoch model. Deletions leave tombstone manifests. A verifier proves the chain has not been altered after the fact.
- **Encrypted at rest.** The store is SQLCipher-encrypted. Production refuses to boot without a configured key, wrong-key opens are rejected, and no plaintext appears in the raw bytes.

This is the part the benchmark tables do not show, and it is the reason Demiurge exists.

## Architecture

- **Interface:** MCP server as the primary surface, with a thin localhost REST adapter. One Docker container.
- **Storage:** SQLite with sqlite-vec and FTS5, write-ahead logging.
- **Embeddings:** BGE-small-en-v1.5, ONNX, 384 dimensions, fp32, loaded in process. No embedding API calls.
- **Retrieval:** one hybrid pass over sqlite-vec vector search and FTS5 lexical search. Served retrieval on a live store runs in tens of milliseconds: a median around 45 ms across varied queries, roughly 30 ms for simple lookups and up to about 175 ms for temporal queries that assemble a timeline. Offline benchmark timings are higher (around a second) because the harness runs every query cold against the full seeded corpus.
- **Answer model:** GPT-4.1-mini, the same model on every query. Judge: GPT-4o-mini. Provider failover across OpenAI, xAI, and DeepSeek.
- **Footprint:** one Hetzner CAX ARM instance, 4 GB, about $6/month.

## Benchmarks

Every number here is produced by the exact configuration that ships as the product. One config runs all benchmarks: no per-benchmark tuning, no answer-model routing, no test-set seeding beyond what a normal user would provide. The datasets are gitignored and the runners cannot reach them in continuous integration, so a score cannot drift by accident. These numbers are lower than the routed or tuned figures published for some other systems. That is deliberate, and it is the only kind of number worth trusting.

Every benchmark here is measured at a single commit, `bea5522`, unrouted.

### Public benchmarks

| Benchmark | Score | Questions |
|---|---|---|
| LOCOMO (full) | 57.3% J-score | 1,540 scored across 10 conversations |
| LongMemEval (full) | 48.0% | 500 across 6 categories |
| BEAM 100K | 45.9% | 400 across 20 conversations |
| BEAM 500K | 47.3% | 700 across 35 conversations |
| CloneMem | 96.2% | 186 across 3 cloned-personality dimensions |
| MemoryAgentBench (sh_6k) | 65.0% | 100 fact-consolidation queries |

CloneMem and MemoryAgentBench are first published numbers.

### Safety suite

| Suite | Result | Tests |
|---|---|---|
| FRAME-INJECT | 100% | 200 prompt-injection adversarial writes |
| FRAME-SYBIL | 100% | 150 identity-spoofing writes |
| FRAME-AUDIT | 100% | 150 hash-chain tamper patterns |
| VAULT | 98.1% | 52/53 encryption-at-rest checks |

VAULT confirms encryption is enforced at rest: zero plaintext leaks across all 53 cases, and in production a wrong-key or no-key open is rejected and boot fails without a configured key. The single miss is the no-key rejection check itself, which the benchmark harness cannot exercise because it runs against an in-memory database with no encryption layer; the enforcement it checks for is active in the encrypted production store.

### Product correctness

| Suite | Score | Tests |
|---|---|---|
| paraphrase | 91.9% | 800 cluster-level Jaccard checks across 4 paraphrasings |
| stale-memory | 37.7% | 300 Wikidata revision-history scenarios (bi-temporal supersession) |
| attribution | 39.6% | 240 source-disclosure queries across 5 patterns |

stale-memory and attribution are low for one specific, diagnosed reason. See the note below.

### Calibration

| Metric | Value |
|---|---|
| Accuracy / ECE / Brier | 87.2% / 0.100 / 0.117 (1,000 items) |
| recall@K (AUPRC) | 0.917 (200 labeled clusters) |

ECE (expected calibration error) measures how closely stated confidence tracks observed accuracy: 0.100 means confidence claims and outcomes agree within about 10 points across the calibration curve. recall@K measures retrieval quality against labeled-cluster ground truth, independent of the answer model.

### Why stale-memory and attribution are low

Both trace to one cause in the retrieval layer, not the answer model. When the same fact is asserted at different times (a country's capital changes, an officeholder changes), the deduplication step collapses the near-identical claims, and the engine can keep the earlier version while the current one never reaches retrieval. attribution then cites the wrong date, and stale-memory returns the superseded value. The fix is a recency-preserving exception in the deduplication comparator, so two claims that read alike but carry different validity dates are kept apart. It is in progress. These scores are published as measured rather than scored around, because a memory engine that quietly hides its temporal blind spot is the opposite of what this project is for.

## How to read these numbers

These are single-config, unrouted, self-run scores, and the QA benchmarks measure a narrow slice of what a memory engine does. A few things worth knowing before comparing them to a leaderboard:

- **Where we are honestly behind.** LOCOMO is retrieval-bound: a stronger answer model scores identically on it, and the systems above us genuinely retrieve better. Multi-hop and event-ordering are retrieval-completeness gaps, and the deduplication recency issue above is ours. These are published as they are.
- **The answer model matters on some benchmarks and not others.** LOCOMO is model-insensitive; LongMemEval is the opposite, where a published system gained more than 10 points just by swapping its answer model. We run gpt-4.1-mini, the same model that ships, so the model-sensitive scores carry a small-model ceiling rather than a memory limit.
- **Most wrong answers are retrieval hits the model fumbled.** On the harder cells the correct fact was retrieved and the answer model miscounted or misread it. That is an answer-model ceiling, not a memory miss.
- **Judge and sample noise are real and measured.** The LLM judge varies by about 2.5 points; small categories of 8 to 16 questions swing 13 to 25 points on a single judgment. Treat gaps under 3 points between systems as noise.
- **Leaderboards are not directly comparable.** Scores are self-reported across different answer-model backends with no independent verification, and the highest come from heavier retrieval orchestration. None of those systems publish a security or trust model.
- **The benchmarks do not score what this engine is for.** Refusal-first safety, encryption at rest, tamper-evident audit, provenance, and calibration are the half of the system with no QA leaderboard, and that is where the strong numbers above live.

## Quickstart

Demiurge runs as one Docker container exposing an MCP endpoint and a localhost REST adapter on port 3100.

```bash
# 1. Configure
cp .env.example .env
#   DEMIURGE_API_KEY   bearer auth for the REST and MCP surface  (openssl rand -hex 32)
#   DEMIURGE_DB_KEY    encryption-at-rest key, required in prod  (openssl rand -hex 32)
#   OPENAI_API_KEY     answer and judge model (GPT-4.1-mini, GPT-4o-mini)
#   trust-branching consensus defaults to OpenAI + Anthropic + Google;
#   set those provider keys too, or switch to single-provider in .env.

# 2. Run (binds 127.0.0.1:3100 only)
docker compose up -d

# 3. Health check
curl -s localhost:3100/api/v1/health
```

REST, for a write and recall against localhost. Auth is a bearer token:

```bash
# store a claim (adjudicated by the write pipeline)
curl -s localhost:3100/api/v1/memory \
  -H "authorization: Bearer $DEMIURGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"user_id":"me","claim":"I prefer TypeScript"}'

# recall
curl -s localhost:3100/api/v1/memory/search \
  -H "authorization: Bearer $DEMIURGE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"user_id":"me","query":"what language do I prefer"}'
```

The MCP server is exposed by the same container. Point your MCP client at the container endpoint with the same bearer token. See `docs/` for the client config block.

## Status

The core engine is built and running in production on the hardware described above. The deduplication recency-exception noted under product correctness is the active engine item. Answer-model routing exists in the codebase but is off by default; the product runs one model on every query, which is exactly what these benchmarks measure.

License: MIT.
