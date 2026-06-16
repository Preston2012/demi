/**
 * Product scorecard, per-bench normalizers (S78).
 *
 * Each per-question bench has its own result shape (verified against the
 * archive, see the plan's ground-truth table). These adapters fold every
 * shape into one `NormalizedRecord` so the cross-bench DEEP views can pool by a
 * single taxonomy. One function per bench, behind a registry keyed by BenchId.
 *
 * Derivation rules (verified field names):
 *
 *   field           beam            clonemem      locomo            longmemeval  mab            dialsim
 *   correct         nugget>=thr     correct       llm_judge_correct correct      judge_correct  judge_correct
 *   score           nugget_score    null          f1_score          null         null           null
 *   native_category ability         question_type category(int→lbl) question_type competency     null
 *   difficulty      difficulty      null          null              null         null           null
 *   should_abstain  ability==abst.  qt==unansw.   false             false        false          false
 *   retrieval_ms    retrieval_ms    retrieval_ms  retrieval_time_ms retrieval_ms retrieval_ms   retrieval_ms
 *   total_ms        total_ms        total_ms      total_time_ms     total_ms     total_ms       total_ms
 *
 * `wrong` (hallucination) is derived last and depends on `abstained`, which is
 * filled later from the gate log; at normalize time `abstained` is false, so
 * `wrong = !correct && !should_abstain`. Call `recomputeWrong` after applying
 * gate verdicts.
 */

import { createHash } from 'node:crypto';
import type { BenchFile, BenchId, NormalizedRecord, RawRecord } from './types.js';
import { ScorecardError } from './types.js';

// ---- field coercion (RawRecord values are `unknown`) ----

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** LOCOMO numeric category → label. Mapping asserted in the locomo runner's
 *  `methodology` block; stamped as asserted in output (cat 5 is adversarial,
 *  excluded upstream so it should not appear). */
const LOCOMO_CATEGORY: Record<number, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

function recomputeWrong(r: NormalizedRecord): void {
  // Hallucination = gave a confident answer, it was wrong, and the question was
  // answerable. On should_abstain questions a wrong answer is an over-answer
  // counted in the abstention drill, not here.
  r.wrong = !r.abstained && !r.correct && !r.should_abstain;
}

/** Apply the common provenance + taxonomy-placeholder fields shared by every
 *  bench, then let the per-bench adapter fill the rest. */
function base(file: BenchFile, raw: RawRecord, question: string): NormalizedRecord {
  return {
    bench: file.bench,
    source_file: file.filename,
    host: file.host,
    commit: file.commit,
    qtier: file.qtier,
    fingerprint: '', // filled by fingerprint.ts
    run_timestamp: file.timestamp,
    question,
    question_hash: sha256(question),
    native_category: null,
    query_type_recorded: str(raw.query_type),
    query_type_unified: '', // filled by taxonomy.ts
    query_type_diverged: false,
    question_type: null,
    difficulty: null,
    score: null,
    correct: false,
    should_abstain: false,
    abstained: false,
    wrong: false,
    predicted: null,
    expected: null,
    retrieval_ms: num(raw.retrieval_ms),
    total_ms: num(raw.total_ms),
  };
}

export interface NormalizeOptions {
  /** beam nugget_score >= this counts as correct (spec §4, default 0.5). */
  correctThreshold: number;
}

type Adapter = (file: BenchFile, opts: NormalizeOptions) => NormalizedRecord[];

const ADAPTERS: Record<BenchId, Adapter> = {
  beam: (file, opts) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      const score = num(raw.nugget_score);
      const ability = str(raw.ability);
      r.score = score;
      r.correct = score !== null && score >= opts.correctThreshold;
      r.native_category = ability;
      r.difficulty = str(raw.difficulty);
      r.should_abstain = ability === 'abstention';
      r.predicted = str(raw.predicted);
      r.expected = str(raw.expected);
      recomputeWrong(r);
      return r;
    }),

  clonemem: (file) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      const qt = str(raw.question_type);
      r.correct = bool(raw.correct);
      r.native_category = qt;
      r.question_type = qt;
      r.should_abstain = qt === 'unanswerable';
      r.predicted = str(raw.predicted_full) ?? str(raw.predicted_choice);
      r.expected = str(raw.expected_choice);
      recomputeWrong(r);
      return r;
    }),

  locomo: (file) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      const cat = num(raw.category);
      r.correct = bool(raw.llm_judge_correct);
      r.score = num(raw.f1_score);
      r.native_category = cat !== null ? (LOCOMO_CATEGORY[cat] ?? `cat-${cat}`) : null;
      r.predicted = str(raw.predicted_answer);
      r.expected = str(raw.expected_answer);
      // LOCOMO uses *_time_ms; canonicalize.
      r.retrieval_ms = num(raw.retrieval_time_ms);
      r.total_ms = num(raw.total_time_ms);
      recomputeWrong(r);
      return r;
    }),

  longmemeval: (file) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      const qt = str(raw.question_type);
      r.correct = bool(raw.correct);
      r.native_category = qt;
      r.question_type = qt;
      r.predicted = str(raw.predicted);
      r.expected = str(raw.expected);
      recomputeWrong(r);
      return r;
    }),

  mab: (file) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      r.correct = bool(raw.judge_correct);
      r.native_category = str(raw.competency);
      r.predicted = str(raw.predicted);
      const exp = raw.expected_answers;
      r.expected = Array.isArray(exp) ? exp.map((e) => str(e) ?? '').join(' | ') : str(exp);
      recomputeWrong(r);
      return r;
    }),

  dialsim: (file) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      r.correct = bool(raw.judge_correct);
      r.native_category = null;
      r.predicted = str(raw.predicted);
      r.expected = str(raw.expected);
      recomputeWrong(r);
      return r;
    }),

  'ece-brier': (file) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      r.correct = bool(raw.correct);
      // scenario_id is per-question (eb-easy-001…), far too granular to be a
      // category, it would explode the per-category view into hundreds of n=7
      // cells. ece-brier is a calibration side-bench (spec §9); leave its native
      // category null so it shows in the per-bench overall but not per-category.
      r.native_category = null;
      // expectRefusal mirrors should_abstain semantics on this calibration bench.
      r.should_abstain = bool(raw.expectRefusal);
      r.predicted = str(raw.predicted);
      r.expected = str(raw.expected);
      recomputeWrong(r);
      return r;
    }),

  'security-frame-inject': (file) =>
    file.rawResults.map((raw) => {
      const r = base(file, raw, str(raw.question) ?? '');
      // security bench scores `passed` (defended) rather than answer-correct.
      r.correct = bool(raw.passed);
      r.native_category = str(raw.attack_pattern);
      r.predicted = str(raw.predicted);
      recomputeWrong(r);
      return r;
    }),
};

/** Normalize one loaded file into records. */
export function normalize(file: BenchFile, opts: NormalizeOptions): NormalizedRecord[] {
  const adapter = ADAPTERS[file.bench];
  if (!adapter) throw new ScorecardError(`no normalizer registered for bench ${file.bench}`);
  return adapter(file, opts);
}

/** Normalize many files. */
export function normalizeAll(files: BenchFile[], opts: NormalizeOptions): NormalizedRecord[] {
  const out: NormalizedRecord[] = [];
  for (const f of files) out.push(...normalize(f, opts));
  return out;
}

export { recomputeWrong };
