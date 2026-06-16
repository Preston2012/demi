/**
 * Wedge 1.5 Phase 2: single auth abstraction with scope.
 *
 * Three token scopes:
 *   - API_KEY:    production read/write endpoints. Required for /api/v1/*
 *   - ADMIN_TOKEN: admin/telemetry endpoints. Optional, only set when admin
 *                  surfaces are enabled (Phase 3).
 *   - BENCH_TOKEN: bench-mode bypass token. Optional, only honored when
 *                  BENCH_MODE=true is set in env.
 *
 * All comparisons are constant-time via crypto.timingSafeEqual.
 *
 * Phase 2 wires API_KEY behavior through this module (replacing the
 * inline check in src/rest/server.ts). ADMIN_TOKEN + BENCH_TOKEN are
 * defined here but not yet referenced by other modules; Phase 3 surfaces
 * them on admin REST routes.
 */

import { timingSafeEqual } from 'node:crypto';

export type AuthScope = 'api' | 'admin' | 'bench';

export interface AuthConfig {
  apiKey: string;
  adminToken?: string;
  benchToken?: string;
  benchModeEnabled: boolean;
}

/** A resolved client token: an opaque token bound to a userId. */
export interface ClientToken {
  token: string;
  userId: string;
}

/** Config for principal resolution: the shared key plus the client registry. */
export interface PrincipalConfig {
  apiKey: string;
  clientTokens?: ClientToken[];
}

/** The identity resolved from a credential. */
export type Principal =
  | { ok: true; userId: string; viaClientToken: boolean }
  | { ok: false; reason: 'missing' | 'invalid' };

/**
 * Verify a Bearer token against the configured token for the requested scope.
 *
 * Returns:
 *   { ok: true } when the token matches the expected scope token
 *   { ok: false, reason } otherwise
 */
export function verifyBearer(
  header: string | undefined,
  scope: AuthScope,
  cfg: AuthConfig,
): { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'wrong_scope' } {
  if (!header) return { ok: false, reason: 'missing' };

  let expected: string | undefined;
  switch (scope) {
    case 'api':
      expected = cfg.apiKey;
      break;
    case 'admin':
      if (!cfg.adminToken) return { ok: false, reason: 'wrong_scope' };
      expected = cfg.adminToken;
      break;
    case 'bench':
      if (!cfg.benchModeEnabled) return { ok: false, reason: 'wrong_scope' };
      if (!cfg.benchToken) return { ok: false, reason: 'wrong_scope' };
      expected = cfg.benchToken;
      break;
  }

  const expectedHeader = `Bearer ${expected}`;
  if (header.length !== expectedHeader.length) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    const match = timingSafeEqual(Buffer.from(header), Buffer.from(expectedHeader));
    return match ? { ok: true } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * Resolve the principal (userId) from a Bearer credential for the 'api' scope.
 * The shared apiKey resolves to 'system' (legacy/admin/ops, unchanged). A client
 * token resolves to its bound userId with viaClientToken=true. Identity comes
 * ONLY from the verified credential, never from request args. All comparisons
 * are constant-time. Admin/bench scopes remain handled by verifyBearer.
 */
export function resolvePrincipal(header: string | undefined, cfg: PrincipalConfig): Principal {
  if (!header) return { ok: false, reason: 'missing' };

  const sharedHeader = `Bearer ${cfg.apiKey}`;
  if (header.length === sharedHeader.length) {
    try {
      if (timingSafeEqual(Buffer.from(header), Buffer.from(sharedHeader))) {
        return { ok: true, userId: 'system', viaClientToken: false };
      }
    } catch {
      // fall through to client tokens
    }
  }

  for (const ct of cfg.clientTokens ?? []) {
    const expected = `Bearer ${ct.token}`;
    if (header.length !== expected.length) continue;
    try {
      if (timingSafeEqual(Buffer.from(header), Buffer.from(expected))) {
        return { ok: true, userId: ct.userId, viaClientToken: true };
      }
    } catch {
      // try the next token
    }
  }

  return { ok: false, reason: 'invalid' };
}
