import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import type { Config } from '../config';
import { AppError, notFound, tooManyRequests, unauthorized } from '../errors';
import { errorMessage, type Logger } from '../logger';
import type { ApiMetrics } from '../metrics';
import { findAuthByKeyHash, hashApiKey } from '../repositories/apiKeys';
import { hit } from '../repositories/rateLimit';
import { getAuth, wrap } from './http';

export function requestContext(logger: Logger, metrics: ApiMetrics): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID(); // never trust a client-supplied id (log injection)
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route ? `${req.baseUrl}${(req.route as { path: string }).path}` : 'unmatched';
      metrics.httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
      logger.info('http_request', {
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
        tenantId: (res.locals.auth as { tenantId?: string } | undefined)?.tenantId,
      });
    });
    next();
  };
}

export function authenticate(pool: Pool): RequestHandler {
  return wrap(async (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match) throw unauthorized();
    const auth = await findAuthByKeyHash(pool, hashApiKey(match[1] as string));
    if (!auth) throw unauthorized();
    res.locals.auth = auth;
    next();
  });
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export function requireAdmin(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (!config.ADMIN_TOKEN) return next(new AppError(503, 'ADMIN_DISABLED', 'Tenant creation is disabled (ADMIN_TOKEN not set)'));
    const given = req.header('x-admin-token') ?? '';
    // Hash both sides so timingSafeEqual always compares equal-length buffers.
    if (!timingSafeEqual(digest(given), digest(config.ADMIN_TOKEN))) return next(unauthorized('Invalid admin token'));
    next();
  };
}

export function rateLimit(pool: Pool, metrics: ApiMetrics): RequestHandler {
  return wrap(async (_req, res, next) => {
    const auth = getAuth(res);
    const { count, windowEndsAtMs } = await hit(pool, auth.tenantId);
    const remaining = Math.max(0, auth.rateLimitPerMinute - count);
    res.setHeader('X-RateLimit-Limit', String(auth.rateLimitPerMinute));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(windowEndsAtMs / 1000)));
    if (count > auth.rateLimitPerMinute) {
      metrics.rateLimited.inc();
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((windowEndsAtMs - Date.now()) / 1000))));
      throw tooManyRequests(`Rate limit of ${auth.rateLimitPerMinute} requests per minute exceeded`);
    }
    next();
  });
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(notFound('Route'));
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const requestId = res.locals.requestId as string | undefined;
    const send = (status: number, code: string, message: string, details?: unknown): void => {
      res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}), requestId } });
    };
    if (err instanceof AppError) return send(err.status, err.code, err.message, err.details);
    if (err instanceof ZodError) {
      return send(400, 'INVALID_REQUEST', 'Request validation failed', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const e = err as { type?: string };
    if (e.type === 'entity.parse.failed') return send(400, 'INVALID_JSON', 'Request body is not valid JSON');
    if (e.type === 'entity.too.large') return send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    // Anything else is a bug or infrastructure failure: log details server-side, reveal nothing to the client.
    logger.error('unhandled_error', { requestId, error: errorMessage(err) });
    return send(500, 'INTERNAL_ERROR', 'Internal server error');
  };
}
