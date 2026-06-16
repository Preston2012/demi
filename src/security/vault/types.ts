/**
 * W4.5 Vault, interface contracts.
 *
 * Spec: docs/internal/WEDGE_4_5_VAULT_DESIGN.md §6.
 *
 * Two interfaces define the seam between the engine and the embedding app:
 *   - {@link VaultProvider}: encrypt / decrypt / exists / delete for opaque secrets.
 *   - {@link KeySource}: supplies raw key bytes (db, vault, audit) to the provider.
 *
 * Default impls (file-backed key source + JSONL vault) ship in this module.
 * Enterprise clients plug HSM / KMS by providing their own KeySource impl.
 */

/**
 * Opaque reference stored in memory text in place of a plaintext secret.
 * Shape: `vault:<provider>:<key-id>` (e.g. `vault:default-local:7b3f...`).
 */
export type SecretRef = string;

/** Stage of the engine pipeline that originated an encrypt / decrypt call. */
export type VaultStage = 'extraction' | 'injection-scan' | 'write-direct' | 'migration';

/** Categorisation of who is asking the vault to decrypt a secret. */
export type CallerType = 'local-llm' | 'cloud-llm' | 'user-direct' | 'engine-internal';

/** Engine-internal subsystem origin (audit verifier, migration, gc, etc). */
export type CallerSubsystem = 'audit-verifier' | 'migration' | 'backup' | 'gc';

/** Context passed alongside every encrypt for telemetry + audit context. */
export interface VaultContext {
  userId: string;
  stage: VaultStage;
  memoryId?: string;
}

/** Identity of a decrypt caller. Cloud-llm callers are refused unconditionally. */
export interface CallerIdentity {
  callerType: CallerType;
  cloudModel?: string;
  userId?: string;
  subsystem?: CallerSubsystem;
}

/** Result row from the secret detector, pure regex output, no encryption yet. */
export interface DetectedSecret {
  pattern: string;
  start: number;
  end: number;
  value: string;
}

/** Combined detector output: spans + ready-to-substitute redacted form. */
export interface SecretDetectionResult {
  spans: DetectedSecret[];
  redactedText: string;
  hasSecrets: boolean;
}

/** Three known key identifiers; KeySource impls must support all three. */
export type KeyId = 'db' | 'vault' | 'audit';

/**
 * Pluggable key material source. File-backed (default), env-backed, or KMS-backed.
 * Implementations cache aggressively, keys are fetched once per identifier and
 * reused for the lifetime of the engine process.
 */
export interface KeySource {
  readonly sourceName: string;
  getKey(keyId: KeyId): Buffer;
}

/**
 * The vault interface itself. Encrypts plaintext secrets to opaque refs;
 * decrypts only when the caller is authorised (cloud-llm is refused).
 */
export interface VaultProvider {
  readonly providerName: string;
  encrypt(plaintext: string, context: VaultContext): Promise<SecretRef>;
  decrypt(ref: SecretRef, caller: CallerIdentity): Promise<string | null>;
  exists(ref: SecretRef): Promise<boolean>;
  delete(ref: SecretRef, caller: CallerIdentity): Promise<void>;
}

/**
 * Stage-2 (W6+) free-form detection beyond the v1 regex layer.
 * v1 ships with the NULL impl below; LLM-based detection lands later.
 */
export interface FreeFormSecretDetector {
  readonly detectorName: string;
  detect(text: string): Promise<DetectedSecret[]>;
}
