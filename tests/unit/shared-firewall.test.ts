import { describe, expect, it } from 'vitest';
import { portsHeldByOthers, sameHost, type FirewallHolder } from '../../src/main/services/validate';

// ─── A removal must not close a ufw rule another node on the same host still uses ───
// final4 remote run (2026-11-08): a new node reused ports 41000–41004 while the old node on
// that host was being removed; the old node's removal deleted the shared rule.

type N = FirewallHolder & { port: number };
const ports = (n: N): number[] => [0, 1, 2, 3, 4].map((i) => n.port + i);
const node = (id: string, over: Partial<N> = {}): N => ({
  id,
  target: 'remote',
  host: '203.0.113.7',
  firewallOpened: true,
  port: 41000,
  ...over,
});

describe('portsHeldByOthers', () => {
  it('another open node on the same host and ports holds them', () => {
    const old = node('old');
    const held = portsHeldByOthers(old, [old, node('new')], ports);
    expect([...held].sort()).toEqual([41000, 41001, 41002, 41003, 41004]);
  });
  it('the node itself never holds its own ports', () => {
    const only = node('only');
    expect(portsHeldByOthers(only, [only], ports).size).toBe(0);
  });
  it('a node on another host does not hold them', () => {
    const old = node('old');
    expect(portsHeldByOthers(old, [old, node('other', { host: '198.51.100.9' })], ports).size).toBe(0);
  });
  it('a node whose firewall rule is already closed does not hold them', () => {
    const old = node('old');
    expect(portsHeldByOthers(old, [old, node('new', { firewallOpened: false })], ports).size).toBe(0);
  });
  it('a local node does not hold a remote host\'s ports', () => {
    const old = node('old');
    expect(portsHeldByOthers(old, [old, node('loc', { target: 'local', host: undefined })], ports).size).toBe(0);
  });
  it('a different port block holds nothing in this one', () => {
    const old = node('old');
    const held = portsHeldByOthers(old, [old, node('new', { port: 42000 })], ports);
    expect(held.has(41000)).toBe(false);
  });
});

describe('sameHost', () => {
  it('two local nodes are on the same host', () => {
    expect(sameHost(node('a', { target: 'local', host: undefined }), node('b', { target: 'local', host: undefined }))).toBe(true);
  });
  it('remote nodes compare by host', () => {
    expect(sameHost(node('a'), node('b'))).toBe(true);
    expect(sameHost(node('a'), node('b', { host: '198.51.100.9' }))).toBe(false);
  });
});
