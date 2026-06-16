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
  } catch {
    // boot() already logged the error and rolled back
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
