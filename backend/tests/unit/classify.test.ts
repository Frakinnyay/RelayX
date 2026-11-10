import { classifyStatus } from '../../src/domain/classify';

describe('classifyStatus', () => {
  it.each([200, 201, 204])('%i is success', (c) => expect(classifyStatus(c)).toBe('SUCCESS'));
  it.each([400, 401, 403, 404, 410, 422, 301, 302])('%i is permanent', (c) => expect(classifyStatus(c)).toBe('PERMANENT_FAILURE'));
  it.each([408, 429, 500, 502, 503, 504])('%i is retryable', (c) => expect(classifyStatus(c)).toBe('RETRYABLE_FAILURE'));
});
