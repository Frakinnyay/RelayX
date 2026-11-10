import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c.PORT).toBe(3000);
    expect(c.MAX_ATTEMPTS).toBe(6);
    expect(c.ALLOW_PRIVATE_WEBHOOK_TARGETS).toBe(false);
  });
  it('fails early with a readable message when required values are missing or invalid', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'x', ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ DATABASE_URL: 'x', RETRY_JITTER: '3' })).toThrow(/RETRY_JITTER/);
    expect(() => loadConfig({ DATABASE_URL: 'x', ALLOW_PRIVATE_WEBHOOK_TARGETS: 'yes' })).toThrow(/ALLOW_PRIVATE/);
  });
});
