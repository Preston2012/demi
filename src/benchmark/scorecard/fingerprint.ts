/**
 * Product scorecard, config fingerprint (S78, spec §13.4).
 *
 * Variance grouping pools runs ONLY when their config is identical. Grouping by
 * commit alone is explicitly wrong: golden-config was not always enforced, so
 * two runs at the same commit can carry different flags. The fingerprint
 * combines the model pins, the flag set, the fixture version, the commit, and
 * the Q-tier into one stable hash that is the group key for sigma.
 *
 * Flag-set identity:
 *  - beam/locomo/lme carry a manifest with `env_config_hash`, a ready-made
 *    sha256 over the tracked flag set (ANSWER_ROUTING, max_rules, classifier
 *    commit, cli_flags, ...). Use it directly.
 *  - clonemem/mab/dialsim have no manifest; hash the behavioral fields of the
 *    `config` block (everything except the model pins and the size/scope tokens
 *    that are already captured by answer_model/judge_model and the Q-tier).
 */

import { createHash } from 'node:crypto';
import type { BenchFile, ConfigFingerprint } from './types.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** config keys captured elsewhere in the fingerprint, excluded from the
 *  fallback flag hash so they are not double-counted (and so a size token does
 *  not leak into the flag identity). */
const CONFIG_KEYS_CAPTURED_ELSEWHERE = new Set(['answerModel', 'judgeModel', 'mode', 'tier', 'size', 'mini']);

function readStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

/** Stable hash of the behavioral config fields for a manifest-less bench. Keys
 *  are sorted so field order in the JSON cannot change the hash. */
function fallbackFlagHash(config: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(config).sort()) {
    if (CONFIG_KEYS_CAPTURED_ELSEWHERE.has(k)) continue;
    canonical[k] = config[k];
  }
  return 'cfg:' + sha256(JSON.stringify(canonical));
}

/** Golden = the production config: default answer/judge models and routing and
 *  reranker both off. Only golden runs feed the product scorecard, so an
 *  experiment (reranker/routing/model A/B) can never become the product number. */
function isGolden(file: BenchFile): boolean {
  const answer =
    readStr(file.config, 'answerModel') ??
    (typeof file.manifest?.model_pins?.answer === 'string' ? file.manifest.model_pins.answer : null);
  const judge =
    readStr(file.config, 'judgeModel') ??
    (typeof file.manifest?.model_pins?.judge === 'string' ? file.manifest.model_pins.judge : null);
  if (answer && answer !== 'gpt-4.1-mini') return false;
  if (judge && judge !== 'gpt-4o-mini') return false;
  const inp = (file.manifest?.env_config_inputs ?? {}) as Record<string, unknown>;
  const cfg = (file.config ?? {}) as Record<string, unknown>;
  const routing = String(inp.ANSWER_ROUTING ?? cfg.ANSWER_ROUTING ?? 'false');
  const reranker = String(inp.RERANKER_ENABLED ?? cfg.RERANKER_ENABLED ?? 'false');
  if (routing === 'true') return false;
  if (reranker === 'true') return false;
  return true;
}

/** Compute the config fingerprint for one loaded file. */
export function fingerprint(file: BenchFile): ConfigFingerprint {
  const answer_model =
    readStr(file.config, 'answerModel') ??
    (typeof file.manifest?.model_pins?.answer === 'string' ? file.manifest.model_pins.answer : null);
  const judge_model =
    readStr(file.config, 'judgeModel') ??
    (typeof file.manifest?.model_pins?.judge === 'string' ? file.manifest.model_pins.judge : null);

  const flag_hash =
    typeof file.manifest?.env_config_hash === 'string'
      ? 'env:' + file.manifest.env_config_hash
      : fallbackFlagHash(file.config);

  const fixture_version =
    (typeof file.manifest?.fixture_version === 'string' ? file.manifest.fixture_version : null) ?? file.upstream;

  const ident = {
    bench: file.bench,
    answer_model,
    judge_model,
    flag_hash,
    fixture_version,
    commit: file.commit,
    qtier: file.qtier,
  };
  const hash = sha256(JSON.stringify(ident));

  return { ...ident, hash, is_golden: isGolden(file) };
}

/** Group loaded files by their config-fingerprint hash. */
export function groupFilesByFingerprint(files: BenchFile[]): Map<string, BenchFile[]> {
  const groups = new Map<string, BenchFile[]>();
  for (const f of files) {
    const fp = fingerprint(f);
    const arr = groups.get(fp.hash);
    if (arr) arr.push(f);
    else groups.set(fp.hash, [f]);
  }
  return groups;
}
