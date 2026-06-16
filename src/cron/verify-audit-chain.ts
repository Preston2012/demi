/**
 * Wedge 1.5 Phase 4: STONE audit-chain integrity cron entry point.
 *
 * Loads the configured DB, walks the audit log via verifyChain(), and:
 *   - exits 0 on clean chain (optionally writes an HMAC-signed snapshot
 *     when AUDIT_SNAPSHOT_KEY is set)
 *   - exits 2 on integrity failure, after firing an audit_chain_failure
 *     webhook with the live verifyChain() result fields
 *   - exits 3 on unhandled crash inside main()
 *
 * Engine isolation: this module imports DOWN into src/repository,
 * src/security, src/config, it is never imported by the engine.
 * The Phase 3 invariant grep verifies this before commit.
 *
 * Designed to run from systemd (scripts/stone-verify-cron.{service,timer}),
 * or any periodic invoker, via the bash wrapper at
 * scripts/stone-verify-cron.sh.
 */

import { loadConfig, createLogger } from '../config.js';
import { SqliteMemoryRepository } from '../repository/sqlite/index.js';
import { verifyEpochAwareChain, createSnapshot, saveSnapshot } from '../repository/audit-log.js';
import { fireWebhook } from '../security/alert-webhook.js';

const log = createLogger('cron/verify-audit-chain');

export interface VerifyCronResult {
  exitCode: number;
  entriesChecked: number;
  valid: boolean;
  firstInvalidEntry: string | null;
  error: string | null;
  snapshotPath?: string;
}

/**
 * Pure-result variant: returns the structured result without calling
 * process.exit. Tests use this entry point; the CLI / cron uses main().
 */
export async function runVerifyAuditChain(
  repo: Pick<SqliteMemoryRepository, 'getAllAuditEntries' | 'getAuditTombstoneHashes'>,
  options: { snapshotKey?: string; snapshotDir?: string } = {},
): Promise<VerifyCronResult> {
  const entries = await repo.getAllAuditEntries();

  // R29 WB-3: epoch-aware verification. Pre-epoch rows are checked as one
  // global chain, post-epoch rows per user; with no epoch marker this reduces
  // to the S2 per-user check. Dangling references from intentional deletions
  // are tolerated only when covered by the tombstone manifest.
  const tombstonedHashes = repo.getAuditTombstoneHashes ? await repo.getAuditTombstoneHashes() : new Set<string>();
  const result = verifyEpochAwareChain(entries, { tombstonedHashes });

  if (!result.valid) {
    const scope = result.scope ?? 'unknown';
    // Preserve the existing webhook contract: user_id carries the bare user
    // id for a per-user failure; for the global/epoch segments it carries the
    // segment name ('legacy-global', 'epoch').
    const webhookUserId = scope.startsWith('user=') ? scope.slice('user='.length) : scope;
    log.error({ scope, result }, 'AUDIT CHAIN INTEGRITY FAILURE');
    await fireWebhook('audit_chain_failure', {
      severity: 'critical',
      user_id: webhookUserId,
      entries_checked: result.entriesChecked,
      first_invalid_entry: result.firstInvalidEntry,
      reason: result.error,
    });
    return {
      exitCode: 2,
      entriesChecked: result.entriesChecked,
      valid: false,
      firstInvalidEntry: result.firstInvalidEntry,
      error: `${scope}: ${result.error}`,
    };
  }

  let snapshotPath: string | undefined;
  if (options.snapshotKey) {
    const snapshot = createSnapshot(entries, options.snapshotKey);
    const backupDir = options.snapshotDir ?? './data/audit-snapshots';
    snapshotPath = saveSnapshot(snapshot, backupDir);
    log.info({ entries: entries.length, backupDir, snapshotPath }, 'audit snapshot written');
  }

  log.info({ entries: entries.length }, 'audit chain verified clean (epoch-aware)');
  return {
    exitCode: 0,
    entriesChecked: result.entriesChecked,
    valid: true,
    firstInvalidEntry: null,
    error: null,
    snapshotPath,
  };
}

export async function main(): Promise<number> {
  const config = loadConfig();
  const repo = new SqliteMemoryRepository(config);
  await repo.initialize();

  try {
    const snapshotKey = process.env.AUDIT_SNAPSHOT_KEY ?? config.snapshotKey;
    const snapshotDir = process.env.AUDIT_SNAPSHOT_DIR ?? config.backupPath;
    const result = await runVerifyAuditChain(repo, { snapshotKey, snapshotDir });
    return result.exitCode;
  } finally {
    await repo.close();
  }
}

// Run as script when invoked directly (dist/cron/verify-audit-chain.js).
// The systemd unit / bash wrapper executes this path.
const isDirectInvocation =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('verify-audit-chain.js') || process.argv[1].endsWith('verify-audit-chain.ts'));

if (isDirectInvocation) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'verify-audit-chain crashed');
      process.exit(3);
    });
}
