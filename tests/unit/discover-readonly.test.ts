import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';

// ─── nodes.discover --wallet <address>: read-only scan (NM032 S10b) ───
// Lets support or a test scan any wallet's history (e.g. a long one) without importing its key.
// It must never touch the app's own data: no discoveredNodes write, no store write at all.

const APP_WALLET = Keypair.generate().publicKey.toBase58();
const OTHER_WALLET = Keypair.generate().publicKey.toBase58();

const state = { store: { wallet: { address: APP_WALLET }, nodes: [] as unknown[], discoveredNodes: undefined as unknown } };
const writeStore = vi.fn(async (s: typeof state.store) => {
  state.store = s;
});
const scanned: string[] = [];

vi.mock('../../src/main/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/services/store', () => ({
  readStore: async () => JSON.parse(JSON.stringify(state.store)),
  writeStore: (s: typeof state.store) => writeStore(s),
}));
vi.mock('../../src/main/services/solana-client', () => ({
  RPC_QUERY_TIMEOUT_MS: 1000,
  withRetry: (fn: () => Promise<unknown>) => fn(),
  withRpcTimeout: (fn: () => Promise<unknown>) => fn(),
  connection: async () => ({
    getSignaturesForAddress: async (key: { toBase58(): string }) => {
      scanned.push(key.toBase58());
      return []; // an empty history is enough: the question is where the result goes
    },
  }),
}));

const { discoverFromWallet } = await import('../../src/main/services/recovery');

beforeEach(() => {
  writeStore.mockClear();
  scanned.length = 0;
});

describe('discover --wallet (read only)', () => {
  it('scans the given address and writes nothing', async () => {
    const r = await discoverFromWallet(undefined, { wallet: OTHER_WALLET });
    expect(scanned).toEqual([OTHER_WALLET]);
    expect(r.found).toEqual([]);
    expect(writeStore).not.toHaveBeenCalled();
  });

  it('control: the normal scan uses the app wallet and saves its result', async () => {
    await discoverFromWallet();
    expect(scanned).toEqual([APP_WALLET]);
    expect(writeStore).toHaveBeenCalledTimes(1);
  });

  it('a malformed address is refused before any RPC call', async () => {
    await expect(discoverFromWallet(undefined, { wallet: 'not-an-address' })).rejects.toThrow();
    expect(scanned).toEqual([]);
  });
});
