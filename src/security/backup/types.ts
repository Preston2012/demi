/**
 * W4.6 backup surface interface contracts.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 5.1.
 *
 * A {@link BackupProvider} produces and consumes encrypted backup bundles of
 * all engine state. Bundles are opaque without the recovery passphrase, so a
 * bundle is safe to write anywhere (S3, R2, Backblaze, iCloud, USB stick).
 * The default {@link LocalBackupProvider} writes to a local path; the operator
 * transports it off-host with their own tooling (rclone, rsync). The engine
 * therefore never holds backup-destination credentials.
 */

/** Where a backup is written. v1 implements 'local'; others are operator-side. */
export type BackupDestination = 'local' | 's3' | 'r2' | 'backblaze' | 'icloud' | 'custom';

export interface BackupProvider {
  /** Stable identifier for the provider implementation, e.g. 'local'. */
  readonly providerName: string;

  /**
   * Produce an encrypted backup bundle of all engine state. The bundle is
   * opaque without the recovery passphrase, so it is safe to write anywhere
   * (S3, R2, Backblaze, iCloud, USB stick).
   */
  createBackup(opts: BackupOpts): Promise<BackupResult>;

  /** Restore from a bundle. Requires the recovery passphrase. */
  restoreBackup(bundle: BackupBundleRef, opts: RestoreOpts): Promise<RestoreResult>;

  /**
   * List existing backups at the destination, with metadata, without
   * decrypting them.
   */
  listBackups(): Promise<BackupListing[]>;
}

export interface BackupOpts {
  /** Destination class. v1 LocalBackupProvider only honors 'local'. */
  destination: BackupDestination;
  /** Provider-specific destination configuration (bucket, path, etc). */
  destinationConfig: Record<string, unknown>;
  /** Include the hash-chained audit DB in the bundle. */
  includeAuditLog: boolean;
  /** Include the telemetry DB in the bundle. */
  includeTelemetry: boolean;
}

export interface BackupResult {
  /** Opaque reference to the written bundle (a path for LocalBackupProvider). */
  bundleRef: string;
  /** Total size of the encrypted bundle on disk. */
  sizeBytes: number;
  /** ISO-8601 timestamp the bundle was created. */
  createdAt: string;
  /** SHA-256 of the encrypted bundle file, as lowercase hex. */
  fingerprint: string;
}

/** Reference to an existing bundle. For LocalBackupProvider this is a path. */
export type BackupBundleRef = string;

export interface RestoreOpts {
  /** Where to restore engine state to. Defaults to the provider's dataDir. */
  targetDataDir?: string;
  /** Overwrite a non-empty target without first moving it aside. */
  force?: boolean;
}

export interface RestoreResult {
  /** Directory the bundle was restored into. */
  restoredTo: string;
  /** Whether the GCM auth tag verified (a wrong passphrase throws before this). */
  verified: boolean;
  /** If existing data was moved aside rather than overwritten, where it went. */
  previousDataMovedTo?: string;
}

export interface BackupListing {
  /** Opaque reference (a path for LocalBackupProvider). */
  bundleRef: string;
  /** Encrypted bundle size on disk. */
  sizeBytes: number;
  /** ISO-8601 creation time (parsed from the bundle filename when possible). */
  createdAt: string;
  /** SHA-256 of the encrypted bundle file, as lowercase hex. */
  fingerprint: string;
}
