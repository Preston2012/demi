import type { KeySource, KeyId } from './types.js';

const ENV_VAR_BY_KEY: Record<KeyId, string> = {
  db: 'DEMIURGE_DB_KEY',
  vault: 'DEMIURGE_VAULT_KEY',
  audit: 'DEMIURGE_AUDIT_KEY',
};

const REQUIRED_KEY_BYTES = 32;

/**
 * KeySource backed by hex-encoded environment variables.
 *
 * Bridges the S50 `DEMIURGE_DB_KEY` env path into the W4.5 KeySource
 * abstraction. Useful for benchmark/CI runs where /etc/demiurge/keys/
 * is not provisioned and tests want to feed keys via the harness.
 *
 * Each env var must hold a 64-character lowercase hex string (32 bytes).
 */
export class EnvKeySource implements KeySource {
  readonly sourceName = 'env';
  private readonly cache = new Map<KeyId, Buffer>();

  getKey(keyId: KeyId): Buffer {
    const cached = this.cache.get(keyId);
    if (cached) return cached;
    const varName = ENV_VAR_BY_KEY[keyId];
    const hex = process.env[varName];
    if (!hex) {
      throw new Error(
        `EnvKeySource: ${varName} is not set. Set it to a 64-char hex string ` +
          `(or switch VAULT_KEY_SOURCE=file and run scripts/install-vault.sh).`,
      );
    }
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== REQUIRED_KEY_BYTES) {
      throw new Error(
        `EnvKeySource: ${varName} must decode to ${REQUIRED_KEY_BYTES} bytes ` +
          `(64 hex chars); got ${buf.length} bytes from ${hex.length} chars.`,
      );
    }
    this.cache.set(keyId, buf);
    return buf;
  }
}
