# Demiurge product scorecard

A READ-ONLY reporting + anti-regression overlay over the committed benchmark
result JSONs in `benchmark-archive/`. It never changes how a bench scores or
what the engine does (spec §8). Generalizes the single-slice prototype
`scripts/hallucination-scorecard.py` to every bench, one unified cross-bench
taxonomy, a measured variance layer, and an unskippable gate.

Spec: `docs/internal/SCORECARD_CC_PACKET.md` (§1–14).

## Run it

```bash
# BROAD + DEEP report (latest run per bench/tier, "current state")
npm run scorecard -- --results benchmark-archive

# add the §13 variance report and the CloneMem counterfactual verdict
npm run scorecard -- --results benchmark-archive --variance --counterfactual

# machine-readable
npm run scorecard -- --results benchmark-archive --json

# write all deliverables (SCORECARD.md, VARIANCE.md, scorecard.json) to scorecard/
npm run scorecard:analyze

# anti-regression gate against a committed baseline (exit 1 on regression)
npm run scorecard:gate -- --baseline scorecard/baselines/<date>-<commit>.json
```

Flags (spec §7): `--results`, `--bench`, `--commit`, `--correct-threshold`,
`--gate-log`, `--all-runs`, `--variance`, `--counterfactual`, `--cell bench:cellKey`,
`--json`, `--compare <baseline>`, `--no-cache`.

## How it works

```
loader → normalize → fingerprint → taxonomy(classify) → abstention
                                                       ├─ metrics → render (BROAD/DEEP)
                                                       ├─ variance → per-cell sigma, drift, needs-repeats
                                                       └─ analysis → real-or-noise cell verdicts
baseline ←(host rebaseline)─ variance        gate ← baseline + fresh records
```

- **loader.ts**, globs the archive (incl. `cax21/`), classifies each file to a
  bench, resolves commit/Q-tier/config/manifest. Skips amb (aggregate-only) and
  recall (cluster-shaped) with a surfaced reason (spec §9).
- **normalize.ts**, one adapter per bench shape → the common `NormalizedRecord`
  (handles the locomo `*_time_ms` rename, beam `nugget_score >= threshold`,
  `should_abstain` derivation, explicit `null` for absent fields).
- **taxonomy.ts**, fills one consistent `query_type_unified` via the engine's
  `classifyQuery()` (cached by classifier content-hash), preserves the recorded
  `query_type` as a cross-check, emits a divergence report. The recorded label
  is present on only some runs of beam/locomo/lme, so classifying every question
  is what makes the cross-run time series coherent.
- **fingerprint.ts**, the "same config" key for variance grouping: model pins +
  flag set (`manifest.env_config_hash` or hashed config) + fixture + commit +
  Q-tier. Group-by-commit alone is wrong (spec §13.4).
- **metrics.ts**, BROAD (per bench, per bench×category) + DEEP (unified
  query_type, temporal/multi-hop/single-hop/hallucination/abstention drills,
  clonemem question_type) + product targets, evaluated per-bench so an
  adversarial bench never masks the real read.
- **variance.ts**, per-cell sigma from same-config repeats, time series + drift
  slope, the "needs repeats" gap list. Empirical sigma is reported; the gate
  applies a binomial-SE floor (spec §13.5) so small/near-floor cells don't
  over-fire.
- **analysis.ts**, the anti-hand-wave verdict engine: for any cell, measure the
  same-config noise floor and call a move real, noise, sigma-unknown, or
  noise-floor-too-high. Never asserts; always measures.
- **baseline.ts / gate.ts**, the §14.5 baseline (single source of truth) and the
  unskippable gate (`observed < mean − K·σ`, K_overall=3, per-cell with binomial
  floor; no SKIP/--force/--no-verify; baseline read-only to the gate).

## Honesty contract ("IK rules")

Every number is measured, never guessed. "Within variance" is never asserted
without a sigma behind it. n<3 → "sigma unknown", listed for repeats, not a
fabricated band. Reporting decisions (correct-threshold, K, the sample-stdev and
binomial-SE choices, the asserted locomo category map, the in-tree-vs-`5acffcf`
classifier difference) are stamped in the output. Nothing is tuned to flatter a
result.

## Host-side harness (`scripts/scorecard/host/`)

Runs on CAX11/CAX21 where the engine, gitignored fixtures, and API keys live:

- **rejudge.ts**, judge-only sigma: re-judge frozen archive outputs N≥5× with
  the judge cache off (needs only an API key).
- **rerun-engine.ts**, engine-only sigma: re-run the bench N≥3× against a frozen
  judge (the persistent judge cache).
- **live-gate.ts**, host fresh-run gate (mini routine / full pre-publish).
- **rebaseline.ts**, the ONLY baseline writer; requires `--confirm`, n≥3, and
  excludes unstable (high-σ) configs; writes a new dated file, never overwrites.

## Headline finding (S78, full archive)

The CloneMem counterfactual cell, called a ~19pp regression (95→76) in the
roadmap, is **not a confirmed regression on the measured evidence**: the one
same-config group with n≥3 (commit `c3f8585`, n=4) measures σ≈6pp empirically
(binomial-floored to ≈8pp), the "95%" peak is a single unreplicated run, and the
head value (76.2%) sits inside the measured noise band. The same scan flags
locomo at commit `167bf23` as run-unstable (5 of 6 runs scored 0.0%), and lists
122 (bench, config, Q-tier) groups that need fresh repeats before their sigma is
knowable. See `scorecard/VARIANCE.md`.
