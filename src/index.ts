import { boot, type Runtime } from './boot.js';
import { createLogger } from './config.js';
import { recordError } from './telemetry/index.js';

/**
 * Demiurge entry point.
 * Boots the system and wires process signal handlers.
 */
async function main(): Promise<void> {
  let runtime: Runtime | undefined;

  try {
    runtime = await boot();
  } catch (err) {
    // boot() logs and rolls back any failure raised inside its own try block,
    // but the flag-dependency, LLM-provider and webhook validations run BEFORE
    // that block, so those throws arrive here having logged nothing. Write to
    // stderr directly rather than through the logger, because loadConfig() can
    // itself be the thing that failed. A bare exit code 1 with an empty log is
    // the worst possible first run for a fresh clone.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[FATAL] Boot failed: ${message}\n`);
    if (process.env.LOG_LEVEL === 'debug' && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const log = createLogger('main');
  let shuttingDown = false;

  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Received signal, shutting down');

    try {
      await runtime!.shutdown();
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
      process.exitCode = 1;
    }
  }

  process.on('SIGINT', () => {
    gracefulShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM');
  });

  // C-5/WC-10 ruling (2026-06-11): crash-after-flush. Serving from unknown
  // state after a swallowed rejection is worse than a restart; container/
  // systemd restart policy recovers the process. Flush is bounded so a hung
  // shutdown cannot keep the zombie alive.
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled rejection; flushing and exiting');
    recordError({
      error_type: 'unhandled_rejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack_trace: reason instanceof Error ? reason.stack : undefined,
    });
    const flush = gracefulShutdown('unhandledRejection');
    const deadline = new Promise((resolve) => setTimeout(resolve, 5_000));
    void Promise.race([flush, deadline]).finally(() => {
      process.exit(1);
    });
  });
}

main();
