import type { KeySource, KeyId } from './types.js';

/**
 * Stub KeySource for cloud-KMS integrations.
 *
 * The W4.5 surface reserves `VAULT_KEY_SOURCE='kms'` for enterprise
 * deployments that fetch keys from AWS KMS / Azure Key Vault / HashiCorp
 * Vault / hardware enclaves. Engine ships with the seam in place but no
 * implementation, enterprise clients provide their own subclass.
 *
 * Selecting this source at startup raises immediately so misconfigurations
 * fail fast instead of silently falling through.
 */
export class KmsKeySource implements KeySource {
  readonly sourceName = 'kms';

  getKey(_keyId: KeyId): Buffer {
    throw new Error(
      'KmsKeySource: not implemented. Enterprise tier ships a real KMS ' +
        'KeySource. For self-hosted, set VAULT_KEY_SOURCE=file (default) or ' +
        'VAULT_KEY_SOURCE=env.',
    );
  }
}
