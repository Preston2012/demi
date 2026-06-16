/**
 * R29 WB-5 / WB-6: shared implementation behind both `demiurge verify-chain`
 * (top-level, user-runnable) and `demiurge telemetry verify-audit-chain`.
 *
 * Both reuse the same code path as the systemd cron: runVerifyAuditChain in
 * src/cron/verify-audit-chain.ts. A manual run is verify-only (it never writes
 * a snapshot), so an operator can check integrity without side effects; the
 * cron path keeps writing signed snapshots when AUDIT_SNAPSHOT_KEY is set.
 */

import { loadConfig } from '../config.js';

export async function runVerifyChainCli(): Promise<number> {
  const config = loadConfig();
  const { SqliteMemoryRepository } = await import('../repository/sqlite/index.js');
  const { runVerifyAuditChain } = await import('../cron/verify-audit-chain.js');

  const repo = new SqliteMemoryRepository(config);
  await repo.initialize();
  try {
    const result = await runVerifyAuditChain(repo);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return result.exitCode;
  } finally {
    await repo.close();
  }
}
