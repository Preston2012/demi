# DialSim adapter, scaffold (S48)

**Status: NOT WIRED. Skeleton only.**

## What DialSim is

Long-term multi-party dialogue benchmark from Kim et al. 2024 (arXiv:2406.13144).
Three TV-show subsets: Friends, Big Bang Theory, The Office.
v1.1 (Oct 2025) added unanswerable multi-hop questions.

- ~1,300 sessions per show, average 350K tokens total context per show
- Random character, random Q from ~1,000 candidate pool, asked at a random time during dialogue
- 6-second time-constrained eval (evaluates speed AND accuracy)
- F1 score against gold answers
- Refusal-first signal: agent must distinguish known/unknown info

## Why we want it

- Multi-party + temporal + refusal-first all in one bench
- Real product surface: a companion app inhabiting an evolving cast of characters
- Cited in LongMemEval (ICLR 2025), MemoryBench, AMemGym, EvolMem, meaningful adoption
- Time-constrained eval is a Demiurge strength (47ms mean / 109ms p95 vs 6-sec budget)

## Wiring plan

1. **Data fetch**, official repo `github.com/jiho283/Simulator`. v1.1 dataset on Google Drive (link in repo README). Per-show JSON or HF dataset (MemoryBench Oct 2025 paper says they "adopt the official v1.1 version"). Estimated ~1-3 GB total.

2. **Fixture parser** (`fetch-dialsim-fixture.py`), convert per-show dialogue files to `PublicBenchFixture`:
   - Each session = one PublicBenchScenario with `scenario_id = 'friends_s01e01'` etc.
   - Each dialogue turn = one PublicBenchFact (`{claim: "Joey: ...", validFrom: timestamp, meta: {character, scene}}`)
   - Each candidate Q = one PublicBenchQuery (`{qid, question, expected, meta: {asked_at, asker, category}}`)
   - The "random Q at random time" is an eval-time concern; the fixture stores ALL candidates and the runner picks at eval-time

3. **Runner** (`runner.ts`), extends shared scaffold:
   - For each session: seed dialogue-turns sequentially with sequential validFrom (per-fact pattern from MAB)
   - For each query: time-bound the dispatch.search + answer call to 6 sec, abort + score 0 if exceeded
   - Judge: F1 lowercase token-overlap (similar to MAB's substring match but more lenient)
   - Per-show + overall scores, plus mean/p95 latency reported

4. **Mini definition**: 1 episode per show, all candidate questions for that episode (~50 Q each = ~150 total)
   Full: all sessions per show (~5,000 Q total, heavy)

## Dependencies

- HF dataset access OR Google Drive download for v1.1
- ~3-4 hr total wiring estimate (per brain memory #1876)
- Should run on CAX21 (more RAM for 350K-token contexts)

## Why deferred

S48 closes with two product wins shipped (per-fact MAB +11pp / refined CloneMem prompt). DialSim wiring is a multi-hour build, not a 2-min change. Better to ship S48 wins clean, then dedicate a focused session to DialSim.
