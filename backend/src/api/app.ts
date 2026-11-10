import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Pool } from 'pg';
import { Registry } from 'prom-client';
import swaggerUi from 'swagger-ui-express';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { createApiMetrics } from '../metrics';
import { errorHandler, notFoundHandler, requestContext } from './middleware';
import { openApiDocument } from './openapi';
import { buildV1Router } from './routes';

export interface AppDeps {
  config: Config;
  pool: Pool;
  logger: Logger;
  registry?: Registry;
}

export function createApp({ config, pool, logger, registry = new Registry() }: AppDeps): Express {
  const metrics = createApiMetrics(registry, pool);
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(logger, metrics));

  // Swagger UI needs inline scripts, so mount it before helmet's strict CSP.
  app.get('/openapi.json', (_req, res) => void res.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGIN.split(',').map((o) => o.trim()),
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Admin-Token'],
      exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After', 'X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: config.MAX_BODY_BYTES }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.get('/metrics', async (req, res) => {
    if (config.METRICS_TOKEN && req.header('authorization') !== `Bearer ${config.METRICS_TOKEN}`) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Metrics token required' } });
      return;
    }
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  app.use('/api/v1', buildV1Router({ pool, config, metrics }));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
