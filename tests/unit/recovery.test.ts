import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

// ─── NM032: find nodes from the wallet + rebuild a node from its server ───

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`ENC:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^ENC:/, ''),
  },
}));
vi.mock('../../src/main/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const { monikerFromSignatureMemo, fundingFromParsedTx, programCheckVerdict } = await import('../../src/main/services/recovery');
const { buildAdoptedNode, classifySshFailure, hostFromUri } = await import('../../src/main/services/adopt');
const { encodeKeypairBackup, decodeBackup, keypairFromBackup, isKeypairBackup } = await import('../../src/main/services/node-backup');
const { keypairToJson } = await import('../../src/main/services/keys');
const { MEMO_PROGRAM } = await import('../../src/main/services/chain');

const WALLET = Keypair.generate().publicKey.toBase58();
const OPERATOR = Keypair.generate().publicKey.toBase58();

function fundTx(opts: { memo?: string; source?: string; destination?: string; err?: unknown }) {
  const ixs: unknown[] = [
    { programId: new PublicKey('11111111111111111111111111111111'), program: 'system', parsed: { type: 'transfer', info: { source: opts.source ?? WALLET, destination: opts.destination ?? OPERATOR, lamports: 50_000_000 } } },
  ];
  if (opts.memo !== undefined) ixs.push({ programId: new PublicKey(MEMO_PROGRAM), program: 'spl-memo', parsed: opts.memo });
  return { meta: { err: opts.err ?? null }, transaction: { message: { instructions: ixs } } } as never;
}

describe('monikerFromSignatureMemo (getSignaturesForAddress memo field)', () => {
  it('reads the moniker from the reporter-shaped memo', () => {
    expect(monikerFromSignatureMemo('[23] fund node (DIGGO) IRELAND')).toBe('(DIGGO) IRELAND');
  });
  it('finds it among several memos', () => {
    expect(monikerFromSignatureMemo('[5] hello; [21] fund node (DIGGO) CANADA')).toBe('(DIGGO) CANADA');
  });
  it('ignores other memos, empty monikers and no memo (controls)', () => {
    expect(monikerFromSignatureMemo('[12] withdraw all')).toBeNull();
    expect(monikerFromSignatureMemo('[10] fund node ')).toBeNull();
    expect(monikerFromSignatureMemo(null)).toBeNull();
  });
});

describe('fundingFromParsedTx', () => {
  it('returns the node key (transfer recipient) and moniker', () => {
    expect(fundingFromParsedTx(fundTx({ memo: 'fund node (DIGGO) IRELAND' }), WALLET)).toEqual({ operator: OPERATOR, moniker: '(DIGGO) IRELAND' });
  });
  it('control: a transfer FROM someone else is not this wallet funding a node', () => {
    expect(fundingFromParsedTx(fundTx({ memo: 'fund node X', source: Keypair.generate().publicKey.toBase58() }), WALLET)).toBeNull();
  });
  it('control: a failed transaction or a missing memo is not a funding', () => {
    expect(fundingFromParsedTx(fundTx({ memo: 'fund node X', err: { InstructionError: [0, 'x'] } }), WALLET)).toBeNull();
    expect(fundingFromParsedTx(fundTx({}), WALLET)).toBeNull();
  });
});

const CB33_CONFIG = `service = "v2ray"\ncountry = "IE"\n\n[api]\nhosts = ["107.150.20.6"]\nport = 41000\n\n[handshake_dns]\nenabled = true\n`;
const chain = {
  address: 'PdaAddr1111111111111111111111111111111111111',
  nodeIdHex: 'ab'.repeat(32),
  owner: OPERATOR,
  status: 1,
  listedAt: 1,
  prices: { perGb: 2_500_000, perHour: 1_000_000, leasePerHour: 500_000 },
  protocols: 1,
  country: 'IE',
  uri: 'https://107.150.20.6:41000',
  bond: 1_000_000,
  revenue: 0,
  feesAccrued: 0,
  rentPayer: OPERATOR,
  openedAt: 1_731_400_000,
};

describe('buildAdoptedNode', () => {
  const id = '944c4e73-234e-432f-934d-5676530ca471';
  const node = buildAdoptedNode({
    id,
    creds: { host: '107.150.20.6', port: 22, username: 'root' },
    operator: OPERATOR,
    config: CB33_CONFIG,
    chain,
    image: 'node-manager/dvpnd:prebuilt-0.3.0',
    running: true,
    moniker: '(DIGGO) IRELAND',
    createdAt: '2026-11-12T05:44:38.000Z',
  });
  it('keeps the host folder id, so container name and home path line up', () => expect(node.id).toBe(id));
  it('takes the moniker from the wallet funding memo', () => expect(node.moniker).toBe('(DIGGO) IRELAND'));
  it('reads protocol, API port and HNS from the node config', () => {
    expect(node.serviceType).toBe('v2ray');
    expect(node.port).toBe(41000);
    expect(node.handshakeDns).toBe(true);
  });
  it('takes prices (display units), PDA and node id from the chain', () => {
    expect(node.gigabytePriceDVPN).toBe(2.5);
    expect(node.hourlyPriceDVPN).toBe(1);
    expect(node.leaseHourlyPriceDVPN).toBe(0.5);
    expect(node.nodePda).toBe(chain.address);
    expect(node.chainNodeId).toBe(chain.nodeIdHex);
    expect(node.registeredOnChain).toBe(true);
  });
  it('is a remote node on its server, with the image it actually runs', () => {
    expect(node.target).toBe('remote');
    expect(node.host).toBe('107.150.20.6');
    expect(node.imageTag).toBe('node-manager/dvpnd:prebuilt-0.3.0');
    expect(node.status).toBe('online');
    expect(node.recoveredAt).toBeTruthy();
  });
  it('control: without a moniker it gets a plain fallback name, never an empty one', () => {
    const n = buildAdoptedNode({ id, creds: { host: '1.2.3.4', port: 22, username: 'root' }, operator: OPERATOR, config: CB33_CONFIG, chain, running: false });
    expect(n.moniker).toBe('Recovered node 1.2.3.4:41000');
    expect(n.status).toBe('offline');
  });
  it('an unknown service string falls back to wireguard rather than an invalid type', () => {
    const n = buildAdoptedNode({ id, creds: { host: 'h', port: 22, username: 'root' }, operator: OPERATOR, config: 'service = "bogus"\n[api]\nport = 1\n', chain, running: true });
    expect(n.serviceType).toBe('wireguard');
  });
});

describe('classifySshFailure', () => {
  it.each([
    ['All configured authentication methods failed', 'wrong-login'],
    ['Host denied (verification failed)', 'host-key-changed'],
    ['1.2.3.4:22 does not answer over SSH (Timed out while waiting for handshake).', 'not-answering'],
    ['connect ECONNREFUSED 1.2.3.4:22', 'not-answering'],
    ['something else entirely', 'error'],
  ])('%s → %s', (msg, want) => expect(classifySshFailure(msg)).toBe(want));
});

describe('hostFromUri', () => {
  it('reads the host from the on-chain uri', () => {
    expect(hostFromUri('https://107.150.20.6:41000')).toBe('107.150.20.6');
    expect(hostFromUri('node.example.com:443')).toBe('node.example.com');
    expect(hostFromUri(undefined)).toBeUndefined();
  });
});

describe('node key backups: phrase and key file', () => {
  it('a key-file backup round-trips to the same signer', () => {
    const kp = Keypair.generate();
    const blob = encodeKeypairBackup(keypairToJson(kp));
    expect(isKeypairBackup(blob)).toBe(true);
    expect(keypairFromBackup(blob).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(decodeBackup(blob).kind).toBe('keypair');
  });
  it('control: an older phrase backup still decodes as a phrase', () => {
    const blob = Buffer.from('ENC:abandon abandon abandon').toString('base64');
    expect(isKeypairBackup(blob)).toBe(false);
    expect(decodeBackup(blob)).toEqual({ kind: 'mnemonic', mnemonic: 'abandon abandon abandon' });
  });
});

describe('programCheckVerdict (Q0584: version-1 node transactions)', () => {
  it('a key that called the dvpn program is a node, even if other transactions were unreadable', () => {
    expect(programCheckVerdict(['unreadable', 'program'])).toBe('node');
  });
  it('control: a cancelled deploy (every transaction read, none to the program) is not a node', () => {
    expect(programCheckVerdict(['other', 'other'])).toBe('no-node');
  });
  it('unreadable transactions never hide a node: the verdict is unknown, which is listed', () => {
    expect(programCheckVerdict(['other', 'unreadable'])).toBe('unknown');
  });
});

describe('node account lookup by owner (Q0586)', () => {
  it('the Node account tag is the Anchor tag measured on devnet (d0350103317ab431)', async () => {
    const { NODE_ACCOUNT_TAG, NODE_OWNER_OFFSET } = await import('../../src/main/services/recovery');
    expect(Buffer.from(NODE_ACCOUNT_TAG).toString('hex')).toBe('d0350103317ab431');
    expect(NODE_OWNER_OFFSET).toBe(40);
  });
  it('base58 matches a known public key encoding (control: leading zero bytes become 1s)', async () => {
    const { base58 } = await import('../../src/main/services/recovery');
    const pk = new PublicKey('J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs');
    expect(base58(pk.toBytes())).toBe('J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs');
    expect(base58(new Uint8Array([0, 0, 1]))).toBe('112');
  });
});

describe('hostFromAccountData (display host of a found node)', () => {
  it('finds the advertised uri wherever it sits in the account bytes', async () => {
    const { hostFromAccountData } = await import('../../src/main/services/recovery');
    const data = Buffer.alloc(337);
    data.write('https://20.98.93.220:41000', 112, 'latin1');
    expect(hostFromAccountData(data)).toBe('20.98.93.220');
  });
  it('control: no uri-shaped text gives null, never a guess', async () => {
    const { hostFromAccountData } = await import('../../src/main/services/recovery');
    expect(hostFromAccountData(Buffer.alloc(337, 7))).toBeNull();
  });
});

describe('node key location on a server (Q0588)', () => {
  it('reads the durable key file first; ctl/keys/owner.json exists only during a chain command', async () => {
    const { NODE_KEY_CANDIDATES } = await import('../../src/main/services/adopt');
    expect(NODE_KEY_CANDIDATES[0]).toBe('keys/operator.json');
    expect(NODE_KEY_CANDIDATES).toContain('node/keys/operator.json');
    expect(NODE_KEY_CANDIDATES[NODE_KEY_CANDIDATES.length - 1]).toBe('ctl/keys/owner.json');
  });
});

describe('a server that does not answer is not live (Q0598)', () => {
  it('a server node whose server does not answer is down', async () => {
    const { hostProbeMeansDown } = await import('../../src/main/services/ssh-failure');
    expect(hostProbeMeansDown('remote', 'nm032-host-2 does not answer over SSH (port 22)')).toBe(true);
    expect(hostProbeMeansDown('remote', 'connect ECONNREFUSED 20.115.161.26:22')).toBe(true);
    expect(hostProbeMeansDown('remote', 'Timed out while waiting for handshake')).toBe(true);
  });
  it('controls: a wrong login, a changed host key or a local node say nothing about the node', async () => {
    const { hostProbeMeansDown } = await import('../../src/main/services/ssh-failure');
    expect(hostProbeMeansDown('remote', 'All configured authentication methods failed')).toBe(false);
    expect(hostProbeMeansDown('remote', 'Host denied (verification failed)')).toBe(false);
    expect(hostProbeMeansDown('local', 'connect ECONNREFUSED 127.0.0.1:2375')).toBe(false);
  });
});
