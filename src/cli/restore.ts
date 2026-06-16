/**
 * `demiurge-restore` entry point.
 *
 * Restores engine databases from an encrypted backup bundle. Prompts for the
 * passphrase, decrypts and extracts the bundle, and atomically swaps it into
 * the data directory. The databases are verified to open under the live keys
 * implicitly: a passphrase mismatch between the recovery bundle (keys) and the
 * backup bundle surfaces as a decrypt failure here.
 *
 * Optional `--manage-service` stops the systemd unit before the swap and starts
 * it afterward. It is off by default so the command is safe to run in tests and
 * on hosts where systemd is not in play.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 5.4.
 *
 * Usage:
 *   demiurge-restore --bundle <path> [--data-dir <dir>] [--force] [--manage-service]
 */

/* eslint-disable no-console */

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { parseArgs, promptPassphrase, isEntryPoint } from './lib.js';
import { LocalBackupProvider } from '../security/backup/index.js';

function manageService(action: 'stop' | 'start'): void {
  const res = spawnSync('systemctl', [action, 'demiurge.service'], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.warn(`systemctl ${action} demiurge.service returned ${res.status ?? 'error'}.`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const bundle = typeof args['bundle'] === 'string' ? args['bundle'] : undefined;
  const dataDir =
    typeof args['data-dir'] === 'string' ? args['data-dir'] : (process.env.DEMIURGE_DATA_DIR ?? '/var/lib/demiurge');
  const force = args['force'] === true || args['force'] === 'true';
  const withService = args['manage-service'] === true || args['manage-service'] === 'true';

  if (args['help'] || !bundle) {
    console.log('Usage: demiurge-restore --bundle <path> [--data-dir <dir>] [--force] [--manage-service]');
    return bundle ? 0 : 1;
  }

  const passphrase = await promptPassphrase('Recovery passphrase: ');
  const provider = new LocalBackupProvider(dataDir, dirname(bundle), passphrase);

  if (withService) manageService('stop');
  try {
    const result = await provider.restoreBackup(bundle, { targetDataDir: dataDir, force });
    console.log(`Restored to ${result.restoredTo}.`);
    if (result.previousDataMovedTo) {
      console.log(`Previous data moved to ${result.previousDataMovedTo} (remove once verified).`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (withService) manageService('start');
  }
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
