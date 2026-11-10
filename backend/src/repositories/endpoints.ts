import type { Db } from '../db/pool';
import { camelize } from '../util/camel';

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  description: string | null;
  active: boolean;
  createdAt: Date;
}

// The signing secret is deliberately excluded from every read except delivery.
const PUBLIC_COLUMNS = 'id, tenant_id, url, description, active, created_at';

export async function insertEndpoint(
  db: Db,
  p: { tenantId: string; url: string; description?: string; secret: string },
): Promise<WebhookEndpoint> {
  const r = await db.query(
    `INSERT INTO webhook_endpoints (tenant_id, url, description, secret) VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_COLUMNS}`,
    [p.tenantId, p.url, p.description ?? null, p.secret],
  );
  return camelize(r.rows[0]);
}

export async function listEndpoints(db: Db, tenantId: string): Promise<WebhookEndpoint[]> {
  const r = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at DESC`, [
    tenantId,
  ]);
  return r.rows.map((row) => camelize<WebhookEndpoint>(row));
}

export async function findEndpoint(db: Db, tenantId: string, id: string): Promise<WebhookEndpoint | null> {
  const r = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ? camelize<WebhookEndpoint>(r.rows[0]) : null;
}

export async function deactivateEndpoint(db: Db, tenantId: string, id: string): Promise<WebhookEndpoint | null> {
  const r = await db.query(
    `UPDATE webhook_endpoints SET active = false WHERE id = $1 AND tenant_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
    [id, tenantId],
  );
  return r.rows[0] ? camelize<WebhookEndpoint>(r.rows[0]) : null;
}
