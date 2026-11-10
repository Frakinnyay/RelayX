import dns from 'node:dns';
import net from 'node:net';

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => Number.isNaN(n) || n > 255) ? null : nums;
}

function isBlockedIPv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||        // carrier-grade NAT
    (a === 169 && b === 254) ||                  // link-local + cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224                                     // multicast, reserved, broadcast
  );
}

function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] as number) << 8) | (v4[1] as number);
    const lo = ((v4[2] as number) << 8) | (v4[3] as number);
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? (halves[0] as string).split(':') : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  }
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

/** True if the address must NOT be contacted. Unparseable input is blocked (fail closed). */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const o = parseIPv4(ip);
    return o === null || isBlockedIPv4(o);
  }
  if (family === 6) {
    const n = parseIPv6(ip);
    if (!n) return true;
    const [n0, n1, n2, n3, n4, n5, n6, n7] = n as [number, number, number, number, number, number, number, number];
    if (n.every((x) => x === 0)) return true;                                   // ::
    if (n.slice(0, 7).every((x) => x === 0) && n7 === 1) return true;           // ::1
    if (n0 === 0 && n1 === 0 && n2 === 0 && n3 === 0 && n4 === 0 && n5 === 0xffff) {
      return isBlockedIPv4([n6 >> 8, n6 & 255, n7 >> 8, n7 & 255]);            // ::ffff:a.b.c.d
    }
    if (n0 === 0x64 && n1 === 0xff9b) return true;                              // NAT64
    if (n.slice(0, 6).every((x) => x === 0)) return true;                       // IPv4-compatible
    return (
      (n0 & 0xfe00) === 0xfc00 ||     // fc00::/7 unique local
      (n0 & 0xffc0) === 0xfe80 ||     // fe80::/10 link-local
      (n0 & 0xff00) === 0xff00 ||     // multicast
      (n0 === 0x2001 && n1 === 0x0db8) // documentation
    );
  }
  return true;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Static checks on a webhook URL (create time AND again right before each delivery).
 * Production default: https only, no credentials, no localhost / private IP literals.
 * allowPrivate=true is for local demos only (the receiver simulator lives on a private address).
 */
export function validateWebhookUrl(raw: string, allowPrivate: boolean): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL is not valid' };
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    return { ok: false, reason: allowPrivate ? 'Only http and https URLs are allowed' : 'Only https URLs are allowed' };
  }
  if (url.username || url.password) return { ok: false, reason: 'Credentials in the URL are not allowed' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'URL has no host' };
  if (!allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      return { ok: false, reason: 'Host is not allowed' };
    }
    if (net.isIP(host) && isBlockedAddress(host)) {
      return { ok: false, reason: 'Private or reserved IP addresses are not allowed' };
    }
  }
  return { ok: true, url };
}

/**
 * DNS lookup used by the HTTP client. It resolves the name, rejects private results, and hands the
 * validated IP to the socket, so a DNS-rebinding attacker cannot swap the address after validation.
 */
export function createGuardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      type Cb = (e: NodeJS.ErrnoException | null, a?: string | dns.LookupAddress[], f?: number) => void;
      const cb = callback as unknown as Cb;
      if (err) return cb(err);
      const list = addresses as dns.LookupAddress[];
      const allowed = allowPrivate ? list : list.filter((a) => !isBlockedAddress(a.address));
      if (allowed.length === 0) {
        const e: NodeJS.ErrnoException = new Error('BLOCKED_ADDRESS: host resolves to a private or reserved address');
        e.code = 'EBLOCKED';
        return cb(e);
      }
      if (options.all) return cb(null, allowed);
      const first = allowed[0] as dns.LookupAddress;
      return cb(null, first.address, first.family);
    });
  };
}
