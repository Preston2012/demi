# Demiurge: Supplementary Addendum
## Paper Supplement + Business Strategy | V2 | 2026-04-15
## All decisions council-locked (R26, 4/4 models)

---

## A. Security Controls Mapping to SOC 2 Trust Services Criteria

Mapping Demiurge's existing architecture to SOC 2 Type II Trust Service Criteria. This is a gap analysis for early security review by startup and SMB buyers evaluating self-hosted deployments. It is not a SOC 2 report, SOC 2 certification, or substitute for formal audit. Formal SOC 2 Type II audit targeted post-revenue via AICPA firm.

For self-hosted deployments, the customer's existing SOC 2 covers infrastructure. This mapping covers application-layer security controls only.

### A.1 Security (CC Series)

| SOC 2 Criterion | Demiurge Implementation | Status |
|-----------------|------------------------|--------|
| CC6.1: Logical access controls | AUTH_TOKEN required for all MCP/REST endpoints. Per-source rate limiting. | Implemented |
| CC6.2: System boundary protection | Single Docker container. REST binds localhost only. MCP requires token. | Implemented |
| CC6.3: Input validation | Deterministic validators: format, content quality, injection detection, unicode normalization. | Implemented |
| CC6.6: Threat management | 9-category poisoning test suite. Trust branching classifies every write. | Implemented |
| CC6.7: Identity verification | Source-based provenance (user, llm, import). Trust class per memory. | Implemented |
| CC7.1: Detection of anomalies | Spot-check sampling (10% of auto-stored). Conflict detection at write + inject. | Implemented |
| CC7.2: Incident response | Hash-chained audit log with HMAC snapshots. Tamper detection. | Implemented |
| CC8.1: Change management | Golden config verification script (12 checks). Diff against locked commits before changes. | Implemented |

### A.2 Availability (A Series)

| SOC 2 Criterion | Demiurge Implementation | Status |
|-----------------|------------------------|--------|
| A1.1: Processing capacity | Retrieval p95 <100ms. Zero LLM calls in read path. ARM-viable. | Implemented |
| A1.2: Recovery | WAL mode for crash recovery. Periodic HMAC-signed snapshots. Backup scripts. | Implemented |

### A.3 Processing Integrity (PI Series)

| SOC 2 Criterion | Demiurge Implementation | Status |
|-----------------|------------------------|--------|
| PI1.1: Accuracy and completeness | Dual-phrasing extraction (2.2x coverage). Semantic dedup at inject (Jaccard 0.82). | Implemented |
| PI1.2: System processing | Deterministic retrieval pipeline. Zero LLM calls in read path. Reproducible via golden-config. | Implemented |
| PI1.4: Error handling | Quarantine path for ambiguous writes. Consensus escalation for conflicts. | Implemented |

### A.4 Confidentiality (C Series)

| SOC 2 Criterion | Demiurge Implementation | Status |
|-----------------|------------------------|--------|
| C1.1: Identification of confidential data | Provenance tracking per memory. Trust class labeling. | Implemented |
| C1.2: Confidential data disposal | Soft delete with audit trail. 30-day circuit breaker (inactivity lock). | Implemented |

### A.5 Privacy (P Series)

| SOC 2 Criterion | Demiurge Implementation | Status |
|-----------------|------------------------|--------|
| P1.1: Privacy notice | Self-hosted: user controls all data. No telemetry. No external data transmission except API calls to configured LLM providers. | Implemented (privacy notice text embedded in Docker image and README) |
| P4.1: Disposal | User controls data lifecycle. Export-all capability via MCP tool. | Implemented |
| P6.1: Quality | Conflict surfacing at injection. Contradictions flagged, not silently resolved. | Implemented |

### A.6 Gaps (Not Yet Addressed)

- CC6.8: Encryption at rest (SQLCipher drop-in, V2 roadmap)
- CC9.1: Vendor management (LLM provider dependency for consensus/answer)
- A1.3: Disaster recovery testing (backup exists, automated restore not tested)
- Multi-tenant isolation (V2 roadmap)
- Formal penetration testing
- Vulnerability disclosure policy
- SBOM / dependency scanning

---

## B. Clean-LOCOMO (Deferred)

Analysis complete: 88 candidate annotation issues categorized (57 GT/evaluation issues, 20 retrieval misses, 11 system errors). Data file: benchmark-results/clean-locomo-categorized.json. Publication deferred pending private validation with LOCOMO benchmark authors. Not included in paper or public materials until author review is complete.

---

## C. FRAME: Fair Retrieval Assessment for Memory Evaluation

### C.1 Problem Statement

Current memory system evaluations conflate retrieval quality with answer model capability. Published leaderboard rankings compare systems using different answer models ($0.40/M to $10/M), different judges, and undisclosed configurations. This makes it impossible to determine whether score differences reflect architectural innovation or spending differences.

### C.2 Proposed Minimum Reporting Standard

Any memory system evaluation claiming benchmark results should report:

1. **Answer model**: exact model name, version, and per-token cost
2. **Judge model**: exact model name, version, temperature, prompt (released verbatim)
3. **Retrieval-only ablation**: score with a fixed, common answer model to isolate retrieval quality
4. **Cost per evaluation**: total API spend for the reported run
5. **Hardware**: CPU/GPU, RAM, whether retrieval is local or cloud
6. **Answer model sensitivity**: score with at least one alternative answer model to demonstrate sensitivity bounds
7. **Dataset version**: hash or version identifier for exact reproducibility
8. **Retrieval parameters**: top-k, context budget, retrieval output schema
9. **Run variance**: scores across multiple seeds or runs, with confidence intervals where feasible

The baseline answer model should be fixed and public, with explicit version and cost. The rule is not to anchor to one model forever, but to ensure the baseline is named, versioned, and costed.

### C.3 Deliverable

Open evaluation harness: a script that takes any memory system's retrieval output (ranked list of memories per query) and runs it through a standardized answer + judge pipeline. Same model, same prompt, same judge for every system. This isolates retrieval quality from everything downstream.

---

## E. Product Roadmap (V1 through V3)

### V1 (Current: Build)
- [x] Refusal-first write pipeline (4-branch, consensus escalation)
- [x] Deterministic retrieval (FTS5 + vector, entity expansion)
- [x] Refusal-first injection (conflict surfacing)
- [x] MCP + REST interfaces
- [x] Docker single-container deployment
- [x] Poisoning defense (19/19, 0% FP)
- [x] Answer model routing
- [x] Benchmark harness (LOCOMO, BEAM, LME)
- [x] Security controls mapping (see Addendum Section A)
- [ ] README + Quick Start documentation
- [ ] .env.example with guided setup
- [ ] Architecture diagram

### V2 (Next: Scale + Harden)
- [ ] Multi-tenancy (user isolation, per-tenant memory stores)
- [ ] SQLCipher encryption at rest
- [ ] Automated restore testing (RTO/RPO documented)
- [ ] Web UI dashboard (config, memory browser, conflict viewer)
- [ ] Managed single-tenant deployments (customer cloud)
- [ ] Ecosystem adapters (LangGraph, CrewAI, LlamaIndex, AutoGen, Vercel AI SDK)
- [ ] Temporal relevance boosting
- [ ] Vulnerability disclosure policy + SBOM
- [ ] DPA/BAA templates

### V3 (Future: Govern)
- [ ] Memory governance model (audit dashboard for security teams)
- [ ] Hosted multi-tenant (after V2 hardening complete)
- [ ] Trusted memory mesh (multi-agent memory sharing with provenance chains)
- [ ] Dream Cycle (reflection + consolidation with 3+ months data)
- [ ] Thompson Sampling production mode
- [ ] Procedural memory (workflows, not just facts)
- [ ] OWASP ASI06 compliance report
- [ ] Public poisoning bounty program
- [ ] Formal SOC 2 Type II audit
- [ ] FedRAMP exploration (government path)

---

