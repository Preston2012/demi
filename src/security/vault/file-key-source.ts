import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KeySource, KeyId } from './types.js';

const DEFAULT_KEY_DIR = '/etc/demiurge/keys';
const REQUIRED_KEY_BYTES = 32;

/**
 * Default KeySource impl: reads 32-byte raw key files from disk.
 *
 * Layout: `${keyDir}/{db,vault,audit}.key` with 0600 perms.
 * Generated once by `scripts/install-vault.sh` at deploy time.
 *
 * No passphrase. No human interaction. Engine restarts read the file
 * directly and proceed, the zero-friction workflow doctrine.
 */
export class FileKeySource implements KeySource {
  readonly sourceName = 'file';
  private readonly cache = new Map<KeyId, Buffer>();
  private readonly keyDir: string;

  constructor(keyDir?: string) {
    this.keyDir = keyDir ?? process.env.DEMIURGE_KEY_DIR ?? DEFAULT_KEY_DIR;
  }

  getKey(keyId: KeyId): Buffer {
    const cached = this.cache.get(keyId);
    if (cached) return cached;
    const path = join(this.keyDir, `${keyId}.key`);
    if (!existsSync(path)) {
      throw new Error(
        `FileKeySource: key file not found at ${path}. ` +
          `Run scripts/install-vault.sh to generate, or set DEMIURGE_KEY_DIR ` +
          `to point at your keys.`,
      );
    }
    const key = readFileSync(path);
    if (key.length !== REQUIRED_KEY_BYTES) {
      throw new Error(`FileKeySource: ${keyId}.key must be ${REQUIRED_KEY_BYTES} bytes, got ${key.length}`);
    }
    this.cache.set(keyId, key);
    return key;
  }
}
