import type { VaultProvider, KeySource, FreeFormSecretDetector } from './types.js';
import { NULL_FREEFORM_DETECTOR } from './freeform-detector.js';

let _vault: VaultProvider | null = null;
let _keySource: KeySource | null = null;
let _freeform: FreeFormSecretDetector = NULL_FREEFORM_DETECTOR;

/**
 * Bind the vault + key source for the lifetime of the engine process.
 *
 * Called once from {@link src/boot.ts} after KeySource resolution and
 * `repo.initialize()`. Does not need the DB handle, the vault writes
 * to JSONL, not SQL.
 */
export function bindVault(provider: VaultProvider, keySource: KeySource, freeform?: FreeFormSecretDetector): void {
  _vault = provider;
  _keySource = keySource;
  if (freeform) _freeform = freeform;
}

/** Test/teardown hook: unbinds the singletons. */
export function resetVault(): void {
  _vault = null;
  _keySource = null;
  _freeform = NULL_FREEFORM_DETECTOR;
}

export function vault(): VaultProvider {
  if (!_vault) {
    throw new Error('Vault not bound. Call bindVault() during boot when VAULT_ENABLED=true.');
  }
  return _vault;
}

export function keySource(): KeySource {
  if (!_keySource) {
    throw new Error('Key source not bound.');
  }
  return _keySource;
}

export function freeformDetector(): FreeFormSecretDetector {
  return _freeform;
}

/**
 * True when both the master flag is on AND a provider has been bound.
 * Call sites should branch on this before invoking any vault method -
 * the gate is the conjunction (env flag alone is insufficient).
 */
export function isVaultEnabled(): boolean {
  return process.env.VAULT_ENABLED === 'true' && _vault !== null;
}

export { detectSecretsInText } from './secret-detector.js';
export { SECRET_PATTERNS } from './patterns.js';
export { FileKeySource } from './file-key-source.js';
export { EnvKeySource } from './env-key-source.js';
export { KmsKeySource } from './kms-key-source.js';
export { DefaultLocalVault } from './default-local.js';
export { NULL_FREEFORM_DETECTOR } from './freeform-detector.js';
export type {
  VaultProvider,
  KeySource,
  KeyId,
  SecretRef,
  VaultContext,
  CallerIdentity,
  CallerType,
  VaultStage,
  DetectedSecret,
  SecretDetectionResult,
  FreeFormSecretDetector,
} from './types.js';
