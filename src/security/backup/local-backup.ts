/**
 * W4.6 default backup provider: local encrypted bundles.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 5.2 - 5.4.
 *
 * Writes an encrypted, compressed tarball of the engine data directory to a
 * local path. The operator pushes the bundle off-host with their own tooling
 * (rclone, rsync), so the engine never holds backup-destination credentials.
 *
 * The DBs are already SQLCipher-encrypted at rest, and the vault JSONL is
 * already PQC-wrapped per entry, so the bundle is doubly opaque. We add a
 * passphrase-derived outer layer anyway so that bundle metadata (filenames,
 * file sizes, config snapshot) is also hidden.
 *
 * Crypto + container, mirroring the recovery bundle approach:
 *   tar(dataDir) -> zstd compress -> AES-256-GCM (scrypt-derived key).
 *
 * File layout (streamed; the auth tag is a trailer because GCM finalizes only
 * after the whole payload is processed):
 *   bytes  0..7    magic "DEMIBAK1"  (trailing digit is the format version)
 *   bytes  8..23   scrypt salt       (16 bytes)
 *   bytes 24..35   GCM iv            (12 bytes)
 *   bytes 36..N-17 ciphertext        (AES-256-GCM of tar+zstd stream)
 *   bytes N-16..N  GCM auth tag      (16 bytes, trailer)
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, type ScryptOptions } from 'node:crypto';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
  BackupBundleRef,
  BackupListing,
  BackupOpts,
  BackupProvider,
  BackupResult,
  RestoreOpts,
  RestoreResult,
} from './types.js';

/** Promise wrapper around scrypt that carries the options overload. */
function scryptAsync(passphrase: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export const BACKUP_MAGIC = Buffer.from('DEMIBAK1', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = BACKUP_MAGIC.length + SALT_LEN + IV_LEN;
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export class BackupRestoreError extends Error {}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return (await scryptAsync(passphrase, salt, 32, SCRYPT_PARAMS)) as Buffer;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function isDirNonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0;
}

export class LocalBackupProvider implements BackupProvider {
  readonly providerName = 'local';

  constructor(
    private readonly dataDir: string,
    private readonly destDir: string,
    private readonly passphrase: string,
  ) {}

  async createBackup(opts: BackupOpts): Promise<BackupResult> {
    mkdirSync(this.destDir, { recursive: true });

    const createdAt = new Date().toISOString();
    const bundlePath = join(this.destDir, `${createdAt.replaceAll(':', '-')}.demiurge-backup`);

    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const derived = await deriveKey(this.passphrase, salt);

    // Header first (magic + salt + iv), then append the streamed ciphertext.
    const header = Buffer.concat([BACKUP_MAGIC, salt, iv]);
    writeFileSync(bundlePath, header, { mode: 0o600 });

    const excludes: string[] = [];
    // Never recurse into the backup destination if it lives under dataDir.
    const destRel = relative(this.dataDir, this.destDir);
    if (destRel && !destRel.startsWith('..')) excludes.push(`--exclude=./${destRel}`);
    if (!opts.includeAuditLog) excludes.push('--exclude=./audit*');
    if (!opts.includeTelemetry) excludes.push('--exclude=./telemetry*');

    const tarProc = spawn('tar', ['-C', this.dataDir, ...excludes, '-cf', '-', '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    const out = createWriteStream(bundlePath, { flags: 'a' });

    await Promise.all([
      pipeline(tarProc.stdout!, createZstdCompress(), cipher, out),
      tarExit(tarProc, 'tar (createBackup)'),
    ]);

    appendFileSync(bundlePath, cipher.getAuthTag());

    return {
      bundleRef: bundlePath,
      sizeBytes: statSync(bundlePath).size,
      createdAt,
      fingerprint: await fileSha256(bundlePath),
    };
  }

  async restoreBackup(bundle: BackupBundleRef, opts: RestoreOpts): Promise<RestoreResult> {
    const size = statSync(bundle).size;
    if (size < HEADER_LEN + TAG_LEN) {
      throw new BackupRestoreError(`Bundle too small to be valid: ${bundle}`);
    }

    const { magic, salt, iv } = readHeader(bundle);
    if (!magic.equals(BACKUP_MAGIC)) {
      throw new BackupRestoreError(`Not a Demiurge backup bundle (bad magic): ${bundle}`);
    }
    const tag = readTag(bundle, size);
    const derived = await deriveKey(this.passphrase, salt);

    const target = opts.targetDataDir ?? this.dataDir;
    mkdirSync(dirname(target), { recursive: true });

    // Stage inside the target's parent so the final rename is atomic (same fs).
    const staging = mkdtempSync(join(dirname(target), '.demiurge-restore-'));
    const tarTmp = `${staging}.tar`;

    try {
      const decipher = createDecipheriv('aes-256-gcm', derived, iv);
      decipher.setAuthTag(tag);

      // Decrypt + decompress to a temp archive first, then extract from that
      // file. Feeding tar via its stdin through a pipeline races the child's
      // exit (ERR_STREAM_PREMATURE_CLOSE under concurrent load); writing to a
      // file removes the child-process stream from the pipeline and with it the
      // race. A wrong passphrase surfaces here as a GCM/zstd decode failure.
      try {
        await pipeline(
          createReadStream(bundle, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
          decipher,
          createZstdDecompress(),
          createWriteStream(tarTmp),
        );
      } catch (err) {
        throw new BackupRestoreError(
          `Restore failed. Wrong passphrase or corrupted bundle (${(err as Error).message}).`,
        );
      }

      try {
        const tarProc = spawn('tar', ['-C', staging, '-xf', tarTmp], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        await tarExit(tarProc, 'tar (restoreBackup)');
      } catch (err) {
        throw new BackupRestoreError(`Restore failed extracting archive (${(err as Error).message}).`);
      }

      let previousDataMovedTo: string | undefined;
      if (isDirNonEmpty(target)) {
        if (opts.force) {
          rmSync(target, { recursive: true, force: true });
        } else {
          previousDataMovedTo = `${target}.pre-restore-${Date.now()}`;
          renameSync(target, previousDataMovedTo);
        }
      } else if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
      }

      renameSync(staging, target);

      const result: RestoreResult = { restoredTo: target, verified: true };
      if (previousDataMovedTo) result.previousDataMovedTo = previousDataMovedTo;
      return result;
    } finally {
      rmSync(tarTmp, { force: true });
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }

  async listBackups(): Promise<BackupListing[]> {
    if (!existsSync(this.destDir)) return [];
    const listings: BackupListing[] = [];
    for (const name of readdirSync(this.destDir)) {
      if (!name.endsWith('.demiurge-backup')) continue;
      const path = join(this.destDir, name);
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      listings.push({
        bundleRef: path,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        fingerprint: await fileSha256(path),
      });
    }
    listings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return listings;
  }
}

function readHeader(path: string): { magic: Buffer; salt: Buffer; iv: Buffer } {
  const buf = Buffer.alloc(HEADER_LEN);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, HEADER_LEN, 0);
  } finally {
    closeSync(fd);
  }
  const magicEnd = BACKUP_MAGIC.length;
  const saltEnd = magicEnd + SALT_LEN;
  const ivEnd = saltEnd + IV_LEN;
  return {
    magic: buf.subarray(0, magicEnd),
    salt: buf.subarray(magicEnd, saltEnd),
    iv: buf.subarray(saltEnd, ivEnd),
  };
}

function readTag(path: string, size: number): Buffer {
  const buf = Buffer.alloc(TAG_LEN);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    closeSync(fd);
  }
  return buf;
}

function tarExit(proc: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
