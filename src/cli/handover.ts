/**
 * `demiurge-handover` entry point.
 *
 * Generates the plain-language handover document that records what the client
 * owns and what the service provider can access. Reads the template, prompts
 * the operator for the fill-in fields, substitutes them, and writes Markdown.
 *
 * Spec: docs/internal/WEDGE_4_6_CLIENT_SURFACE_DESIGN.md section 6.1.
 *
 * Usage:
 *   demiurge-handover [--out <path>] [--template <path>] [--key-dir <dir>]
 */

/* eslint-disable no-console */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, prompt, getKeyFingerprints, isEntryPoint } from './lib.js';
import { getEngineVersion } from '../security/recovery/index.js';
import { fillTemplate, remainingPlaceholders, type HandoverValues } from './handover-template.js';

/** Locate the handover template across install and repo layouts. */
function resolveTemplatePath(override?: string): string {
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    '/usr/local/lib/demiurge/docs/HANDOVER_TEMPLATE.md',
    join(here, '../../docs/client/HANDOVER_TEMPLATE.md'),
    join(here, '../../../docs/client/HANDOVER_TEMPLATE.md'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('HANDOVER_TEMPLATE.md not found. Pass --template <path> to point at it explicitly.');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args['help']) {
    console.log('Usage: demiurge-handover [--out <path>] [--template <path>] [--key-dir <dir>]');
    return 0;
  }

  const outPath = typeof args['out'] === 'string' ? args['out'] : './handover.md';
  const keyDir = typeof args['key-dir'] === 'string' ? args['key-dir'] : '/etc/demiurge/keys';
  const template = readFileSync(
    resolveTemplatePath(typeof args['template'] === 'string' ? args['template'] : undefined),
    'utf8',
  );

  const values: HandoverValues = {
    CLIENT_NAME: await prompt('Client name: '),
    CLIENT_EMAIL: await prompt('Client email: '),
    SERVICE_PROVIDER: await prompt('Service provider: '),
    SERVICE_PROVIDER_EMAIL: await prompt('Service provider email: '),
    HOSTNAME: await prompt('Hostname: '),
    HOST_IP: await prompt('Host IP: '),
    DATACENTER: await prompt('Datacenter: '),
    OPS_ACCOUNT: await prompt('Ops account name (the account the provider SSHes in as): '),
    INSTALL_DATE: new Date().toISOString().split('T')[0]!,
    ENGINE_VERSION: getEngineVersion(),
    KEY_FINGERPRINTS: getKeyFingerprints(keyDir),
  };

  const filled = fillTemplate(template, values);
  const leftover = remainingPlaceholders(filled);
  if (leftover.length > 0) {
    console.error(`Template still has unfilled placeholders: ${leftover.join(', ')}`);
    return 1;
  }

  writeFileSync(outPath, filled);
  console.log(`Handover document written to ${outPath}.`);
  console.log('Both parties should sign a printed copy and each keep one.');
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
