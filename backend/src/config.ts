import { z } from 'zod';

const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const posInt = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: posInt(10),

  // API
  PORT: posInt(3000),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters').optional(),
  METRICS_TOKEN: z.string().min(16).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  MAX_BODY_BYTES: posInt(262_144),
  DEFAULT_RATE_LIMIT_PER_MINUTE: posInt(120),

  // Outbound safety. NEVER true in production: it disables the SSRF protections.
  ALLOW_PRIVATE_WEBHOOK_TARGETS: flag,

  // Worker
  WORKER_CONCURRENCY: posInt(5),
  WORKER_POLL_INTERVAL_MS: posInt(1000),
  WORKER_METRICS_PORT: posInt(9101),
  LEASE_DURATION_MS: posInt(60_000),
  DELIVERY_TIMEOUT_MS: posInt(5000),
  SHUTDOWN_GRACE_MS: posInt(15_000),

  // Retry policy
  MAX_ATTEMPTS: posInt(6),
  RETRY_BASE_DELAY_MS: posInt(5000),
  RETRY_FACTOR: z.coerce.number().min(1).default(3),
  RETRY_MAX_DELAY_MS: posInt(120_000),
  RETRY_JITTER: z.coerce.number().min(0).max(1).default(0.25),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}
