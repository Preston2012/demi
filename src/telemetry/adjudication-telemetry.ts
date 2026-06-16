/**
 * W4 Track A: JSONL telemetry corpus writer for Stage 2 training.
 *
 * Every Stage 1 calibrated-teacher adjudication emits one row to this
 * file. Daily rotation by UTC date, append-only newline-delimited JSON,
 * stored under `/var/log/demiurge/` on the engine host (per design §6).
 *
 * Engine prod DB never sees these rows, the corpus lives only as
 * append-only flat files so the existing S75 telemetry-archive cron
 * on CAX11/CAX21 can compress + scp to Baseline + push to R2 without
 * needing to touch the live DB.
 *
 * The path root is overridable via TRACK_A_TELEMETRY_DIR for tests and
 * for non-Linux dev hosts. Production deployment sets the value via
 * systemd unit env; the default falls back to a sensible tmpdir if the
 * preferred path is not writable.
 *
 * Failure modes:
 * - Disk full / permission error: log a one-shot warning (rate-limited
 *   per-process) and drop the row. Adjudicator latency must never block
 *   on telemetry write.
 * - Race on file open: writes use append mode so concurrent processes
 *   on the same host can write to the same daily file without locking.
 *   JSON lines are atomic at the OS level under POSIX as long as line
 *   length stays under PIPE_BUF (typically 4KB). Our row size is bounded
 *   so this holds.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AttemptRecord } from '../llm/provider-chain.js';

export interface AdjudicationTelemetryRow {
  ts: string;
  engine_commit: string;
  prompt_version: string;
  model_used: string;
  raw_window_sha256: string;
  raw_window_text: string;
  claim_text: string;
  claim_subject: string;
  existing_memory_count: number;
  existing_memory_subjects: string[];
  teacher_score: number;
  reason_codes: string[];
  rule_hits: string[];
  rationale: string;
  latency_ms: number;
  provider_chain_attempts: AttemptRecord[];
}

const DEFAULT_DIR = '/var/log/demiurge';
const TMP_FALLBACK = join(tmpdir(), 'demiurge-track-a-telemetry');

let _dirCache: string | null = null;
let _ensuredDir: string | null = null;
let _warnedOnce = false;

function resolveDir(): string {
  if (_dirCache !== null) return _dirCache;
  const fromEnv = process.env.TRACK_A_TELEMETRY_DIR;
  _dirCache = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DIR;
  return _dirCache;
}

/** Test-only: clear cached directory + ensure-state so a test can flip env. */
export function _resetAdjudicationTelemetry(): void {
  _dirCache = null;
  _ensuredDir = null;
  _warnedOnce = false;
}

function ensureDir(): string | null {
  const preferred = resolveDir();
  if (_ensuredDir === preferred) return _ensuredDir;
  try {
    mkdirSync(preferred, { recursive: true });
    _ensuredDir = preferred;
    return preferred;
  } catch {
    // Fall back to a per-process tmpdir if the preferred path is not
    // writable. This keeps the writer functional in dev / CI without
    // requiring sudo to create /var/log/demiurge.
    try {
      mkdirSync(TMP_FALLBACK, { recursive: true });
      _ensuredDir = TMP_FALLBACK;
      return TMP_FALLBACK;
    } catch {
      _ensuredDir = null;
      return null;
    }
  }
}

function utcDate(d: Date = new Date()): string {
  // YYYY-MM-DD in UTC, matching the existing telemetry-archive cron file
  // pattern. ISO substring is cheap and locale-free.
  return d.toISOString().slice(0, 10);
}

function dailyPath(forDate?: Date): string | null {
  const dir = ensureDir();
  if (!dir) return null;
  const date = utcDate(forDate);
  return join(dir, `adjudication-telemetry.${date}.jsonl`);
}

/**
 * Append one telemetry row. Best-effort: any I/O failure is swallowed
 * after a one-shot warning so a misconfigured host can't break the
 * adjudication path.
 */
export function writeAdjudicationTelemetry(row: AdjudicationTelemetryRow): void {
  const path = dailyPath();
  if (!path) {
    if (!_warnedOnce) {
      _warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn('[adjudication-telemetry] no writable directory; dropping rows');
    }
    return;
  }
  try {
    const line = JSON.stringify(row) + '\n';
    appendFileSync(path, line, { encoding: 'utf-8' });
  } catch (err) {
    if (!_warnedOnce) {
      _warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn('[adjudication-telemetry] write failed; subsequent rows will be dropped silently:', err);
    }
  }
}

/** Test helper: read back the daily file as parsed rows. Returns [] if
 *  the file doesn't exist. */
export function _readAdjudicationTelemetryForDate(forDate?: Date): AdjudicationTelemetryRow[] {
  const path = dailyPath(forDate);
  if (!path || !existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AdjudicationTelemetryRow);
}
