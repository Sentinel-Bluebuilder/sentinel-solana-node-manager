import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── v0.3.3: which servers the Reconnect window offers ───
// v0.3.2 marked a server "connected" (hidden from the window) as soon as ONE of its nodes had a
// login, so its other nodes, or nodes found from the wallet on it, could never be reconnected, and
// the per-node Reconnect link opened with nothing to select and the button disabled.

let store: { nodes: unknown[]; discoveredNodes: unknown[] };
const withLogin = new Set<string>();

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/snm-recovery-servers', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../src/main/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/services/store', () => ({ readStore: async () => store, writeStore: async () => undefined }));
vi.mock('../../src/main/services/host-keys', () => ({ listKnownHosts: async () => [{ host: '198.51.100.9', port: 22 }] }));
vi.mock('../../src/main/services/node-manager', () => ({
  getSSH: (id: string) => (withLogin.has(id) ? { host: 'x', username: 'root' } : undefined),
  ensureNodePersisted: vi.fn(),
  listNodes: vi.fn(),
  reconnectHost: vi.fn(),
  rememberSSH: vi.fn(),
}));

const { recoveryServers } = await import('../../src/main/services/adopt');

const node = (id: string, host: string, sshPort = 22) => ({ id, host, sshPort, target: 'remote', operatorAddress: `op-${id}` });

beforeEach(() => {
  withLogin.clear();
  store = { nodes: [], discoveredNodes: [] };
});

describe('recoveryServers', () => {
  it('a server with one node reconnected and one still waiting stays offered', async () => {
    store.nodes = [node('a', '203.0.113.7'), node('b', '203.0.113.7')];
    withLogin.add('a');
    const s = (await recoveryServers()).find((x) => x.host === '203.0.113.7');
    expect(s).toMatchObject({ connected: false, listedWaiting: 1 });
  });

  it('a server with a login but a node found from the wallet on it stays offered', async () => {
    store.nodes = [node('a', '203.0.113.7')];
    store.discoveredNodes = [{ operatorAddress: 'op-new', host: '203.0.113.7' }];
    withLogin.add('a');
    const s = (await recoveryServers()).find((x) => x.host === '203.0.113.7');
    expect(s).toMatchObject({ connected: false, discovered: 1 });
  });

  it('control: every node on the server has its login → connected (nothing to do)', async () => {
    store.nodes = [node('a', '203.0.113.7'), node('b', '203.0.113.7')];
    withLogin.add('a');
    withLogin.add('b');
    const s = (await recoveryServers()).find((x) => x.host === '203.0.113.7');
    expect(s).toMatchObject({ connected: true, listedWaiting: 0 });
  });

  it('a known server with no nodes is offered but not connected; a custom SSH port is kept', async () => {
    store.nodes = [node('c', '192.0.2.5', 2222)];
    const all = await recoveryServers();
    expect(all.find((x) => x.host === '198.51.100.9')).toMatchObject({ connected: false, listedWaiting: 0, discovered: 0 });
    expect(all.find((x) => x.host === '192.0.2.5')).toMatchObject({ port: 2222, listedWaiting: 1 });
  });
});
