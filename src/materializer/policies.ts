/**
 * Wedge 3: materialization policy registry.
 *
 * Policies are named, versioned objects bundling prompt + model + params.
 * Retirement is non-destructive: sets retired_at on the policy row and
 * cascades stale_at to every dependent materializations row so cache reads
 * trigger re-projection on next access.
 *
 * Two default policies are seeded at engine init when MATERIALIZER_ENABLED:
 *   - 'default'              -> EXTRACTION_PROMPT (single-speaker)
 *   - 'default-multispeaker' -> MULTI_SPEAKER_EXTRACTION_PROMPT
 *
 * dispatch.ingest resolves which one to use from opts.multiSpeaker. Two
 * seed rows so the 'policy = versioned object' contract holds; if we ever
 * add a third extraction prompt it becomes a third policy_id rather than
 * a hidden runtime branch.
 */

import type Database from 'better-sqlite3-multiple-ciphers';

import {
  DEFAULT_EXTRACTION_PROMPT_VERSION,
  EXTRACTION_PROMPT,
  MULTI_SPEAKER_EXTRACTION_PROMPT,
  MULTI_SPEAKER_PROMPT_VERSION,
  defaultExtractionModel,
} from '../extract/index.js';

import type { MaterializationPolicy } from './types.js';

export const DEFAULT_POLICY_ID = 'default';
export const DEFAULT_MULTISPEAKER_POLICY_ID = 'default-multispeaker';

interface PolicyRow {
  policy_id: string;
  version: number;
  prompt_template: string;
  model_id: string;
  params: string | null;
  created_at: string;
  retired_at: string | null;
}

function rowToPolicy(row: PolicyRow): MaterializationPolicy {
  return {
    policyId: row.policy_id,
    version: row.version,
    promptTemplate: row.prompt_template,
    modelId: row.model_id,
    params: row.params ? (JSON.parse(row.params) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

export function loadPolicy(db: Database.Database, policyId: string): MaterializationPolicy | null {
  const row = db
    .prepare(
      'SELECT policy_id, version, prompt_template, model_id, params, created_at, retired_at FROM materialization_policies WHERE policy_id = ?',
    )
    .get(policyId) as PolicyRow | undefined;
  return row ? rowToPolicy(row) : null;
}

/**
 * Seed the two default policies if they don't already exist. Idempotent:
 * re-running is a no-op because we INSERT OR IGNORE on policy_id PK.
 *
 * Note: model_id is captured from defaultExtractionModel() at seed time and
 * is fixed for the life of that policy_id. To change the model, retire the
 * policy and seed a new policy_id -- do NOT mutate in place. This preserves
 * the "policy is a versioned object" contract.
 */
export function seedDefaultPolicies(db: Database.Database): void {
  const now = new Date().toISOString();
  const model = defaultExtractionModel();

  const insert = db.prepare(
    'INSERT OR IGNORE INTO materialization_policies (policy_id, version, prompt_template, model_id, params, created_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  );

  insert.run(
    DEFAULT_POLICY_ID,
    1,
    EXTRACTION_PROMPT,
    model,
    JSON.stringify({ promptVersion: DEFAULT_EXTRACTION_PROMPT_VERSION, temperature: 0, maxTokens: 1500 }),
    now,
  );
  insert.run(
    DEFAULT_MULTISPEAKER_POLICY_ID,
    1,
    MULTI_SPEAKER_EXTRACTION_PROMPT,
    model,
    JSON.stringify({ promptVersion: MULTI_SPEAKER_PROMPT_VERSION, temperature: 0, maxTokens: 1500 }),
    now,
  );
}

/**
 * Retire a policy. Sets retired_at on the policy row and stale_at on every
 * dependent materializations row (rows whose stale_at is still NULL). After
 * retirement, cache reads against any of those rows treat them as misses
 * and re-project under whichever policy the caller now selects.
 *
 * Wrapped in a single transaction so a partial failure can't leave the
 * registry in a torn state (policy retired but cache rows still fresh).
 */
export function retirePolicy(db: Database.Database, policyId: string): void {
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare('UPDATE materialization_policies SET retired_at = ? WHERE policy_id = ? AND retired_at IS NULL').run(
      now,
      policyId,
    );
    db.prepare('UPDATE materializations SET stale_at = ? WHERE policy_id = ? AND stale_at IS NULL').run(now, policyId);
  });
  txn();
}
