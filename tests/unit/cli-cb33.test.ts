import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/services/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
}));

import {
  NODE_INSTANCE,
  binariesFor,
  daemonCallArgs,
  homePathsFor,
  isCb33InitHelp,
  nodeCommandFor,
  translateArgs,
} from '../../src/main/services/cli-layout';
import { clearLayoutCache, cliLayoutOf, type ProbeTarget } from '../../src/main/services/cli-probe';
import { modulesFor, sourceKind } from '../../src/main/services/image-source';

// ─── cb33 (public sentinel-solana 26de5240) command-line layout ───
// CB33_INIT_HELP is `sentinel-dvpnd init --help` captured from an image built from
// public 26de5240 (2026-11-07).

const CB33_INIT_HELP = [
  'create the instance folder, config and operator key',
  '',
  'Usage:',
  '  sentinel-dvpnd init [flags]',
  '',
  'Flags:',
  '      --api-hosts strings              public api hosts (node, provider)',
  '      --api-port uint16                public api port (node, provider); 0 picks a free port for a node and keeps 8443 for a provider',
  '      --country string                 two-letter country code (node)',
  '      --force                          overwrite an existing instance',
  '  -h, --help                           help for init',
  '      --new-key                        replace the existing operator key',
  '      --owner string                   owner public key (base58)',
  '      --peer-allow-private             allow node and provider endpoints on private addresses',
  '      --plain-key                      write an unencrypted key file',
  '      --prices.channel-per-gb uint     per-gb channel price in base units, as for sentinel-dvpn node open-node (node)',
  '      --prices.channel-per-hour uint   per-hour channel price in base units, as for sentinel-dvpn node open-node (node)',
  '      --prices.lease-per-hour uint     per-hour lease price in base units, as for sentinel-dvpn node open-node (node)',
  '      --service string                 service driver the node serves; init saves every driver config (default "wireguard")',
  '',
  'Global Flags:',
  '      --home string    instance folder override for tests and development',
  '      --instance tag   daemon instance tag: c<N>, n<N> or p<N>',
].join('\n');

/** Every flag translateArgs gives cb33 init must be one the captured help lists. */
function helpFlags(help: string): Set<string> {
  return new Set([...help.matchAll(/--([a-z][a-z0-9.-]*)/g)].map((m) => `--${m[1]}`));
}

const NEWER_INIT_HELP = '      --api-hosts strings   public api hosts (node, provider)\n      --role string  role';
const OLDER_INIT_HELP = '      --api-addrs strings   public api addresses (node, provider)\n      --role string  role';

describe('cb33 layout helpers', () => {
  it('names the cb33 binaries and keeps the older names for the older layouts', () => {
    expect(binariesFor('cb33')).toEqual({ daemon: 'sentinel-dvpnd', ctl: 'sentinel-dvpn' });
    expect(binariesFor('newer')).toEqual({ daemon: 'dvpnd', ctl: 'dvpnctl' });
    expect(binariesFor('older')).toEqual({ daemon: 'dvpnd', ctl: 'dvpnctl' });
  });

  it('uses the flat cb33 home: one config.toml, keys/, <service>/config.toml', () => {
    const p = homePathsFor('cb33');
    expect(p.nodeConfig).toBe('config.toml');
    expect(p.topConfig).toBe('config.toml');
    expect(p.keysDir).toBe('keys');
    expect(p.serviceConfig('wireguard')).toBe('wireguard/config.toml');
    const old = homePathsFor('newer');
    expect([old.nodeConfig, old.topConfig, old.keysDir, old.serviceConfig('v2ray')]).toEqual([
      'node/config.toml', 'config.toml', 'node/keys', 'node/v2ray/config.toml',
    ]);
  });

  it('starts cb33 with run --instance and the older layouts with start', () => {
    expect(nodeCommandFor('cb33', '/root/.dvpnd')).toEqual(['run', '--instance', NODE_INSTANCE, '--home', '/root/.dvpnd']);
    expect(nodeCommandFor('older', '/root/.dvpnd')).toEqual(['start', '--home', '/root/.dvpnd']);
  });

  it('recognises cb33 init help only on success with --instance and --owner', () => {
    expect(isCb33InitHelp(0, CB33_INIT_HELP)).toBe(true);
    expect(isCb33InitHelp(127, 'exec: "sentinel-dvpnd": executable file not found in $PATH')).toBe(false);
    expect(isCb33InitHelp(0, NEWER_INIT_HELP)).toBe(false);
  });
});

describe('translateArgs for cb33', () => {
  const init = [
    'init', '--role', 'node', '--home', '/root/.dvpnd', '--force',
    '--owner', 'OWNER', '--country', 'DE',
    '--api-addrs', '1.2.3.4', '--api-port', '7777',
    '--prices.channel-price-per-gb', '2000', '--prices.channel-price-per-hour', '1000', '--prices.lease-price-per-hour', '1000',
    '--service', 'wireguard', '--plain-key',
  ];

  it('drops --role, renames the newer flags and adds --instance n1', () => {
    const out = translateArgs('dvpnd', init, 'cb33');
    expect(out).not.toContain('--role');
    expect(out).not.toContain('node');
    expect(out).toContain('--api-hosts');
    expect(out).toContain('--prices.channel-per-gb');
    expect(out.slice(-2)).toEqual(['--instance', 'n1']);
    expect(out.slice(0, 4)).toEqual(['init', '--home', '/root/.dvpnd', '--force']);
  });

  it('passes cb33 init only flags its real --help lists', () => {
    const known = helpFlags(CB33_INIT_HELP);
    const unknown = translateArgs('dvpnd', init, 'cb33').filter((a) => a.startsWith('--') && !known.has(a.split('=')[0]));
    expect(unknown).toEqual([]);
  });

  it('drops the --role=node form too', () => {
    expect(translateArgs('dvpnd', ['init', '--role=node', '--owner', 'X'], 'cb33')).toEqual(['init', '--owner', 'X', '--instance', 'n1']);
  });

  it('keeps --role for the newer layout (the old daemon needs it)', () => {
    expect(translateArgs('dvpnd', init, 'newer')).toContain('--role');
  });

  it('renames chain-command flags exactly as for the newer layout', () => {
    const bond = ['node', 'withdraw-node-bond', '--node-unbonding', 'U', '--rent-payer', 'O'];
    expect(translateArgs('dvpnctl', bond, 'cb33')).toEqual(translateArgs('dvpnctl', bond, 'newer'));
    const open = ['node', 'open-node', '--node-id', 'ab', '--rent-payer', 'O'];
    expect(translateArgs('dvpnctl', open, 'cb33')).toEqual(open);
  });
});

// FS36 S13 run 1: every cb33 daemon call failed with `required flag(s) "instance" not set`.
describe('daemonCallArgs', () => {
  it('adds --instance n1 to cb33 daemon calls, after the command words', () => {
    expect(daemonCallArgs(['node', 'sessions'], 'cb33')).toEqual(['node', 'sessions', '--instance', 'n1']);
    expect(daemonCallArgs(['node', 'session', 'abc'], 'cb33')).toEqual(['node', 'session', 'abc', '--instance', 'n1']);
    expect(daemonCallArgs(['daemon', 'status'], 'cb33')).toEqual(['daemon', 'status', '--instance', 'n1']);
  });

  it('takes another instance tag when given one', () => {
    expect(daemonCallArgs(['client', 'status', 'x'], 'cb33', 'c1').slice(-2)).toEqual(['--instance', 'c1']);
  });

  it('never adds --instance for the older CLIs (they have no such flag)', () => {
    expect(daemonCallArgs(['node', 'redeem'], 'newer')).toEqual(['node', 'redeem']);
    expect(daemonCallArgs(['node', 'redeem'], 'older')).toEqual(['node', 'redeem']);
  });
});

// ─── Probe: which layout a node image speaks ───

function fakeImage(answers: Record<string, { exitCode: number; output: string }>): ProbeTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: 'local',
    label: 'this computer',
    imageTag: `node-manager/dvpnd:test-${Math.random().toString(16).slice(2)}`,
    calls,
    runOnce: async (entrypoint: string[]) => {
      calls.push(entrypoint[0]);
      return answers[entrypoint[0]] ?? { exitCode: 127, output: `exec: "${entrypoint[0]}": executable file not found in $PATH` };
    },
  } as ProbeTarget & { calls: string[] };
}

describe('cliLayoutOf', () => {
  beforeEach(() => clearLayoutCache());

  it('finds a cb33 image from sentinel-dvpnd and never asks dvpnd', async () => {
    const rt = fakeImage({ 'sentinel-dvpnd': { exitCode: 0, output: CB33_INIT_HELP } });
    expect(await cliLayoutOf(rt)).toBe('cb33');
    expect(rt.calls).toEqual(['sentinel-dvpnd']);
  });

  it('falls back to dvpnd on an older image', async () => {
    const newer = fakeImage({ dvpnd: { exitCode: 0, output: NEWER_INIT_HELP } });
    expect(await cliLayoutOf(newer)).toBe('newer');
    expect(newer.calls).toEqual(['sentinel-dvpnd', 'dvpnd']);
    const older = fakeImage({ dvpnd: { exitCode: 0, output: OLDER_INIT_HELP } });
    expect(await cliLayoutOf(older)).toBe('older');
  });

  it('asks once per host + image', async () => {
    const rt = fakeImage({ 'sentinel-dvpnd': { exitCode: 0, output: CB33_INIT_HELP } });
    await cliLayoutOf(rt);
    await cliLayoutOf(rt);
    expect(rt.calls).toHaveLength(1);
  });

  it('refuses an image it cannot place instead of guessing', async () => {
    const rt = fakeImage({ dvpnd: { exitCode: 1, output: 'error: unknown command "init"' } });
    await expect(cliLayoutOf(rt)).rejects.toThrow(/cannot tell the dvpnd version/);
  });

  it('reports a cancel as a cancel', async () => {
    const rt = fakeImage({ 'sentinel-dvpnd': { exitCode: -1, output: '' } });
    await expect(cliLayoutOf(rt)).rejects.toThrow(/Cancelled/);
  });
});

// ─── Image source: which tree Settings.upstreamDir holds ───

describe('sourceKind', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'snm-kind-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (rel: string): Promise<void> => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), 'module x\n');
  };

  it('reads a 26de5240-shaped tree as cb33 and ships sentinel-dvpn', async () => {
    for (const m of ['sentinel-go-sdk', 'sentinel-programs/clients/go', 'sentinel-dvpnd', 'sentinel-dvpn']) await put(`${m}/go.mod`);
    expect(await sourceKind(dir)).toBe('cb33');
    expect(modulesFor('cb33')).toContain('sentinel-dvpn');
    expect(modulesFor('cb33')).not.toContain('sentinel-dvpnctl');
  });

  it('reads a tree with sentinel-dvpnctl as legacy', async () => {
    for (const m of ['sentinel-go-sdk', 'sentinel-programs/clients/go', 'sentinel-dvpnd', 'sentinel-dvpnctl']) await put(`${m}/go.mod`);
    expect(await sourceKind(dir)).toBe('legacy');
    expect(modulesFor('legacy')).toContain('sentinel-dvpnctl');
  });
});
