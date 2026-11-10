// ─── Protocol logos ───
// Every protocol tile on the deploy screen must name a logo file the app actually ships.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SCREEN = join(ROOT, 'src', 'renderer', 'src', 'screens', 'DeployLocal.tsx');
const PUBLIC_DIR = join(ROOT, 'src', 'renderer', 'public');

function protocolRows(): Array<{ id: string; logo: string | null }> {
  const src = readFileSync(SCREEN, 'utf8');
  const block = src.slice(src.indexOf('PROTOCOL_OPTIONS'), src.indexOf('];', src.indexOf('PROTOCOL_OPTIONS')));
  return [...block.matchAll(/\{ id: '([a-z0-9]+)'[^\n]*/g)].map((m) => {
    const logo = /logo: '([^']+)'/.exec(m[0]);
    return { id: m[1], logo: logo ? logo[1] : null };
  });
}

describe('deploy screen protocol logos', () => {
  const rows = protocolRows();

  it('lists all six protocols', () => {
    expect(rows.map((r) => r.id).sort()).toEqual(['amneziawg', 'hysteria2', 'openvpn', 'v2ray', 'wireguard', 'xray']);
  });

  it.each(rows)('$id has a logo file the app ships', ({ logo }) => {
    expect(logo).not.toBeNull();
    expect(existsSync(join(PUBLIC_DIR, (logo as string).replace(/^\.\//, '')))).toBe(true);
  });
});
