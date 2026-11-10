import { Router } from 'express';
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { ApiMetrics } from '../metrics';
import { badRequest, notFound } from '../errors';
import { deactivateEndpoint, findEndpoint, listEndpoints } from '../repositories/endpoints';
import { eventCount, listDeliveries, statusCounts } from '../repositories/deliveries';
import { listEvents } from '../repositories/events';
import { createEndpoint } from '../services/endpointService';
import { getDeliveryDetail, getEventDetail, replayDelivery } from '../services/deliveryService';
import { ingestEvent } from '../services/eventService';
import { createTenantWithKey, rotateKey } from '../services/keyService';
import { authenticate, rateLimit, requireAdmin } from './middleware';
import { getAuth, wrap } from './http';
import {
  createEndpointBody,
  createEventBody,
  createTenantBody,
  deliveriesQuery,
  idempotencyHeader,
  paginationQuery,
  uuidParam,
} from './schemas';

export interface RouteDeps {
  pool: Pool;
  config: Config;
  metrics: ApiMetrics;
}

export function buildV1Router({ pool, config, metrics }: RouteDeps): Router {
  const v1 = Router();

  // --- bootstrap: create a tenant (admin only). Returns the raw API key exactly once. ---
  v1.post(
    '/tenants',
    requireAdmin(config),
    wrap(async (req, res) => {
      const body = createTenantBody.parse(req.body);
      const { tenant, apiKey } = await createTenantWithKey(pool, body.name, body.rateLimitPerMinute ?? config.DEFAULT_RATE_LIMIT_PER_MINUTE);
      res.status(201).json({ tenant, apiKey, notice: 'Store this API key now. It cannot be shown again.' });
    }),
  );

  // --- everything below requires a tenant API key ---
  v1.use(authenticate(pool));

  v1.post(
    '/api-keys/rotate',
    wrap(async (_req, res) => {
      const { apiKey } = await rotateKey(pool, getAuth(res));
      res.status(201).json({ apiKey, notice: 'The previous key is now revoked. Store this key now; it cannot be shown again.' });
    }),
  );

  v1.get(
    '/stats',
    wrap(async (_req, res) => {
      const { tenantId } = getAuth(res);
      res.json({ events: await eventCount(pool, tenantId), deliveries: await statusCounts(pool, tenantId) });
    }),
  );

  // endpoints
  v1.post(
    '/endpoints',
    wrap(async (req, res) => {
      const body = createEndpointBody.parse(req.body);
      res.status(201).json(await createEndpoint(pool, config, getAuth(res).tenantId, body));
    }),
  );
  v1.get('/endpoints', wrap(async (_req, res) => void res.json({ data: await listEndpoints(pool, getAuth(res).tenantId) })));
  v1.get(
    '/endpoints/:id',
    wrap(async (req, res) => {
      const { id } = uuidParam.parse(req.params);
      const ep = await findEndpoint(pool, getAuth(res).tenantId, id);
      if (!ep) throw notFound('Endpoint');
      res.json(ep);
    }),
  );
  v1.delete(
    '/endpoints/:id',
    wrap(async (req, res) => {
      const { id } = uuidParam.parse(req.params);
      const ep = await deactivateEndpoint(pool, getAuth(res).tenantId, id);
      if (!ep) throw notFound('Endpoint');
      res.json(ep);
    }),
  );

  // events
  v1.post(
    '/events',
    rateLimit(pool, metrics),
    wrap(async (req, res) => {
      const body = createEventBody.parse(req.body);
      const headerRaw = req.header('idempotency-key');
      const headerKey = headerRaw === undefined ? undefined : idempotencyHeader.safeParse(headerRaw).data;
      if (headerRaw !== undefined && headerKey === undefined) throw badRequest('INVALID_REQUEST', 'Idempotency-Key header must be 1-255 characters');
      const result = await ingestEvent(pool, config, getAuth(res).tenantId, {
        eventType: body.eventType,
        endpointId: body.endpointId,
        payload: body.payload,
        metadata: body.metadata ?? {},
        idempotencyKey: body.idempotencyKey ?? headerKey,
      });
      metrics.eventsReceived.inc({ duplicate: String(result.idempotentReplay) });
      // 202 Accepted: stored durably, delivery happens asynchronously. 200 = replay of an earlier request.
      res.status(result.idempotentReplay ? 200 : 202).json(result);
    }),
  );
  v1.get(
    '/events',
    wrap(async (req, res) => {
      const q = paginationQuery.parse(req.query);
      res.json({ data: await listEvents(pool, getAuth(res).tenantId, q.limit, q.offset), limit: q.limit, offset: q.offset });
    }),
  );
  v1.get(
    '/events/:id',
    wrap(async (req, res) => {
      const { id } = uuidParam.parse(req.params);
      res.json(await getEventDetail(pool, getAuth(res).tenantId, id));
    }),
  );

  // deliveries
  v1.get(
    '/deliveries',
    wrap(async (req, res) => {
      const q = deliveriesQuery.parse(req.query);
      res.json({ data: await listDeliveries(pool, getAuth(res).tenantId, q), limit: q.limit, offset: q.offset });
    }),
  );
  v1.get(
    '/deliveries/:id',
    wrap(async (req, res) => {
      const { id } = uuidParam.parse(req.params);
      res.json(await getDeliveryDetail(pool, getAuth(res).tenantId, id));
    }),
  );
  v1.post(
    '/deliveries/:id/replay',
    wrap(async (req, res) => {
      const { id } = uuidParam.parse(req.params);
      res.status(202).json(await replayDelivery(pool, getAuth(res).tenantId, id, config.MAX_ATTEMPTS));
    }),
  );

  return v1;
}
