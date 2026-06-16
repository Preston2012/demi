/**
 * W4.6 recovery surface public exports.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 4.
 */

export {
  writeRecoveryBundle,
  readRecoveryBundle,
  BundleFormatError,
  BundleDecryptError,
  BUNDLE_MAGIC,
  MIN_PASSPHRASE_LEN,
  type RecoveryBundleContents,
  type WriteBundleOpts,
  type WriteBundleResult,
  type ReadBundleOpts,
} from './bundle.js';

export {
  KEY_NAMES,
  sha256,
  fingerprintKeys,
  getEngineVersion,
  buildManifest,
  type KeyName,
  type KeyFingerprints,
  type RecoveryManifest,
} from './manifest.js';
