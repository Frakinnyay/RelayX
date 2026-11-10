const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const secured = [{ bearerAuth: [] }];

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'RelayX API',
    version: '1.0.0',
    description:
      'Reliable webhook delivery. At-least-once: receivers must deduplicate using the event id (X-RelayX-Event-Id) or idempotency key.\n\n' +
      '**Auth:** `Authorization: Bearer <api-key>`.\n\n' +
      '**Rate limit:** POST /events is limited per tenant per minute (fixed window). Responses carry X-RateLimit-* headers; over the limit you get 429 + Retry-After.\n\n' +
      '**Idempotency:** send `idempotencyKey` in the body or an `Idempotency-Key` header. Same key + same body returns the original event (HTTP 200, `idempotentReplay: true`). Same key + different body returns 409.\n\n' +
      '**Signatures:** each delivery carries `X-RelayX-Timestamp` and `X-RelayX-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`.',
  },
  servers: [{ url: 'http://localhost:3000' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'INVALID_REQUEST' },
              message: { type: 'string' },
              details: {},
              requestId: { type: 'string' },
            },
          },
        },
      },
      CreateEvent: {
        type: 'object',
        required: ['eventType', 'endpointId', 'payload'],
        properties: {
          eventType: { type: 'string', example: 'order.created' },
          endpointId: { type: 'string', format: 'uuid' },
          payload: { type: 'object', example: { orderId: '123', amount: 1499 } },
          metadata: { type: 'object' },
          idempotencyKey: { type: 'string', maxLength: 255 },
        },
      },
      DeliveryStatus: { type: 'string', enum: ['PENDING', 'PROCESSING', 'RETRY_WAITING', 'SUCCESS', 'DEAD_LETTERED'] },
    },
  },
  paths: {
    '/health': { get: { summary: 'Liveness + database check', responses: { '200': { description: 'ok' }, '503': { description: 'database down' } } } },
    '/metrics': { get: { summary: 'Prometheus metrics', responses: { '200': { description: 'text/plain metrics' } } } },
    '/api/v1/tenants': {
      post: {
        summary: 'Create a tenant (admin). Returns the API key ONCE.',
        parameters: [{ name: 'X-Admin-Token', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, rateLimitPerMinute: { type: 'integer' } } } } } },
        responses: { '201': { description: 'Created' }, '401': errorResponse('Bad admin token'), '503': errorResponse('Admin disabled') },
      },
    },
    '/api/v1/api-keys/rotate': {
      post: { summary: 'Issue a new API key and revoke the one used for this request', security: secured, responses: { '201': { description: 'New key (shown once)' }, '401': errorResponse('Unauthorized') } },
    },
    '/api/v1/stats': { get: { summary: 'Counts by delivery status', security: secured, responses: { '200': { description: 'ok' } } } },
    '/api/v1/endpoints': {
      post: {
        summary: 'Register a webhook endpoint. Secret returned once.',
        security: secured,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, description: { type: 'string' }, secret: { type: 'string', minLength: 16 } } } } } },
        responses: { '201': { description: 'Created' }, '400': errorResponse('Invalid URL (SSRF protection) or body') },
      },
      get: { summary: 'List endpoints', security: secured, responses: { '200': { description: 'ok' } } },
    },
    '/api/v1/endpoints/{id}': {
      get: { summary: 'Get endpoint', security: secured, parameters: [idParam], responses: { '200': { description: 'ok' }, '404': errorResponse('Not found') } },
      delete: { summary: 'Deactivate endpoint (soft delete)', security: secured, parameters: [idParam], responses: { '200': { description: 'ok' }, '404': errorResponse('Not found') } },
    },
    '/api/v1/events': {
      post: {
        summary: 'Ingest an event and enqueue its delivery',
        security: secured,
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateEvent' } } } },
        responses: {
          '202': { description: 'Accepted (new event)' },
          '200': { description: 'Idempotent replay of an earlier request' },
          '400': errorResponse('Validation error / unknown endpoint'),
          '401': errorResponse('Unauthorized'),
          '409': errorResponse('IDEMPOTENCY_KEY_REUSED'),
          '429': errorResponse('RATE_LIMITED'),
        },
      },
      get: {
        summary: 'List events with latest delivery status',
        security: secured,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/api/v1/events/{id}': {
      get: { summary: 'Event with all deliveries and attempts (timeline)', security: secured, parameters: [idParam], responses: { '200': { description: 'ok' }, '404': errorResponse('Not found') } },
    },
    '/api/v1/deliveries': {
      get: {
        summary: 'List deliveries (filter by status, e.g. DEAD_LETTERED)',
        security: secured,
        parameters: [{ name: 'status', in: 'query', schema: { $ref: '#/components/schemas/DeliveryStatus' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'offset', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/api/v1/deliveries/{id}': {
      get: { summary: 'Delivery with attempt history', security: secured, parameters: [idParam], responses: { '200': { description: 'ok' }, '404': errorResponse('Not found') } },
    },
    '/api/v1/deliveries/{id}/replay': {
      post: {
        summary: 'Create a NEW delivery for the same event (only for SUCCESS or DEAD_LETTERED deliveries)',
        security: secured,
        parameters: [idParam],
        responses: { '202': { description: 'New delivery queued' }, '404': errorResponse('Not found'), '409': errorResponse('INVALID_STATE') },
      },
    },
  },
};
