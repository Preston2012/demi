/**
 * Wedge 1.5 Phase 3: `demiurge` CLI entry point.
 *
 * Invoked via `bin/demiurge` (compiled to dist/cli/index.js). The engine
 * does NOT import from this file, verification step 3 in the packet
 * enforces that invariant.
 */

import { loadConfig } from '../config.js';
import { initStorage } from '../telemetry/index.js';
import { runTelemetryCommand, type CliFlags } from './telemetry-commands.js';

interface ParsedArgs {
  command?: string;
  subcommand?: string;
  flags: CliFlags;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: CliFlags = {};
  const positional: string[] = [];
  let command: string | undefined;
  let subcommand: string | undefined;

  let i = 0;
  while (i < args.length) {
    const token = args[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        i++;
      } else {
        const key = token.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 2;
        } else {
          flags[key] = true;
          i++;
        }
      }
    } else {
      if (command === undefined) {
        command = token;
      } else if (subcommand === undefined) {
        subcommand = token;
      } else {
        positional.push(token);
      }
      i++;
    }
  }

  return { command, subcommand, flags, positional };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`demiurge CLI

Usage:
  demiurge verify-chain          Verify audit-log integrity (epoch-aware)
  demiurge telemetry <subcommand> [flags]

Telemetry subcommands:
  show-traces        List recent traces
  show-decisions     List recent decisions (--type to filter)
  show-refusals      List recent refusals
  show-cost          Aggregate LLM cost by provider/model
  show-errors        List recent errors (--type to filter)
  show-cache-rates   Cache hit/miss rates by cache name
  show-rate-limits   Per-user rate limit summary
  prune-old          Delete events older than --days N
  verify-encryption  (stub) Verify encryption-at-rest
  verify-audit-chain Verify audit log integrity (epoch-aware)

Flags:
  --since <iso>      Start of window (default 24h ago)
  --until <iso>      End of window
  --limit <n>        Max rows (default 1000, max 10000)
  --format json|table  Output format (default json)
`);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if (!parsed.command || parsed.command === 'help' || parsed.flags.help === true) {
    printUsage();
    return 0;
  }

  const config = loadConfig();
  initStorage({
    dbPath: config.telemetryDbPath,
    dbEncryptionKey: config.dbEncryptionKey,
    enabled: config.telemetryEnabled,
    flushIntervalMs: config.telemetryFlushIntervalMs,
    ringBufferSize: config.telemetryRingBufferSize,
  });

  if (parsed.command === 'telemetry') {
    return runTelemetryCommand(parsed.subcommand, parsed.flags);
  }

  // R29 WB-6: user-runnable audit-chain verification.
  if (parsed.command === 'verify-chain') {
    const { runVerifyChainCli } = await import('./verify-chain.js');
    return runVerifyChainCli();
  }

  // eslint-disable-next-line no-console
  console.error(`Unknown command: ${parsed.command}`);
  printUsage();
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
