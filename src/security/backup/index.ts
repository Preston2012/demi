/**
 * W4.6 backup surface public exports + provider binding.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 5.
 *
 * Mirrors the vault binding pattern (src/security/vault/index.ts): a single
 * provider is bound for the lifetime of the process and retrieved through the
 * accessor. The conjunction gate (flag AND bound provider) keeps call sites
 * from invoking an unbound provider.
 */

import type { BackupProvider } from './types.js';

let _provider: BackupProvider | null = null;

/** Bind the backup provider for the lifetime of the engine process. */
export function bindBackupProvider(provider: BackupProvider): void {
  _provider = provider;
}

/** Test/teardown hook: unbinds the singleton. */
export function resetBackupProvider(): void {
  _provider = null;
}

/** Retrieve the bound provider, throwing if none has been bound. */
export function backupProvider(): BackupProvider {
  if (!_provider) {
    throw new Error('Backup provider not bound. Call bindBackupProvider() during boot.');
  }
  return _provider;
}

/** True when a provider has been bound. */
export function isBackupBound(): boolean {
  return _provider !== null;
}

export { LocalBackupProvider, BackupRestoreError, BACKUP_MAGIC } from './local-backup.js';
export type {
  BackupProvider,
  BackupDestination,
  BackupOpts,
  BackupResult,
  BackupBundleRef,
  RestoreOpts,
  RestoreResult,
  BackupListing,
} from './types.js';
