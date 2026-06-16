import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  hkdfSync,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { VaultProvider, KeySource, SecretRef, VaultContext, CallerIdentity } from './types.js';

/**
 * File-backed default vault impl.
 *
 * Storage: JSONL at `${vaultFilePath}`. One record per encrypted secret.
 * Each record carries an algorithm tag so future migrations land as new
 * envelope versions without touching call sites.
 *
 * Crypto envelope (v1): hybrid ML-KEM-768 + AES-256-GCM.
 *   - Per-secret 32-byte symmetric key drawn from `randomBytes(32)`.
 *   - That key is encapsulated against the vault's ML-KEM-768 public key.
 *   - The plaintext secret is encrypted with AES-256-GCM under the key.
 *   - Record = { ref, alg, kemCt, iv, ct, tag, ctx, createdAt }.
 *
 * ML-KEM requires Node 24.7+ (OpenSSL 3.5 via node:crypto). On older
 * runtimes the encrypt/decrypt path falls back to a non-PQC envelope
 * (AES-256-GCM only) keyed via HKDF off the vault seed. This is marked
 * in the `alg` field so audits can detect the fallback.
 *
 * Cloud-LLM callers are refused unconditionally regardless of envelope.
 */

const ALG_PQC = 'ml-kem-768+aes-256-gcm-v1';
const ALG_FALLBACK = 'aes-256-gcm-v1';

interface VaultRecord {
  ref: SecretRef;
  alg: string;
  kemCt?: string; // base64 KEM ciphertext (PQC envelope only)
  iv: string; // base64
  ct: string; // base64
  tag: string; // base64
  createdAt: string; // ISO timestamp
  tombstoned?: boolean;
}

interface PqcCrypto {
  generateKeyPair(): { publicKey: Buffer; privateKey: Buffer };
  encapsulate(publicKey: Buffer): { sharedKey: Buffer; ciphertext: Buffer };
  decapsulate(privateKey: Buffer, ciphertext: Buffer): Buffer;
}

export class DefaultLocalVault implements VaultProvider {
  readonly providerName = 'default-local';
  private readonly index = new Map<SecretRef, VaultRecord>();
  private loaded = false;
  private pqc: PqcCrypto | null | undefined; // undefined = not probed, null = unavailable
  private vaultKeypair: { publicKey: Buffer; privateKey: Buffer } | null = null;

  constructor(
    private readonly keySource: KeySource,
    private readonly vaultFilePath: string,
  ) {}

  async encrypt(plaintext: string, _context: VaultContext): Promise<SecretRef> {
    this.ensureLoaded();
    const ref: SecretRef = `vault:${this.providerName}:${uuid()}`;
    const pqc = await this.tryPqc();
    const iv = randomBytes(12);
    const symmetricKey = randomBytes(32);
    const cipher = createCipheriv('aes-256-gcm', symmetricKey, iv) as CipherGCM;
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    let alg: string;
    let kemCt: Buffer;
    if (pqc) {
      const { publicKey } = this.getVaultKeypair(pqc);
      const enc = pqc.encapsulate(publicKey);
      // The encapsulated shared key replaces the random symmetricKey only if
      // we want the KEM to BE the symmetric. v1 spec: KEM-encapsulate the
      // random AES key by AES-256-GCM-wrapping it with the KEM shared key.
      const wrapIv = randomBytes(12);
      const wrap = createCipheriv('aes-256-gcm', enc.sharedKey.subarray(0, 32), wrapIv) as CipherGCM;
      const wrappedKey = Buffer.concat([wrap.update(symmetricKey), wrap.final()]);
      const wrapTag = wrap.getAuthTag();
      kemCt = Buffer.concat([
        Buffer.from([wrapIv.length]),
        wrapIv,
        Buffer.from([wrapTag.length]),
        wrapTag,
        Buffer.from([(wrappedKey.length >> 8) & 0xff, wrappedKey.length & 0xff]),
        wrappedKey,
        enc.ciphertext,
      ]);
      alg = ALG_PQC;
    } else {
      // Fallback: HKDF-derive a per-secret KEK from the vault seed + iv,
      // wrap the symmetric key under it. Documented in alg = aes-256-gcm-v1.
      const seed = this.keySource.getKey('vault');
      const kek = Buffer.from(hkdfSync('sha256', seed, iv, Buffer.from('demiurge-vault-kek-v1'), 32));
      const wrapIv = randomBytes(12);
      const wrap = createCipheriv('aes-256-gcm', kek, wrapIv) as CipherGCM;
      const wrappedKey = Buffer.concat([wrap.update(symmetricKey), wrap.final()]);
      const wrapTag = wrap.getAuthTag();
      kemCt = Buffer.concat([
        Buffer.from([wrapIv.length]),
        wrapIv,
        Buffer.from([wrapTag.length]),
        wrapTag,
        Buffer.from([(wrappedKey.length >> 8) & 0xff, wrappedKey.length & 0xff]),
        wrappedKey,
      ]);
      alg = ALG_FALLBACK;
    }

    const record: VaultRecord = {
      ref,
      alg,
      kemCt: kemCt.toString('base64'),
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
      createdAt: new Date().toISOString(),
    };
    this.appendRecord(record);
    return ref;
  }

  async decrypt(ref: SecretRef, caller: CallerIdentity): Promise<string | null> {
    if (caller.callerType === 'cloud-llm') {
      // Refused unconditionally. The audit emission happens at the caller
      // (so it carries materializer/inject context); the vault just says no.
      return null;
    }
    this.ensureLoaded();
    const record = this.index.get(ref);
    if (!record || record.tombstoned) return null;

    const iv = Buffer.from(record.iv, 'base64');
    const ct = Buffer.from(record.ct, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    const kemCt = record.kemCt ? Buffer.from(record.kemCt, 'base64') : null;
    if (!kemCt) return null;

    let symmetricKey: Buffer;
    if (record.alg === ALG_PQC) {
      const pqc = await this.tryPqc();
      if (!pqc) {
        throw new Error(
          `DefaultLocalVault: record ${ref} requires PQC envelope ${ALG_PQC} but ` +
            `node:crypto KEM is unavailable on this runtime (need Node >=24.7).`,
        );
      }
      const { privateKey } = this.getVaultKeypair(pqc);
      const parsed = parseKemEnvelope(kemCt, true);
      const shared = pqc.decapsulate(privateKey, parsed.kemBody!);
      symmetricKey = unwrapKey(shared.subarray(0, 32), parsed);
    } else if (record.alg === ALG_FALLBACK) {
      const seed = this.keySource.getKey('vault');
      const kek = Buffer.from(hkdfSync('sha256', seed, iv, Buffer.from('demiurge-vault-kek-v1'), 32));
      const parsed = parseKemEnvelope(kemCt, false);
      symmetricKey = unwrapKey(kek, parsed);
    } else {
      throw new Error(`DefaultLocalVault: unknown envelope algorithm ${record.alg}`);
    }

    const decipher = createDecipheriv('aes-256-gcm', symmetricKey, iv) as DecipherGCM;
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  async exists(ref: SecretRef): Promise<boolean> {
    this.ensureLoaded();
    const r = this.index.get(ref);
    return Boolean(r && !r.tombstoned);
  }

  async delete(ref: SecretRef, _caller: CallerIdentity): Promise<void> {
    this.ensureLoaded();
    const r = this.index.get(ref);
    if (!r) return;
    const tombstone: VaultRecord = { ...r, tombstoned: true };
    this.index.set(ref, tombstone);
    this.appendRecord(tombstone);
  }

  /** Test/utility hook: reset the in-memory state. Does NOT touch disk. */
  resetCache(): void {
    this.index.clear();
    this.loaded = false;
    this.pqc = undefined;
    this.vaultKeypair = null;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    mkdirSync(dirname(this.vaultFilePath), { recursive: true });
    if (existsSync(this.vaultFilePath)) {
      const raw = readFileSync(this.vaultFilePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as VaultRecord;
          this.index.set(r.ref, r);
        } catch {
          // ignore corrupt line; the next clean append will succeed
        }
      }
    }
    this.loaded = true;
  }

  private appendRecord(record: VaultRecord): void {
    this.index.set(record.ref, record);
    appendFileSync(this.vaultFilePath, JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  /**
   * Lazy probe for ML-KEM in node:crypto. Resolves to a wrapper that
   * exposes generate/encapsulate/decapsulate, or null when unavailable.
   * Probe runs at most once per vault instance.
   */
  private async tryPqc(): Promise<PqcCrypto | null> {
    if (this.pqc !== undefined) return this.pqc;
    try {
      const mod: Record<string, unknown> = await import('node:crypto');
      // Node 24.7+ exposes `crypto.encapsulate` / `crypto.decapsulate` and
      // `crypto.generateKeyPairSync('ml-kem-768')`. The exact surface may
      // still be settling, probe defensively.
      const encapsulate = mod.encapsulate as ((pub: Buffer) => { sharedKey: Buffer; ciphertext: Buffer }) | undefined;
      const decapsulate = mod.decapsulate as ((priv: Buffer, ct: Buffer) => Buffer) | undefined;
      const generateKeyPairSync = mod.generateKeyPairSync as
        | ((type: string, options?: unknown) => { publicKey: unknown; privateKey: unknown })
        | undefined;
      if (!encapsulate || !decapsulate || !generateKeyPairSync) {
        this.pqc = null;
        return null;
      }
      // Smoke-test the API shape without burning the engine if it throws.
      let testPair: { publicKey: Buffer; privateKey: Buffer };
      try {
        const raw = generateKeyPairSync('ml-kem-768');
        testPair = {
          publicKey: extractKeyBuffer(raw.publicKey),
          privateKey: extractKeyBuffer(raw.privateKey),
        };
      } catch {
        this.pqc = null;
        return null;
      }
      this.pqc = {
        generateKeyPair: () => {
          const raw = generateKeyPairSync('ml-kem-768');
          return {
            publicKey: extractKeyBuffer(raw.publicKey),
            privateKey: extractKeyBuffer(raw.privateKey),
          };
        },
        encapsulate: (pub: Buffer) => encapsulate(pub),
        decapsulate: (priv: Buffer, ct: Buffer) => decapsulate(priv, ct),
      };
      // Use the smoke-test pair as the engine's vault keypair so we
      // don't re-derive on first encrypt.
      this.vaultKeypair = testPair;
    } catch {
      this.pqc = null;
    }
    return this.pqc;
  }

  private getVaultKeypair(pqc: PqcCrypto): { publicKey: Buffer; privateKey: Buffer } {
    if (this.vaultKeypair) return this.vaultKeypair;
    // Persist the keypair alongside the JSONL file, encrypted under a KEK
    // HKDF-derived from the vault seed. Engine restarts decrypt and reuse.
    const keypairPath = `${this.vaultFilePath}.keypair`;
    const seed = this.keySource.getKey('vault');
    const kek = Buffer.from(
      hkdfSync('sha256', seed, Buffer.from('vault-keypair-salt'), Buffer.from('demiurge-vault-keypair-v1'), 32),
    );
    if (existsSync(keypairPath)) {
      const blob = JSON.parse(readFileSync(keypairPath, 'utf8')) as {
        iv: string;
        tag: string;
        ct: string;
      };
      const iv = Buffer.from(blob.iv, 'base64');
      const tag = Buffer.from(blob.tag, 'base64');
      const ct = Buffer.from(blob.ct, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', kek, iv) as DecipherGCM;
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      const payload = JSON.parse(pt.toString('utf8')) as { publicKey: string; privateKey: string };
      this.vaultKeypair = {
        publicKey: Buffer.from(payload.publicKey, 'base64'),
        privateKey: Buffer.from(payload.privateKey, 'base64'),
      };
      return this.vaultKeypair;
    }
    const pair = pqc.generateKeyPair();
    const payload = JSON.stringify({
      publicKey: pair.publicKey.toString('base64'),
      privateKey: pair.privateKey.toString('base64'),
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv) as CipherGCM;
    const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeFileSync(
      keypairPath,
      JSON.stringify({ iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') }),
      { mode: 0o600 },
    );
    this.vaultKeypair = pair;
    return pair;
  }
}

interface ParsedEnvelope {
  wrapIv: Buffer;
  wrapTag: Buffer;
  wrappedKey: Buffer;
  kemBody?: Buffer;
}

function parseKemEnvelope(buf: Buffer, hasKemBody: boolean): ParsedEnvelope {
  let off = 0;
  const ivLen = buf.readUInt8(off);
  off += 1;
  const wrapIv = buf.subarray(off, off + ivLen);
  off += ivLen;
  const tagLen = buf.readUInt8(off);
  off += 1;
  const wrapTag = buf.subarray(off, off + tagLen);
  off += tagLen;
  const wkLen = buf.readUInt16BE(off);
  off += 2;
  const wrappedKey = buf.subarray(off, off + wkLen);
  off += wkLen;
  const out: ParsedEnvelope = { wrapIv, wrapTag, wrappedKey };
  if (hasKemBody) out.kemBody = buf.subarray(off);
  return out;
}

function unwrapKey(kek: Buffer, parsed: ParsedEnvelope): Buffer {
  const wrap = createDecipheriv('aes-256-gcm', kek, parsed.wrapIv) as DecipherGCM;
  wrap.setAuthTag(parsed.wrapTag);
  return Buffer.concat([wrap.update(parsed.wrappedKey), wrap.final()]);
}

function extractKeyBuffer(key: unknown): Buffer {
  // node:crypto returns a KeyObject for asymmetric keys. Export raw bytes
  // when supported; otherwise SPKI/PKCS8 DER, which we accept as-is.
  if (typeof key === 'object' && key !== null) {
    const ko = key as { export?: (opts?: unknown) => unknown };
    if (typeof ko.export === 'function') {
      try {
        const raw = ko.export({ format: 'raw' });
        if (Buffer.isBuffer(raw)) return raw;
        if (raw instanceof Uint8Array) return Buffer.from(raw);
      } catch {
        // raw export not supported for this key type; fall through to DER
      }
      try {
        const der = ko.export({ format: 'der', type: 'spki' });
        if (Buffer.isBuffer(der)) return der;
        if (der instanceof Uint8Array) return Buffer.from(der);
      } catch {
        // ignore; final fallback below
      }
    }
  }
  if (Buffer.isBuffer(key)) return key;
  if (key instanceof Uint8Array) return Buffer.from(key);
  throw new Error('DefaultLocalVault: unable to extract raw key bytes from node:crypto KeyObject');
}

// Re-exported for testability without leaking internals more broadly.
export const __testing = { ALG_PQC, ALG_FALLBACK, parseKemEnvelope, unwrapKey };

// Silence unused-import warning when createHash isn't reached on some paths.
void createHash;
