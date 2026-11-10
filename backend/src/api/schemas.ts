import { z } from 'zod';
import { DELIVERY_STATUSES } from '../domain/state';

export const uuidParam = z.object({ id: z.string().uuid() });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const deliveriesQuery = paginationQuery.extend({
  status: z.enum(DELIVERY_STATUSES).optional(),
});

export const createTenantBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    rateLimitPerMinute: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

export const createEndpointBody = z
  .object({
    url: z.string().min(1).max(2048),
    description: z.string().max(200).optional(),
    secret: z.string().min(16).max(128).optional(),
  })
  .strict();

const jsonObject = z.record(z.string(), z.unknown());

export const createEventBody = z
  .object({
    eventType: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'eventType may contain letters, digits and . _ : -'),
    endpointId: z.string().uuid(),
    payload: jsonObject,
    metadata: jsonObject.optional(),
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .strict();

export const idempotencyHeader = z.string().min(1).max(255);
