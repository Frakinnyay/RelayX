import http from 'node:http';
import os from 'node:os';
import { Registry } from 'prom-client';
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { createLogger, errorMessage } from '../logger';
import { createWorkerMetrics } from '../metrics';
import { Worker } from './worker';

async function main(): Promise<void> {
  const config = loadConfig();
  const workerId = `${os.hostname()}-${process.pid}`;
  const logger = createLogger(config.LOG_LEVEL, { service: 'relayx-worker', workerId });
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX, logger);
  const registry = new Registry();
  const metrics = createWorkerMetrics(registry);
  const worker = new Worker({ pool, config, logger, metrics, workerId });

  const metricsServer = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      void registry.metrics().then((body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType });
        res.end(body);
      });
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    } else {
      res.writeHead(404).end();
    }
  });
  metricsServer.listen(config.WORKER_METRICS_PORT, () => logger.info('worker_metrics_listening', { port: config.WORKER_METRICS_PORT }));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_signal_received', { signal });
    try {
      await worker.stop();
      metricsServer.close();
      await pool.end();
      logger.info('shutdown_complete');
      process.exit(0);
    } catch (err) {
      logger.error('shutdown_error', { error: errorMessage(err) });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await worker.run();
}

main().catch((err: unknown) => {
  process.stderr.write(`Worker failed to start: ${errorMessage(err)}\n`);
  process.exit(1);
});
