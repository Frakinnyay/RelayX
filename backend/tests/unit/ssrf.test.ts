import { isBlockedAddress, validateWebhookUrl } from '../../src/domain/ssrf';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', 'ff02::1', 'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe('validateWebhookUrl (production mode)', () => {
  it('accepts a normal https URL', () => expect(validateWebhookUrl('https://example.com/hooks/1', false).ok).toBe(true));

  it.each([
    'http://example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://10.0.0.5/x',
    'https://169.254.169.254/latest/meta-data', 'https://user:pw@example.com', 'ftp://example.com', 'file:///etc/passwd', 'nonsense', 'https://db.internal/x',
  ])('rejects %s', (u) => expect(validateWebhookUrl(u, false).ok).toBe(false));
});

describe('validateWebhookUrl (local demo mode)', () => {
  it('allows http to private addresses only when explicitly enabled', () => {
    expect(validateWebhookUrl('http://127.0.0.1:4000/webhook', true).ok).toBe(true);
    expect(validateWebhookUrl('http://receiver:4000/webhook', true).ok).toBe(true);
    expect(validateWebhookUrl('file:///etc/passwd', true).ok).toBe(false);
  });
});
