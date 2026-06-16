/**
 * W4.6 recovery manifest serialization.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 4.1.
 *
 * The manifest is the cleartext-after-decryption metadata carried inside an
 * encrypted recovery bundle. It lets an operator confirm which host a bundle
 * belongs to and verify, without restoring, that the keys on a live host are
 * the same keys that were bundled at install time (via SHA-256 fingerprints).
 *
 * The manifest never contains key material. Fingerprints are one-way hashes,
 * useful for integrity checks but not for reconstructing a key.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The three master key identifiers, in canonical order. */
export const KEY_NAMES = ['db', 'vault', 'audit'] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/** SHA-256 fingerprint of each master key, as lowercase hex. */
export type KeyFingerprints = Record<KeyName, string>;

/**
 * Cleartext metadata embedded in a recovery bundle. Version 1 layout.
 * Bumping {@link RecoveryManifest.version} signals a bundle-format migration.
 */
export interface RecoveryManifest {
  /** Manifest schema version. Increment on breaking layout changes. */
  version: number;
  /** ISO-8601 timestamp the bundle was written. */
  installed_at: string;
  /** Host the bundle was generated on (best-effort; may be 'unknown'). */
  hostname: string;
  /** Engine version that wrote the bundle. */
  engine_version: string;
  /** SHA-256 of each master key, for integrity verification without restore. */
  key_fingerprints: KeyFingerprints;
  /** Free-form operator notes, optionally filled in at install time. */
  client_notes?: string;
}

/** SHA-256 of a buffer as lowercase hex. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Compute the fingerprint set for a map of raw key buffers. */
export function fingerprintKeys(keys: Record<KeyName, Buffer>): KeyFingerprints {
  return {
    db: sha256(keys.db),
    vault: sha256(keys.vault),
    audit: sha256(keys.audit),
  };
}

/**
 * Best-effort engine version lookup. Walks up from this module to find the
 * nearest package.json, then falls back to the DEMIURGE_ENGINE_VERSION env
 * var, then to 'unknown'. Never throws.
 */
export function getEngineVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const up of ['..', '../..', '../../..', '../../../..']) {
      const candidate = join(here, up, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
        if (typeof pkg.version === 'string') return pkg.version;
      }
    }
  } catch {
    // fall through to env / unknown
  }
  return process.env.DEMIURGE_ENGINE_VERSION ?? 'unknown';
}

/** Build a fresh manifest for the given keys. */
export function buildManifest(keys: Record<KeyName, Buffer>, opts: { clientNotes?: string } = {}): RecoveryManifest {
  const manifest: RecoveryManifest = {
    version: 1,
    installed_at: new Date().toISOString(),
    hostname: process.env.HOSTNAME ?? 'unknown',
    engine_version: getEngineVersion(),
    key_fingerprints: fingerprintKeys(keys),
  };
  if (opts.clientNotes) manifest.client_notes = opts.clientNotes;
  return manifest;
}
