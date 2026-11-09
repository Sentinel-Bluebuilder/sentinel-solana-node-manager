import { log } from './logger';
import { isPublicIPv4 } from './validate';

interface GeoipResult {
  country: string;
  countryName: string;
}

const cache = new Map<string, GeoipResult>();

/**
 * Resolve a host / IP to an ISO-3166-1 alpha-2 country code using the free
 * https://ipwho.is/ endpoint (no API key, no rate-limit headers in normal
 * use). Falls back to undefined on any failure — callers must handle that.
 * Results are cached per-process.
 */
export async function resolveCountry(host: string): Promise<GeoipResult | undefined> {
  const key = host.trim().toLowerCase();
  if (!key) return undefined;
  if (cache.has(key)) return cache.get(key);

  // Skip obviously private / loopback literals — they will just return a
  // private-network error and waste a request.
  if (
    key === 'localhost' ||
    key.startsWith('127.') ||
    key.startsWith('10.') ||
    key.startsWith('192.168.') ||
    key.startsWith('172.16.') ||
    key.startsWith('172.17.') ||
    key.startsWith('172.18.') ||
    key.startsWith('172.19.') ||
    key.startsWith('172.2') ||
    key.startsWith('172.30.') ||
    key.startsWith('172.31.')
  ) {
    return undefined;
  }

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(key)}`, {
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      success?: boolean;
      country_code?: string;
      country?: string;
    };
    if (!body.success || !body.country_code) return undefined;
    const out: GeoipResult = {
      country: body.country_code.toUpperCase(),
      countryName: body.country ?? body.country_code.toUpperCase(),
    };
    cache.set(key, out);
    return out;
  } catch (err) {
    log.debug('geoip lookup failed', { host: key, err: (err as Error).message });
    return undefined;
  }
}

/**
 * This machine's public IPv4, for a local deploy without an explicit host: the same ipwho.is
 * call as resolveOwnCountry (no new service contacted), then checkip.amazonaws.com. Undefined
 * when neither answers with a public IPv4 within 5 s each.
 */
export async function resolveOwnPublicIp(): Promise<string | undefined> {
  const sources: Array<[string, (r: Response) => Promise<string | undefined>]> = [
    ['https://ipwho.is/', async (r) => ((await r.json()) as { ip?: string }).ip],
    ['https://checkip.amazonaws.com/', async (r) => (await r.text()).trim()],
  ];
  for (const [url, read] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const ip = await read(res);
      if (ip && isPublicIPv4(ip)) return ip;
    } catch (err) {
      log.debug('public IP lookup failed', { url, err: (err as Error).message });
    }
  }
  return undefined;
}

/** Country of this machine's public IP (ipwho.is with no argument = caller). */
export async function resolveOwnCountry(): Promise<GeoipResult | undefined> {
  const key = '__self__';
  if (cache.has(key)) return cache.get(key);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch('https://ipwho.is/', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { success?: boolean; country_code?: string; country?: string };
    if (!body.success || !body.country_code) return undefined;
    const out: GeoipResult = { country: body.country_code.toUpperCase(), countryName: body.country ?? body.country_code };
    cache.set(key, out);
    return out;
  } catch (err) {
    log.debug('own geoip lookup failed', { err: (err as Error).message });
    return undefined;
  }
}
