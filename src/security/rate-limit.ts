/**
 * Wedge 1.5 Phase 3: per-user, per-action-class token bucket.
 *
 * In-memory only, NOT durable across process restarts. Intentional for the
 * current single-process deployment. A distributed deployment would need a
 * shared store (Redis/etc).
 *
 * Enforcement runs regardless of TELEMETRY_ENABLED. The rate limiter is a
 * security control, not telemetry. It only emits rate_limit_events when
 * telemetry is enabled, but bucket math + allow/deny decisions are always
 * computed.
 */

import { randomUUID } from 'node:crypto';
import { getStorage } from '../telemetry/storage.js';
import { getActiveTraceId } from '../telemetry/trace.js';
import type { RateLimitEvent } from '../telemetry/types.js';

export type ActionClass = 'read' | 'write' | 'ingest';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

interface BucketSettings {
  perMinute: number;
  capacity: number;
}

const DEFAULTS: Record<ActionClass, number> = {
  read: 60,
  write: 30,
  ingest: 5,
};

const buckets = new Map<string, BucketState>();

function settingsFor(action: ActionClass): BucketSettings {
  let perMinute = DEFAULTS[action];
  const envName =
    action === 'read'
      ? 'RATE_LIMIT_READ_PER_MIN'
      : action === 'write'
        ? 'RATE_LIMIT_WRITE_PER_MIN'
        : 'RATE_LIMIT_INGEST_PER_MIN';
  const raw = process.env[envName];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      perMinute = parsed;
    }
  }
  return { perMinute, capacity: perMinute * 2 };
}

function refill(state: BucketState, settings: BucketSettings, nowMs: number): void {
  const elapsedMs = nowMs - state.lastRefillMs;
  if (elapsedMs <= 0) return;
  const added = (elapsedMs / 60_000) * settings.perMinute;
  state.tokens = Math.min(settings.capacity, state.tokens + added);
  state.lastRefillMs = nowMs;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

function emitEvent(
  user_id: string,
  endpoint: string | undefined,
  action: 'allowed' | 'throttled' | 'blocked',
  remaining: number,
  capacity: number,
): void {
  const storage = getStorage();
  if (!storage || !storage.isEnabled()) return;
  const ev: RateLimitEvent = {
    rl_id: randomUUID(),
    trace_id: getActiveTraceId(),
    user_id,
    endpoint,
    action,
    current_count: Math.max(0, Math.floor(capacity - remaining)),
    limit_value: capacity,
    created_at: new Date().toISOString(),
  };
  storage.enqueue({ kind: 'rate_limit_event', payload: ev });
}

export function checkRateLimit(
  user_id: string,
  action: ActionClass,
  opts: { endpoint?: string } = {},
): RateLimitDecision {
  const settings = settingsFor(action);
  const key = `${user_id}:${action}`;
  const now = Date.now();
  let state = buckets.get(key);
  if (!state) {
    state = { tokens: settings.capacity, lastRefillMs: now };
    buckets.set(key, state);
  }
  refill(state, settings, now);

  if (state.tokens >= 1) {
    state.tokens -= 1;
    const remaining = Math.floor(state.tokens);
    emitEvent(user_id, opts.endpoint, 'allowed', remaining, settings.capacity);
    return { allowed: true, remaining, retry_after_seconds: 0 };
  }

  const needed = 1 - state.tokens;
  const retry_after_seconds = Math.max(1, Math.ceil((needed / settings.perMinute) * 60));
  emitEvent(user_id, opts.endpoint, 'throttled', 0, settings.capacity);
  return { allowed: false, remaining: 0, retry_after_seconds };
}

/** Test-only: clear all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
  authFailureBuckets.clear();
}

// --- S84: principal-keyed buckets ---

export interface RateLimitPrincipal {
  userId: string;
  viaClientToken: boolean;
}

/**
 * S84: bucket key for the resolved principal (brain #3531/#3519). Client-token
 * traffic gets a per-user bucket (`client:<userId>`); shared-key traffic pools
 * in `shared:<userId>` ('system'). Distinct prefixes so a client token whose
 * userId is 'system' can never collide with the shared key's bucket. The
 * cooperative x-user-id header no longer keys anything: pre-S84 it defaulted
 * every header-less caller (master-key drivers AND gated connectors) into one
 * 'anonymous' bucket, and they starved each other.
 */
export function limiterKeyFor(principal: RateLimitPrincipal | undefined): string {
  if (!principal) return 'anonymous';
  return principal.viaClientToken ? `client:${principal.userId}` : `shared:${principal.userId}`;
}

// --- A10: per-IP failed-auth throttle ---
//
// The main rate limiter is keyed on the resolved principal and runs AFTER auth
// (preHandler hook). That doesn't help against brute force: a hostile
// caller with no valid Bearer never gets past onRequest, so the
// preHandler bucket never sees them. The fix is a separate, stricter
// bucket keyed on the source IP that ticks DOWN on every auth failure.
// When the bucket runs out, the IP is blocked for `lockoutSeconds`.
//
// In-memory only; the buckets are pruned lazily as entries age out.
// Tunables (with defaults):
//   AUTH_FAIL_PER_MIN      , max failed auth attempts per IP per minute (default 10)
//   AUTH_FAIL_LOCKOUT_SEC  , seconds to deny once the bucket is empty (default 60)

interface AuthFailureState {
  count: number;
  windowStartMs: number;
  lockedUntilMs: number;
}

const authFailureBuckets = new Map<string, AuthFailureState>();

function authFailureSettings(): { perMinute: number; lockoutMs: number } {
  const perMinute = (() => {
    const raw = process.env.AUTH_FAIL_PER_MIN;
    if (!raw) return 10;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 10;
  })();
  const lockoutSec = (() => {
    const raw = process.env.AUTH_FAIL_LOCKOUT_SEC;
    if (!raw) return 60;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 60;
  })();
  return { perMinute, lockoutMs: lockoutSec * 1000 };
}

export interface AuthFailureDecision {
  allowed: boolean;
  retry_after_seconds: number;
  locked: boolean;
}

/**
 * Returns whether this IP is currently allowed to attempt auth. Call
 * this BEFORE running the constant-time bearer compare so a bad actor
 * can't keep hammering the verifier.
 */
export function checkAuthFailureBucket(ip: string): AuthFailureDecision {
  const now = Date.now();
  const state = authFailureBuckets.get(ip);
  if (!state) return { allowed: true, retry_after_seconds: 0, locked: false };
  if (state.lockedUntilMs > now) {
    return {
      allowed: false,
      retry_after_seconds: Math.max(1, Math.ceil((state.lockedUntilMs - now) / 1000)),
      locked: true,
    };
  }
  // Lockout expired; clear so the next failure starts a fresh window.
  if (state.lockedUntilMs !== 0 && state.lockedUntilMs <= now) {
    authFailureBuckets.delete(ip);
  }
  // Sliding 1-minute window, reset count if older than 60s.
  if (now - state.windowStartMs > 60_000) {
    state.count = 0;
    state.windowStartMs = now;
  }
  return { allowed: true, retry_after_seconds: 0, locked: false };
}

/**
 * Record a failed auth attempt from this IP. Returns the post-increment
 * decision so the caller can decide whether to respond 401 (still
 * allowed to try) or 429 (now locked out).
 */
export function recordAuthFailure(ip: string): AuthFailureDecision {
  const { perMinute, lockoutMs } = authFailureSettings();
  const now = Date.now();
  let state = authFailureBuckets.get(ip);
  if (!state) {
    state = { count: 0, windowStartMs: now, lockedUntilMs: 0 };
    authFailureBuckets.set(ip, state);
  }
  if (now - state.windowStartMs > 60_000) {
    state.count = 0;
    state.windowStartMs = now;
    state.lockedUntilMs = 0;
  }
  state.count += 1;
  if (state.count >= perMinute) {
    state.lockedUntilMs = now + lockoutMs;
    return {
      allowed: false,
      retry_after_seconds: Math.ceil(lockoutMs / 1000),
      locked: true,
    };
  }
  return { allowed: true, retry_after_seconds: 0, locked: false };
}

/** Test-only: clear the auth-failure bucket map. */
export function resetAuthFailureBuckets(): void {
  authFailureBuckets.clear();
}

/**
 * Classify an HTTP request into an action class.
 * Rules in order:
 *   - path includes '/ingest' or '/extract' → 'ingest'
 *   - method ∈ POST/PUT/DELETE/PATCH → 'write'
 *   - otherwise → 'read'
 */
export function classifyAction(method: string, path: string): ActionClass {
  if (path.includes('/ingest') || path.includes('/extract')) return 'ingest';
  const m = method.toUpperCase();
  if (m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH') return 'write';
  return 'read';
}
