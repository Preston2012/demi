/**
 * W4 Track A: STONE bench-runner wiring helper.
 *
 * W3 shipped the Materializer behind the MATERIALIZER_ENABLED flag, but
 * bench runners construct dispatch without a StoneStore. dispatch.ingest's
 * flag-on branch requires a STONE sequence number to fire, so until this
 * lands the materializer was silently disabled in every bench measurement
 * regardless of the flag. Track A measurement is impossible without it.
 *
 * Preserves brain-#2090 doctrine: STONE off by default in benches. Stone
 * is constructed only when BOTH MATERIALIZER_ENABLED and
 * STONE_ENABLED_FOR_MATERIALIZER are 'true', so flag-off bench runs incur
 * zero STONE overhead (no extra writes, no extra table churn).
 *
 * Bench profiles default both flags to 'false' in src/benchmark/lib/bench-env.ts.
 * Measurement runs opt in explicitly via env override or runner CLI flag.
 */

import { StoneStore } from '../../stone/index.js';
import type { IMemoryRepository } from '../../repository/interface.js';

/**
 * Return a StoneStore bound to the repo's DB iff both gating flags are on.
 * Returns null otherwise so callers can pass the result straight through
 * to `createCoreDispatch(repo, config, stone)`.
 *
 * The repo argument must expose `getDatabase()`; SqliteMemoryRepository
 * does. If a future repo impl doesn't, materializer-aware benches need
 * the equivalent accessor added.
 */
export function maybeStoneForMaterializer(repo: IMemoryRepository): StoneStore | null {
  if (process.env.MATERIALIZER_ENABLED !== 'true') return null;
  if (process.env.STONE_ENABLED_FOR_MATERIALIZER !== 'true') return null;
  const withDb = repo as IMemoryRepository & { getDatabase?: () => unknown };
  if (typeof withDb.getDatabase !== 'function') {
    throw new Error(
      'maybeStoneForMaterializer: repo does not expose getDatabase(). ' +
        'Materializer-aware benches require a repo impl that surfaces the underlying DB handle.',
    );
  }
  // Type-narrow via the SqliteMemoryRepository contract: getDatabase()
  // returns a better-sqlite3 Database. StoneStore accepts that shape.
  const db = withDb.getDatabase() as ConstructorParameters<typeof StoneStore>[0];
  return new StoneStore(db);
}
