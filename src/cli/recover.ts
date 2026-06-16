/**
 * `demiurge-recover` entry point.
 *
 * Reads a recovery bundle, prompts for the passphrase, and either verifies it
 * against the live host (default) or restores the master keys onto the host
 * (`--restore`).
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 4.2.
 *
 * Usage:
 *   demiurge-recover --bundle <path> [--key-dir <dir>]            # verify
 *   demiurge-recover --bundle <path> --restore [--force]         # restore keys
 */

/* eslint-disable no-console */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, promptPassphrase, isEntryPoint } from './lib.js';
import { readRecoveryBundle, sha256, KEY_NAMES } from '../security/recovery/index.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const bundlePath = typeof args['bundle'] === 'string' ? args['bundle'] : undefined;
  const keyDir = typeof args['key-dir'] === 'string' ? args['key-dir'] : '/etc/demiurge/keys';
  const restoreMode = args['restore'] === true || args['restore'] === '' || args['restore'] === 'true';
  const force = args['force'] === true || args['force'] === 'true';

  if (args['help'] || !bundlePath) {
    console.log('Usage: demiurge-recover --bundle <path> [--key-dir <dir>] [--restore] [--force]');
    return bundlePath ? 0 : 1;
  }

  const passphrase = await promptPassphrase('Recovery passphrase: ');

  let contents;
  try {
    contents = await readRecoveryBundle({ bundlePath, passphrase });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { manifest, keys } = contents;

  if (restoreMode) {
    for (const name of KEY_NAMES) {
      const path = join(keyDir, `${name}.key`);
      if (existsSync(path) && !force) {
        console.error(`${name}.key already exists. Pass --force to overwrite (DESTRUCTIVE).`);
        return 1;
      }
    }
    for (const name of KEY_NAMES) {
      writeFileSync(join(keyDir, `${name}.key`), keys[name], { mode: 0o600 });
    }
    console.log('Keys restored to ' + keyDir + '.');
    console.log('Start the engine and verify the databases unlock cleanly.');
    return 0;
  }

  // Verify mode.
  console.log('Recovery bundle valid.');
  console.log(`Installed at: ${manifest.installed_at}`);
  console.log(`Hostname:     ${manifest.hostname}`);
  console.log(`Engine ver:   ${manifest.engine_version}`);
  if (manifest.client_notes) console.log(`Notes:        ${manifest.client_notes}`);

  let mismatch = false;
  for (const name of KEY_NAMES) {
    const livePath = join(keyDir, `${name}.key`);
    if (!existsSync(livePath)) {
      console.log(`${name}.key: NOT PRESENT ON LIVE HOST`);
      continue;
    }
    const liveFingerprint = sha256(readFileSync(livePath));
    if (liveFingerprint === manifest.key_fingerprints[name]) {
      console.log(`${name}.key: MATCH`);
    } else {
      console.log(`${name}.key: MISMATCH (live host differs from bundle)`);
      mismatch = true;
    }
  }
  return mismatch ? 2 : 0;
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
