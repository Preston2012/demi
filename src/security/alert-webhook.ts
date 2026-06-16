/**
 * Wedge 1.5 Phase 4: centralized webhook alert emitter.
 *
 * Fired on operational integrity failures: audit chain breakage,
 * rate-limit breach above threshold, insert failure spike, encryption
 * verification failure, tenant isolation failure.
 *
 * Configuration:
 *   WEBHOOK_URL    - target endpoint (POST JSON). If unset, alerts are
 *                    dropped with a warning log line.
 *   WEBHOOK_SECRET - optional HMAC-SHA256 key. When set, every request
 *                    carries X-Demiurge-Signature: sha256=<hex>. Matches
 *                    GitHub webhook signing shape.
 *
 * Retry: 3 attempts with exponential backoff (1s, 2s, 4s). Uses the
 * built-in Node 18+ fetch. Non-2xx and thrown errors both trigger retry.
 */

import { createHmac } from 'node:crypto';

import { createLogger } from '../config.js';

const log = createLogger('alert-webhook');

export type AlertKind =
  | 'audit_chain_failure'
  | 'rate_limit_breach'
  | 'insert_failure'
  | 'encryption_failure'
  | 'tenant_isolation_failure';

export interface AlertPayload {
  severity: 'info' | 'warning' | 'critical';
  [key: string]: unknown;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/** Sleep helper kept exported for tests that want to stub it out. */
export async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * A8: fail-closed validation. If WEBHOOK_URL is set we MUST have a
 * WEBHOOK_SECRET so receivers can verify alerts are authentic, without
 * the HMAC, anyone who learns the URL can post forged alerts. Boot
 * (or a test/CLI entry point) calls this once; throws if the pair is
 * misconfigured.
 *
 * Returns the resolved (url, secret) pair when valid, or `null` when
 * webhooks are intentionally disabled (no URL). Caller can ignore the
 * return value when they only want the validation side effect.
 *
 * `process.env.ALLOW_UNSIGNED_WEBHOOKS=true` is an explicit escape
 * hatch for development / local testing only, it logs a loud warning
 * so accidentally leaving it on is noisy.
 */
export function assertWebhookConfig(): { url: string; secret: string } | null {
  const url = process.env.WEBHOOK_URL;
  if (!url) return null;
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || secret.length === 0) {
    if (process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true') {
      // C-17: the escape hatch is dev-only by contract; enforce it.
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ALLOW_UNSIGNED_WEBHOOKS=true is not permitted when NODE_ENV=production. Set WEBHOOK_SECRET.');
      }
      log.warn(
        'WEBHOOK_URL set without WEBHOOK_SECRET; ALLOW_UNSIGNED_WEBHOOKS=true permits unsigned alerts. ' +
          'Receivers CANNOT verify these alerts are authentic. Do not use in production.',
      );
      return { url, secret: '' };
    }
    throw new Error(
      'WEBHOOK_URL is set but WEBHOOK_SECRET is missing. Receivers cannot verify alerts. ' +
        'Set WEBHOOK_SECRET (recommended) or ALLOW_UNSIGNED_WEBHOOKS=true (dev only).',
    );
  }
  return { url, secret };
}

export interface FireWebhookOptions {
  /** Override the global retry sleep (tests pass a no-op to keep runs fast). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the URL (defaults to WEBHOOK_URL env). */
  url?: string;
  /** Override the secret (defaults to WEBHOOK_SECRET env). */
  secret?: string;
}

export async function fireWebhook(
  kind: AlertKind,
  payload: AlertPayload,
  options: FireWebhookOptions = {},
): Promise<boolean> {
  const url = options.url ?? process.env.WEBHOOK_URL;
  if (!url) {
    log.warn({ kind, payload }, 'WEBHOOK_URL not configured; alert dropped');
    return false;
  }

  const secret = options.secret ?? process.env.WEBHOOK_SECRET;
  const sleep = options.sleep ?? defaultSleep;

  const body = JSON.stringify({
    kind,
    timestamp: new Date().toISOString(),
    host: process.env.HOSTNAME || 'unknown',
    payload,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'demiurge-alert/1.0',
  };

  if (secret) {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Demiurge-Signature'] = `sha256=${sig}`;
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { method: 'POST', headers, body });
      if (resp.ok) {
        log.info({ kind, attempt }, 'webhook delivered');
        return true;
      }
      log.warn({ kind, attempt, status: resp.status }, 'webhook non-2xx, will retry');
    } catch (err) {
      log.warn({ kind, attempt, err: err instanceof Error ? err.message : String(err) }, 'webhook threw, will retry');
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }

  log.error({ kind, payload }, 'webhook failed after all retries');
  return false;
}
