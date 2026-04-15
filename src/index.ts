import { boot, type Runtime } from './boot.js';
import { createLogger } from './config.js';

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

  process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled rejection');
  });
}

main();
