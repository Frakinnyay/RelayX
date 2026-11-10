import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { createLogger, errorMessage } from '../logger';
import { createApp } from './app';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, { service: 'relayx-api' });
const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX, logger);
const app = createApp({ config, pool, logger });

const server = app.listen(config.PORT, () => logger.info('api_listening', { port: config.PORT }));

let closing = false;
const shutdown = (signal: string): void => {
  if (closing) return;
  closing = true;
  logger.info('shutdown_signal_received', { signal });
  server.close(() => {
    pool
      .end()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error('shutdown_error', { error: errorMessage(err) });
        process.exit(1);
      });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
