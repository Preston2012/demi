/**
 * Product scorecard, abstention resolution (S78, spec §4, §5 view 7).
 *
 * `abstained` is filled one of two ways (generalizing the prototype):
 *  - SHADOW: from an abstention-gate log (`abstention_gate` JSON lines, field
 *    `wouldAbstain`, matched by the 80-char `q` prefix the gate logs). This is
 *    how the gate's effect is simulated before it ships live.
 *  - LIVE: detect the canonical decline string in `predicted`. The committed
 *    archive carries `predicted` text, so this gives a real abstention read
 *    with no gate log at all.
 *
 * After abstention is set, `wrong` is recomputed (a declined answer is not a
 * hallucination).
 */

import { readFileSync } from 'node:fs';
import type { NormalizedRecord } from './types.js';
import { recomputeWrong } from './normalize.js';

/** Canonical decline phrasings the engine emits when it refuses to answer. Kept
 *  deliberately conservative, a false "abstained" would understate wrong_rate,
 *  so only unambiguous refusals match. */
const DECLINE_PATTERNS: RegExp[] = [
  /\bI (don't|do not|cannot|can't|am not able to|am unable to)\b.*\b(have|find|provide|answer|determine|know)\b/i,
  /\bno (information|info|record|mention|data)\b.*\b(available|provided|found|about|regarding)\b/i,
  /\bthere is no (information|mention|record|data)\b/i,
  /\b(insufficient|not enough) (information|context|data)\b/i,
  /\bunable to (answer|determine|find)\b/i,
  /^(?:I'm|I am) not sure\.?$/i,
  /\bcannot be (answered|determined) (from|with|based on)\b/i,
];

export function looksLikeDecline(predicted: string | null): boolean {
  if (!predicted) return false;
  return DECLINE_PATTERNS.some((re) => re.test(predicted));
}

export type AbstentionSource = 'gate-log' | 'decline-detection' | 'none';

export interface AbstentionApplyResult {
  source: AbstentionSource;
  /** records with no gate verdict matched (gate-log mode only). */
  no_verdict: number;
  /** records whose abstained flag was set true. */
  abstained_total: number;
}

interface GateVerdict {
  wouldAbstain: boolean;
}

/** Parse an abstention-gate log into a prefix → verdict map (prototype logic). */
export function loadGateVerdicts(logPath: string): Map<string, GateVerdict> {
  const verdicts = new Map<string, GateVerdict>();
  let text: string;
  try {
    text = readFileSync(logPath, 'utf-8');
  } catch {
    return verdicts;
  }
  for (const line of text.split('\n')) {
    const i = line.indexOf('{"tag":"abstention_gate"');
    if (i < 0) continue;
    try {
      const d = JSON.parse(line.slice(i)) as { q?: string; wouldAbstain?: boolean };
      if (typeof d.q === 'string') verdicts.set(d.q, { wouldAbstain: d.wouldAbstain === true });
    } catch {
      // skip malformed line
    }
  }
  return verdicts;
}

function matchVerdict(question: string, verdicts: Map<string, GateVerdict>): GateVerdict | null {
  const key = question.slice(0, 80);
  const direct = verdicts.get(key);
  if (direct) return direct;
  const prefix60 = question.slice(0, 60);
  for (const [k, v] of verdicts) {
    if (question.startsWith(k) || k.startsWith(prefix60)) return v;
  }
  return null;
}

export interface AbstentionApplyOptions {
  /** Path to an abstention-gate log (shadow mode). */
  gateLog?: string;
  /** Force decline-string detection even if a gate log is given. */
  useDeclineDetection?: boolean;
}

/**
 * Set `abstained` on every record and recompute `wrong`. Prefers the gate log
 * when supplied; otherwise falls back to decline detection on `predicted`.
 * Returns which source was used and how many questions lacked a verdict.
 */
export function applyAbstention(records: NormalizedRecord[], opts: AbstentionApplyOptions = {}): AbstentionApplyResult {
  let source: AbstentionSource = 'none';
  let noVerdict = 0;
  let abstainedTotal = 0;

  const verdicts = opts.gateLog && !opts.useDeclineDetection ? loadGateVerdicts(opts.gateLog) : null;
  if (verdicts && verdicts.size > 0) source = 'decline-detection'; // overwritten below if used

  for (const r of records) {
    let abstained = false;
    if (verdicts && verdicts.size > 0) {
      source = 'gate-log';
      const v = matchVerdict(r.question, verdicts);
      if (v === null) noVerdict++;
      else abstained = v.wouldAbstain;
    } else {
      source = 'decline-detection';
      abstained = looksLikeDecline(r.predicted);
    }
    r.abstained = abstained;
    if (abstained) abstainedTotal++;
    recomputeWrong(r);
  }

  if (records.length === 0) source = 'none';
  return { source, no_verdict: noVerdict, abstained_total: abstainedTotal };
}
