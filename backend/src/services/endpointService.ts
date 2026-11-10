import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config';
import { validateWebhookUrl } from '../domain/ssrf';
import { badRequest } from '../errors';
import { insertEndpoint, type WebhookEndpoint } from '../repositories/endpoints';

export async function createEndpoint(
  pool: Pool,
  config: Config,
  tenantId: string,
  input: { url: string; description?: string; secret?: string },
): Promise<WebhookEndpoint & { secret: string }> {
  const check = validateWebhookUrl(input.url, config.ALLOW_PRIVATE_WEBHOOK_TARGETS);
  if (!check.ok) throw badRequest('INVALID_WEBHOOK_URL', check.reason);
  const secret = input.secret ?? `whsec_${randomBytes(24).toString('base64url')}`;
  const endpoint = await insertEndpoint(pool, { tenantId, url: check.url.toString(), description: input.description, secret });
  // The secret is shown once, in this response only.
  return { ...endpoint, secret };
}
