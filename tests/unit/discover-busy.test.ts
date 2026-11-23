import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

// ─── Q0594: a busy RPC must not turn a removed node into a live one ───
// rc7: a 429 that outlasted the retries on the node-account lookup fell back to the history check,
// which counts any key that ever called the dvpn program as a node, so a removed node was listed
// "On chain". Now: busy → keep waiting, then list it as unverified (never via history); only an RPC
// that refuses the query uses the history check, and what that lists is unverified too.

const WALLET = Keypair.generate().publicKey.toBase58();
const OPERATOR = Keypair.generate().publicKey.toBase58();
const PDA = Keypair.generate().publicKey;

let mode: 'busy' | 'refused' | 'live' | 'gone' = 'busy';
const operatorHistoryCalls: string[] = [];

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/snm-busy-test', isPackaged: true }, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../../src/main/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/services/store', () => ({
  readStore: async () => ({ wallet: { address: WALLET }, nodes: [], discoveredNodes: [] }),
  writeStore: async () => undefined,
}));
vi.mock('../../src/main/services/solana-client', async () => {
  const real = await vi.importActual<typeof import('../../src/main/services/solana-client')>('../../src/main/services/solana-client');
  const { MEMO_PROGRAM, PROGRAM_ID } = await vi.importActual<typeof import('../../src/main/services/chain')>('../../src/main/services/chain');
  const sys = new PublicKey('11111111111111111111111111111111');
  return {
    RPC_QUERY_TIMEOUT_MS: 1000,
    isTransientRpcError: real.isTransientRpcError,
    withRetry: (fn: () => Promise<unknown>) => fn(),
    withRpcTimeout: (fn: () => Promise<unknown>) => fn(),
    connection: async () => ({
      getSignaturesForAddress: async (key: PublicKey) => {
        if (key.toBase58() === WALLET) return [{ signature: 'fund1', err: null, memo: '[10] fund node lost-node', blockTime: 1 }];
        operatorHistoryCalls.push(key.toBase58());
        return [{ signature: 'open1', err: null, memo: null, blockTime: 2 }];
      },
      getParsedTransaction: async (sig: string) => {
        if (sig === 'fund1') {
          return {
            meta: { err: null },
            transaction: {
              message: {
                instructions: [
                  { programId: sys, program: 'system', parsed: { type: 'transfer', info: { source: WALLET, destination: OPERATOR, lamports: 50_000_000 } } },
                  { programId: new PublicKey(MEMO_PROGRAM), program: 'spl-memo', parsed: 'fund node lost-node' },
                ],
              },
            },
          };
        }
        // The node key's own history: it called the dvpn program (true of a removed node too).
        return { meta: { err: null }, transaction: { message: { instructions: [{ programId: new PublicKey(PROGRAM_ID) }] } } };
      },
      getProgramAccounts: async () => {
        if (mode === 'busy') throw new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429}}');
        if (mode === 'refused') throw new Error('failed to get accounts: Method not found');
        if (mode === 'gone') return [];
        return [{ pubkey: PDA, account: { data: Buffer.from('https://203.0.113.7:41000') } }];
      },
    }),
  };
});

const recovery = await import('../../src/main/services/recovery');
recovery.LIVE_LOOKUP_BACKOFF_MS.splice(0, recovery.LIVE_LOOKUP_BACKOFF_MS.length, 0, 0);

beforeEach(() => {
  operatorHistoryCalls.length = 0;
});

describe('find my nodes when the RPC is busy (Q0594)', () => {
  it('busy through every round: listed as NOT verified, and the history check is never used', async () => {
    mode = 'busy';
    const r = await recovery.discoverFromWallet();
    expect(r.found).toHaveLength(1);
    expect(r.found[0].unverified).toBe(true);
    expect(r.found[0].nodePda).toBeUndefined();
    expect(operatorHistoryCalls).toEqual([]);
  });

  it('an RPC that refuses the query falls back to history; what it lists is unverified', async () => {
    mode = 'refused';
    const r = await recovery.discoverFromWallet();
    expect(operatorHistoryCalls).toEqual([OPERATOR]);
    expect(r.found).toHaveLength(1);
    expect(r.found[0].unverified).toBe(true);
  });

  it('control: the account answers → verified, with its PDA and host', async () => {
    mode = 'live';
    const r = await recovery.discoverFromWallet();
    expect(r.found[0].unverified).toBe(false);
    expect(r.found[0].nodePda).toBe(PDA.toBase58());
    expect(r.found[0].host).toBe('203.0.113.7');
  });

  it('control: no account → not listed (removed node)', async () => {
    mode = 'gone';
    const r = await recovery.discoverFromWallet();
    expect(r.found).toEqual([]);
    expect(r.fundedOnly).toBe(1);
  });
});
