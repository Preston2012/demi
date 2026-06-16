/**
 * Wedge 1.5 Phase 3: `demiurge telemetry <subcommand>` implementations.
 *
 * Pure consumers of the query layer. Format selectable via --format json
 * (default) or --format table.
 */

import {
  queryTraces,
  queryDecisions,
  queryRefusals,
  queryCostByProvider,
  queryErrors,
  queryCacheHitRates,
  queryRateLimitSummary,
  pruneOlderThan,
  type TimeWindow,
} from '../telemetry/query.js';
import { loadConfig } from '../config.js';

export interface CliFlags {
  [key: string]: string | boolean | undefined;
}

function buildWindow(flags: CliFlags): TimeWindow {
  const limit = flags.limit;
  return {
    since: typeof flags.since === 'string' ? flags.since : undefined,
    until: typeof flags.until === 'string' ? flags.until : undefined,
    limit: typeof limit === 'string' ? Number(limit) : undefined,
  };
}

function getFormat(flags: CliFlags): string {
  const f = flags.format;
  return typeof f === 'string' ? f : 'json';
}

function printJson(data: unknown): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(data, null, 2));
}

function printTable(rows: unknown[]): void {
  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log('(no rows)');
    return;
  }
  const first = rows[0] as Record<string, unknown>;
  const cols = Object.keys(first);
  // eslint-disable-next-line no-console
  console.log(cols.join('\t'));
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const cells = cols.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      return String(v);
    });
    // eslint-disable-next-line no-console
    console.log(cells.join('\t'));
  }
}

function output(data: unknown, format: string): void {
  if (format === 'table' && Array.isArray(data)) {
    printTable(data);
  } else {
    printJson(data);
  }
}

export async function runTelemetryCommand(sub: string | undefined, flags: CliFlags): Promise<number> {
  const window = buildWindow(flags);
  const format = getFormat(flags);

  switch (sub) {
    case 'show-traces':
      output(queryTraces(window), format);
      return 0;

    case 'show-decisions': {
      const type = typeof flags.type === 'string' ? flags.type : undefined;
      output(queryDecisions({ ...window, decision_type: type }), format);
      return 0;
    }

    case 'show-refusals':
      output(queryRefusals(window), format);
      return 0;

    case 'show-cost':
      output(queryCostByProvider(window), format);
      return 0;

    case 'show-errors': {
      const type = typeof flags.type === 'string' ? flags.type : undefined;
      output(queryErrors({ ...window, error_type: type }), format);
      return 0;
    }

    case 'show-cache-rates':
      output(queryCacheHitRates(window), format);
      return 0;

    case 'show-rate-limits':
      output(queryRateLimitSummary(window), format);
      return 0;

    case 'prune-old': {
      const days = flags.days;
      const n = typeof days === 'string' ? Number(days) : NaN;
      if (!Number.isFinite(n) || n < 1) {
        // eslint-disable-next-line no-console
        console.error('--days N required (N >= 1)');
        return 1;
      }
      output(pruneOlderThan(n), format);
      return 0;
    }

    case 'verify-encryption': {
      const result = {
        key_present: false,
        key_format_valid: false,
        db_file_encrypted: false,
        db_readable_with_key: false,
        pass: false,
        detail: '' as string,
      };

      const key = process.env.DEMIURGE_DB_KEY;
      if (!key) {
        result.detail = 'DEMIURGE_DB_KEY not set';
        output(result, format);
        return 1;
      }
      result.key_present = true;
      if (!/^[0-9a-fA-F]{64}$/.test(key)) {
        result.detail = 'DEMIURGE_DB_KEY not 64-char hex';
        output(result, format);
        return 1;
      }
      result.key_format_valid = true;

      const config = loadConfig();
      if (config.dbPath === ':memory:') {
        result.detail = ':memory: DB is intentionally unencrypted';
        output(result, format);
        return 2;
      }

      const { existsSync, readFileSync } = await import('node:fs');
      if (!existsSync(config.dbPath)) {
        result.detail = `DB file does not exist: ${config.dbPath}`;
        output(result, format);
        return 1;
      }

      const header = readFileSync(config.dbPath).subarray(0, 16);
      const plaintextMagic = Buffer.from('SQLite format 3\0');
      result.db_file_encrypted = !header.equals(plaintextMagic);

      try {
        const { SqliteMemoryRepository } = await import('../repository/sqlite/index.js');
        const repo = new SqliteMemoryRepository(config);
        await repo.initialize();
        const count = await repo.countAll();
        await repo.close();
        result.db_readable_with_key = true;
        result.detail = `OK: ${count} memories readable`;
      } catch (err) {
        result.detail = `failed to open DB with key: ${err instanceof Error ? err.message : String(err)}`;
      }

      result.pass =
        result.key_present && result.key_format_valid && result.db_file_encrypted && result.db_readable_with_key;

      output(result, format);
      return result.pass ? 0 : 1;
    }

    case 'verify-audit-chain': {
      // R29 WB-5: point the verb at the real verifier (same code path as the
      // systemd cron and the top-level `demiurge verify-chain`).
      const { runVerifyChainCli } = await import('./verify-chain.js');
      return runVerifyChainCli();
    }

    default:
      // eslint-disable-next-line no-console
      console.error(`Unknown telemetry subcommand: ${sub}`);
      return 1;
  }
}
