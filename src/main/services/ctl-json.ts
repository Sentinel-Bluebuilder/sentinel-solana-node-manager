// ─── dvpnctl JSON, older and newer layouts ───
// Pure helpers (no Electron) so unit tests can load them directly.
//
// Nodes deployed earlier keep their older image, so the app reads both:
//   older: camelCase keys; node_id / country / uri as byte arrays (+ uriLen);
//          params `paused`; unbonding `amount`
//   newer (ddv18.32 / 8d5b93c): snake_case keys; node_id as hex, country and uri as
//          text; params `paused_mask`; unbonding `bond`

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Every object key in snake_case becomes camelCase (camelCase keys stay as they are). */
export function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[camel(k)] = camelKeys(x);
    return out;
  }
  return v;
}

function isByteArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
}

/** A 32-byte id as hex, from a byte array (older) or a hex string (newer). */
export function idHex(v: unknown, what: string): string {
  if (typeof v === 'string' && /^[0-9a-f]+$/i.test(v)) return v.toLowerCase();
  if (isByteArray(v)) return Buffer.from(v).toString('hex');
  throw new Error(`dvpnctl returned an unreadable ${what}: ${JSON.stringify(v)?.slice(0, 80)}`);
}

/** Text from a string (newer) or a zero-padded byte array (older, with an optional length). */
export function fixedText(v: unknown, what: string, len?: number): string {
  if (typeof v === 'string') return v;
  if (isByteArray(v)) {
    const bytes = typeof len === 'number' ? v.slice(0, len) : v;
    return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '');
  }
  throw new Error(`dvpnctl returned an unreadable ${what}: ${JSON.stringify(v)?.slice(0, 80)}`);
}

/** The first of several names that holds a number (a field renamed between layouts). */
export function numberField(o: Record<string, unknown>, names: string[], what: string): number {
  for (const n of names) if (typeof o[n] === 'number') return o[n] as number;
  throw new Error(`dvpnctl returned no ${what} (looked for ${names.join(' / ')})`);
}
