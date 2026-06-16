/**
 * `demiurge-recovery-rebundle` entry point.
 *
 * Generates a recovery bundle from the current master keys. Used at install
 * time (`--mode initial-install`) and for passphrase rotation later
 * (`--mode rotate`), which makes any previously written bundle useless.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md sections 4.1, 4.3.
 *
 * Usage:
 *   demiurge-recovery-rebundle --bundle-path <path> [--key-dir <dir>] \
 *     [--mode initial-install|rotate] [--notes "<text>"]
 */

/* eslint-disable no-console */

import { parseArgs, promptPassphrase, isEntryPoint } from './lib.js';
import { writeRecoveryBundle, MIN_PASSPHRASE_LEN } from '../security/recovery/index.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const bundlePath = typeof args['bundle-path'] === 'string' ? args['bundle-path'] : undefined;
  const keyDir = typeof args['key-dir'] === 'string' ? args['key-dir'] : '/etc/demiurge/keys';
  const mode = typeof args['mode'] === 'string' ? args['mode'] : 'rotate';
  const notes = typeof args['notes'] === 'string' ? args['notes'] : undefined;

  if (args['help'] || !bundlePath) {
    console.log(
      'Usage: demiurge-recovery-rebundle --bundle-path <path> ' +
        '[--key-dir <dir>] [--mode initial-install|rotate] [--notes "<text>"]',
    );
    return bundlePath ? 0 : 1;
  }

  if (mode === 'rotate') {
    console.log('Rotating recovery passphrase. The previous bundle becomes unusable.');
  }
  console.log('');
  console.log('This passphrase encrypts a bundle containing your master keys.');
  console.log('If you lose both your server AND this passphrase, your data is unrecoverable.');
  console.log('Recommended: a password manager. 4+ random words from the EFF wordlist is strong.');
  console.log('');

  const pass1 = await promptPassphrase('Recovery passphrase: ');
  const pass2 = await promptPassphrase('Confirm passphrase:  ');
  if (pass1 !== pass2) {
    console.error('Passphrases do not match.');
    return 1;
  }
  if (pass1.length < MIN_PASSPHRASE_LEN) {
    console.error(`Passphrase too short (minimum ${MIN_PASSPHRASE_LEN} characters).`);
    return 1;
  }

  const result = await writeRecoveryBundle({
    keyDir,
    bundlePath,
    passphrase: pass1,
    ...(notes ? { clientNotes: notes } : {}),
  });
  console.log(`Recovery bundle written to ${bundlePath} (${result.bytes} bytes).`);
  console.log('WRITE DOWN THE RECOVERY PASSPHRASE NOW. Lost passphrase + lost keys = lost data.');
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

export { main };
