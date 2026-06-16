/**
 * W4.6 encrypted recovery bundle read/write.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 4.1.
 *
 * A recovery bundle holds the three master keys plus a {@link RecoveryManifest},
 * encrypted under a passphrase-derived key. It is the artifact an operator
 * stores off-host (USB stick, password manager export, separate disk) so a
 * destroyed host can be rebuilt with the same keys.
 *
 * Crypto: scrypt(passphrase, N=2^17, r=8, p=1) derives a 32-byte key, used
 * with AES-256-GCM over a JSON payload of { manifest, keys (base64) }. PQC is
 * intentionally NOT used here: scrypt at OWASP parameters is the right
 * primitive for passphrase-derived keys, and an attacker who holds both the
 * bundle and the passphrase has already won regardless of quantum.
 *
 * File layout (self-identifying via the magic prefix):
 *   bytes  0..7   magic "DEMIBUN1"  (the trailing digit is the format version)
 *   bytes  8..23  scrypt salt       (16 bytes)
 *   bytes 24..35  GCM iv            (12 bytes)
 *   bytes 36..51  GCM auth tag      (16 bytes)
 *   bytes 52..     ciphertext       (AES-256-GCM of the JSON payload)
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt, type ScryptOptions } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_NAMES, buildManifest, type KeyName, type RecoveryManifest } from './manifest.js';

/** Promise wrapper around scrypt that carries the options overload. */
function scryptAsync(passphrase: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Magic prefix; the trailing "1" is the bundle format version. */
export const BUNDLE_MAGIC = Buffer.from('DEMIBUN1', 'utf8');
export const SALT_LEN = 16;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const DERIVED_KEY_LEN = 32;
const HEADER_LEN = BUNDLE_MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;

/** scrypt parameters. N=2^17 per OWASP guidance for interactive use. */
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

/** Minimum acceptable passphrase length, enforced by the CLI before we get here. */
export const MIN_PASSPHRASE_LEN = 12;

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return (await scryptAsync(passphrase, salt, DERIVED_KEY_LEN, SCRYPT_PARAMS)) as Buffer;
}

/** Decrypted bundle contents: the manifest plus the raw master key buffers. */
export interface RecoveryBundleContents {
  manifest: RecoveryManifest;
  keys: Record<KeyName, Buffer>;
}

export interface WriteBundleOpts {
  /** Directory holding db.key / vault.key / audit.key. */
  keyDir: string;
  /** Destination path for the encrypted bundle. */
  bundlePath: string;
  /** Operator recovery passphrase. */
  passphrase: string;
  /** Optional free-form notes embedded in the manifest. */
  clientNotes?: string;
}

export interface WriteBundleResult {
  bytes: number;
  manifest: RecoveryManifest;
}

function readMasterKeys(keyDir: string): Record<KeyName, Buffer> {
  const keys = {} as Record<KeyName, Buffer>;
  for (const name of KEY_NAMES) {
    keys[name] = readFileSync(join(keyDir, `${name}.key`));
  }
  return keys;
}

/**
 * Read the three master keys from {@link WriteBundleOpts.keyDir}, build a
 * manifest, encrypt, and write a `.demiurge-recovery` bundle at 0600.
 */
export async function writeRecoveryBundle(opts: WriteBundleOpts): Promise<WriteBundleResult> {
  const keys = readMasterKeys(opts.keyDir);
  const manifest = buildManifest(keys, opts.clientNotes ? { clientNotes: opts.clientNotes } : {});

  const payload = JSON.stringify({
    manifest,
    keys: {
      db: keys.db.toString('base64'),
      vault: keys.vault.toString('base64'),
      audit: keys.audit.toString('base64'),
    },
  });

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const derived = await deriveKey(opts.passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const bundle = Buffer.concat([BUNDLE_MAGIC, salt, iv, tag, ciphertext]);
  writeFileSync(opts.bundlePath, bundle, { mode: 0o600 });

  return { bytes: bundle.length, manifest };
}

export interface ReadBundleOpts {
  bundlePath: string;
  passphrase: string;
}

export class BundleFormatError extends Error {}
export class BundleDecryptError extends Error {}

/**
 * Read and decrypt a recovery bundle. Throws {@link BundleFormatError} on a
 * malformed file and {@link BundleDecryptError} on a wrong passphrase or
 * tampered ciphertext (the GCM auth tag fails to verify).
 */
export async function readRecoveryBundle(opts: ReadBundleOpts): Promise<RecoveryBundleContents> {
  const bundle = readFileSync(opts.bundlePath);
  if (bundle.length < HEADER_LEN || !bundle.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
    throw new BundleFormatError(`Not a Demiurge recovery bundle (bad magic) at ${opts.bundlePath}.`);
  }

  let offset = BUNDLE_MAGIC.length;
  const salt = bundle.subarray(offset, (offset += SALT_LEN));
  const iv = bundle.subarray(offset, (offset += IV_LEN));
  const tag = bundle.subarray(offset, (offset += TAG_LEN));
  const ciphertext = bundle.subarray(offset);

  const derived = await deriveKey(opts.passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', derived, iv);
  decipher.setAuthTag(tag);

  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new BundleDecryptError('Decryption failed. Wrong passphrase or corrupted bundle.');
  }

  const parsed = JSON.parse(plaintext) as {
    manifest: RecoveryManifest;
    keys: Record<KeyName, string>;
  };

  const keys = {} as Record<KeyName, Buffer>;
  for (const name of KEY_NAMES) {
    keys[name] = Buffer.from(parsed.keys[name], 'base64');
  }

  return { manifest: parsed.manifest, keys };
}
