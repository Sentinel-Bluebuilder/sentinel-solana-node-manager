import { protocolInfo, type ServiceType } from './chain';

/**
 * Pure, line-oriented patchers for the files `dvpnd init` renders under a
 * node home. We edit only the keys we own and leave every other line exactly
 * as dvpnd wrote it (re-serialising would re-type floats and durations).
 *
 *   <home>/config.toml               [rpc] url / ws_url
 *   <home>/node/config.toml          service, country, [api], [prices], [redeem]
 *   <home>/node/<service>/config.toml   public listen port(s); REALITY stripped
 *
 * Layout verified against the devnet image (`dvpnd init --role node`).
 */

type Value = string | number | boolean | string[];

function tomlValue(v: Value): string {
  if (Array.isArray(v)) return `[${v.map((x) => tomlValue(x)).join(', ')}]`;
  if (typeof v === 'string') {
    // TOML literal strings cannot carry ' or control characters; refuse rather than corrupt the file.
    if (/['\u0000-\u001f\u007f]/.test(v)) throw new Error(`TOML value contains a quote or control character: ${JSON.stringify(v)}`);
    return `'${v}'`;
  }
  return String(v);
}

/** Section header of a line, or null. `[[x]]` returns `[[x]]`. */
function headerOf(line: string): string | null {
  const t = line.trim();
  const m = /^(\[\[?)([^\]]+)(\]\]?)\s*(#.*)?$/.exec(t);
  if (!m) return null;
  return m[1] === '[[' ? `[[${m[2].trim()}]]` : m[2].trim();
}

/**
 * Set `key = value` inside `section` ('' = top level). Replaces the existing
 * line or appends it at the end of the section (creating the section).
 */
export function setKey(toml: string, section: string, key: string, value: Value): string {
  const lines = toml.split('\n');
  let current = '';
  let sectionEnd = section === '' ? -1 : -2;
  let firstHeader = -1;
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    const h = headerOf(lines[i]);
    if (h !== null) {
      if (firstHeader < 0) firstHeader = i;
      current = h;
      if (h === section) sectionEnd = i; // an empty section still ends somewhere: never re-create its header
      continue;
    }
    if (current === section) {
      if (keyRe.test(lines[i])) {
        lines[i] = `${key} = ${tomlValue(value)}`;
        return lines.join('\n');
      }
      if (lines[i].trim() !== '') sectionEnd = i;
    }
  }
  const newLine = `${key} = ${tomlValue(value)}`;
  if (section === '') {
    const at = firstHeader < 0 ? lines.length : firstHeader;
    lines.splice(at, 0, newLine);
    return lines.join('\n');
  }
  if (sectionEnd === -2) {
    // Section absent: append it.
    const tail = lines.length && lines[lines.length - 1] === '' ? '' : '\n';
    return `${lines.join('\n')}${tail}\n[${section}]\n${newLine}\n`;
  }
  // Section present but key absent: insert after its last non-empty line,
  // or right after the header when the section is empty.
  let insertAt = sectionEnd + 1;
  if (sectionEnd < 0) {
    insertAt = lines.findIndex((l) => headerOf(l) === section) + 1;
  }
  lines.splice(insertAt, 0, newLine);
  return lines.join('\n');
}

/** Read a scalar `key` from `section` ('' = top level). Strings unquoted. */
export function getKey(toml: string, section: string, key: string): string | undefined {
  let current = '';
  for (const line of toml.split('\n')) {
    const h = headerOf(line);
    if (h !== null) {
      current = h;
      continue;
    }
    if (current !== section) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

// ─── node/config.toml ───

export interface NodeConfigPatch {
  service?: ServiceType;
  country?: string;
  apiAddrs?: string[];
  apiPort?: number;
  /** Base units. */
  prices?: { perGb: number; perHour: number; leasePerHour: number };
  redeemThreshold?: number;
  /** `[handshake_dns] enabled`: the daemon runs hnsd (HNS resolver) when true. */
  handshakeDns?: boolean;
}

/**
 * The name a key has in this file: the first of `names` already present in
 * `section`, else the first (older) name. Newer dvpnd (ddv18.32+) renamed
 * [api] addrs → hosts and [redeem] threshold → threshold_base_units; writing the
 * older name into a newer file adds a key the daemon does not read.
 */
function keyIn(toml: string, section: string, names: string[]): string {
  return names.find((n) => getKey(toml, section, n) !== undefined) ?? names[0];
}

export function patchNodeConfig(toml: string, p: NodeConfigPatch): string {
  let out = toml;
  if (p.service) out = setKey(out, '', 'service', p.service);
  if (p.country) out = setKey(out, '', 'country', p.country.toUpperCase());
  if (p.apiAddrs) out = setKey(out, 'api', keyIn(out, 'api', ['addrs', 'hosts']), p.apiAddrs);
  if (p.apiPort !== undefined) out = setKey(out, 'api', 'port', p.apiPort);
  if (p.prices) {
    out = setKey(out, 'prices', 'channel_per_gb', Math.round(p.prices.perGb));
    out = setKey(out, 'prices', 'channel_per_hour', Math.round(p.prices.perHour));
    out = setKey(out, 'prices', 'lease_per_hour', Math.round(p.prices.leasePerHour));
  }
  if (p.redeemThreshold !== undefined) out = setKey(out, 'redeem', keyIn(out, 'redeem', ['threshold', 'threshold_base_units']), p.redeemThreshold);
  if (p.handshakeDns !== undefined) out = setKey(out, 'handshake_dns', 'enabled', p.handshakeDns);
  return out;
}

// ─── <home>/config.toml ───

export function patchTopConfig(toml: string, rpcUrl: string): string {
  const ws = rpcUrl.replace(/^http/, 'ws');
  return setKey(setKey(toml, 'rpc', 'url', rpcUrl), 'rpc', 'ws_url', ws);
}

// ─── node/<service>/config.toml ───

interface Block {
  header: string | null;
  lines: string[];
}

function splitBlocks(toml: string): Block[] {
  const blocks: Block[] = [{ header: null, lines: [] }];
  for (const line of toml.split('\n')) {
    const h = headerOf(line);
    if (h !== null) blocks.push({ header: h, lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}

/**
 * Pin a service's public listener(s) to `ports` (in order) and strip REALITY
 * inbounds (they carry no traffic in this build). Returns the patched file
 * and the ports actually used. Internal ports (api/management/auth/stats)
 * are left alone — they bind inside the container and are never published.
 */
export function pinServicePorts(
  type: ServiceType,
  toml: string,
  ports: number[],
): { toml: string; publicPorts: number[] } {
  const info = protocolInfo(type);
  if (info.portLayout === 'listen_port') {
    if (ports.length < 1) throw new Error(`No port available for ${type}.`);
    return { toml: setKey(toml, '', 'listen_port', ports[0]), publicPorts: [ports[0]] };
  }

  // inbounds: drop `[[inbounds]]` blocks with security = 'reality' together
  // with their `[inbounds.reality]` sub-table, then renumber the survivors.
  const blocks = splitBlocks(toml);
  const kept: Block[] = [];
  let dropping = false;
  for (const b of blocks) {
    if (b.header === '[[inbounds]]') {
      dropping = b.lines.some((l) => /^\s*security\s*=\s*['"]reality['"]/.test(l));
      if (!dropping) kept.push(b);
      continue;
    }
    if (b.header !== null && b.header.startsWith('inbounds.')) {
      if (!dropping) kept.push(b);
      continue;
    }
    dropping = false;
    kept.push(b);
  }
  const inbounds = kept.filter((b) => b.header === '[[inbounds]]');
  if (inbounds.length === 0) throw new Error(`${type} config has no non-REALITY inbound to serve.`);
  if (inbounds.length > ports.length) {
    throw new Error(`${type} needs ${inbounds.length} ports but only ${ports.length} are free in the node's block.`);
  }
  const used: number[] = [];
  inbounds.forEach((b, i) => {
    b.lines = b.lines.map((l) => (/^\s*port\s*=/.test(l) ? `port = ${ports[i]}` : l));
    used.push(ports[i]);
  });
  const text = kept.map((b) => b.lines.join('\n')).join('\n').replace(/\n{3,}/g, '\n\n');
  return { toml: text, publicPorts: used };
}

/** Public ports currently configured for a service (for publishing on restart). */
export function servicePublicPorts(type: ServiceType, toml: string): number[] {
  const info = protocolInfo(type);
  if (info.portLayout === 'listen_port') {
    const v = getKey(toml, '', 'listen_port');
    return v ? [Number(v)] : [];
  }
  const out: number[] = [];
  for (const b of splitBlocks(toml)) {
    if (b.header !== '[[inbounds]]') continue;
    const line = b.lines.find((l) => /^\s*port\s*=/.test(l));
    if (line) out.push(Number(line.split('=')[1].trim()));
  }
  return out;
}

/** Ports in a node's block: api first, then the service listeners. */
export function blockPorts(base: number, size: number): { api: number; service: number[] } {
  const all = Array.from({ length: size }, (_, i) => base + i);
  return { api: all[0], service: all.slice(1) };
}
