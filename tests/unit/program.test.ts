import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/snm-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { devnetError, describeFailure, findProgramErrorCode } = await import('../../src/main/services/program-errors');
const { decodeNode, nodePda, nodeUnbondingPda, parseCtlJson } = await import('../../src/main/services/dvpnctl');
const { parseInitJson } = await import('../../src/main/services/deploy');
const { classifyErr } = await import('../../src/main/services/wallet');
const { PROTOCOLS, protocolFromBits, protocolInfo, displayToBase, baseToDisplay } = await import('../../src/main/services/chain');

describe('devnet error numbering (docs/14 divergence 4)', () => {
  it('rows read from the deployed program log', () => {
    expect(devnetError(6003).name).toBe('ParamOutOfRange');
    expect(devnetError(6019).name).toBe('NoFeesToSweep');
    expect(devnetError(6023).name).toBe('NoBalanceToWithdraw');
    expect(devnetError(6034).name).toBe('VoucherExceedsEscrow');
    expect(devnetError(6036).name).toBe('NothingToRedeem');
    expect(devnetError(6037).name).toBe('ModeNotVoucher');
    expect(devnetError(6039).name).toBe('VoucherSignerInvalid');
    expect(devnetError(6040).name).toBe('VoucherSignatureInvalid');
    expect(devnetError(6041).name).toBe('BatchLengthMismatch');
  });
  it('finds the number in every output shape', () => {
    expect(findProgramErrorCode('custom program error: 0x1786')).toBe(6022);
    expect(findProgramErrorCode('Error Code: X. Error Number: 6012.')).toBe(6012);
    expect(findProgramErrorCode('program error: ChannelNotClosing (6034)')).toBe(6034);
    expect(describeFailure('program error: ChannelNotClosing (6034)')).toMatch(/VoucherExceedsEscrow/);
  });
});

describe('dvpnctl output', () => {
  it('extracts JSON among log lines', () => {
    expect(parseCtlJson<{ signature: string }>('WRN something\n{\n "signature": "abc"\n}\n')).toEqual({ signature: 'abc' });
    expect(parseCtlJson<unknown[]>('[]')).toEqual([]);
    expect(() => parseCtlJson('error: no key')).toThrow(/no JSON/);
  });

  it('decodes a node exactly as dvpnctl prints it (live devnet shape)', () => {
    const uri = Buffer.from('https://198.51.100.40:18443');
    const raw = {
      address: '2xbdF1vEapF2Gui6qNaSMLXKpupfkWgaGVotzJQtTqKq',
      slot: 1,
      value: {
        nodeId: [161, 178, 195, 212, ...Array(26).fill(0), 190, 239],
        owner: '11111111111111111111111111111111',
        status: 1,
        listedAt: 1791949626,
        channelPricePerGb: 1000,
        channelPricePerHour: 1000,
        leasePricePerHour: 1000,
        // Captured before cb33 as 32 (the old AmneziaWG bit); cb33 AmneziaWG is 1 << 3.
        protocols: 1 << 3,
        country: [73, 78],
        uriLen: uri.length,
        uri: [...uri, ...Array(128 - uri.length).fill(0)],
        bond: 1000000,
        revenue: 197,
        feesAccrued: 3,
        rentPayer: '11111111111111111111111111111111',
        openedAt: 1791204408,
      },
    };
    const n = decodeNode(raw);
    expect(n.uri).toBe('https://198.51.100.40:18443');
    expect(n.country).toBe('IN');
    expect(n.nodeIdHex).toMatch(/^a1b2c3d4(00){26}beef$/);
    expect(protocolFromBits(n.protocols)?.type).toBe('amneziawg');
  });

  it('derives the node PDA from [node, owner, node_id]', () => {
    // Re-derived from the placeholder owner + id (checked against web3.js findProgramAddressSync).
    const id = 'a1b2c3d4' + '00'.repeat(26) + 'beef';
    expect(nodePda('11111111111111111111111111111111', id)).toBe('4d7F5smMhB84mxjNFn9NqGfjaDimkLncrzSmSis5UKoj');
    expect(nodeUnbondingPda('11111111111111111111111111111111', id)).not.toBe(nodePda('11111111111111111111111111111111', id));
  });
});

describe('dvpnd init output', () => {
  it('parses the result line', () => {
    const out =
      'INF starting\n{"api_port":20000,"home":"/tmp/h","id":"dbd14c111d963a16760e4891fdacea8404cf71954efdde08b39dfa75c9fc0fe7","key":"operator","public_key":"B3kZeeJ3nv9yZPb6YFoFnbf99N6n9eYuzipTYYb24Tq2","role":"node","tls_sha256":"40dff82f0dc19384a01996b6b1a27efd2b25ba05c02e4cccda5667cd5ba2c59b"}\n';
    const j = parseInitJson(out);
    expect(j.key).toBe('operator');
    expect(j.api_port).toBe(20000);
  });
  it('rejects output without a result', () => {
    expect(() => parseInitJson('error: home exists')).toThrow(/no result JSON/);
  });
});

describe('protocols + units', () => {
  // cb33 / public 26de5240 sentinel-go-sdk: <driver>/<driver>.go protocolBit. The pre-cb33
  // table (xray 4, openvpn 8, hysteria2 16, amneziawg 32) mislabelled nodes in two fleet tools.
  it('six protocols with the cb33 on-chain bitmask', () => {
    expect(PROTOCOLS.map((p) => [p.type, p.bit])).toEqual([
      ['wireguard', 1 << 0],
      ['amneziawg', 1 << 3],
      ['v2ray', 1 << 1],
      ['xray', 1 << 4],
      ['openvpn', 1 << 2],
      ['hysteria2', 1 << 5],
    ]);
    expect(() => protocolInfo('ipsec')).toThrow(/Unknown protocol/);
  });
  it('decodes each of the six chain bits to its protocol', () => {
    const chain: Array<[number, string]> = [
      [1 << 0, 'wireguard'],
      [1 << 1, 'v2ray'],
      [1 << 2, 'openvpn'],
      [1 << 3, 'amneziawg'],
      [1 << 4, 'xray'],
      [1 << 5, 'hysteria2'],
    ];
    for (const [bits, type] of chain) {
      expect(protocolFromBits(bits)?.type).toBe(type);
      expect(protocolInfo(type).bit).toBe(bits);
    }
    expect(protocolFromBits(0)).toBeUndefined();
    expect(protocolFromBits(1 << 6)).toBeUndefined();
  });
  it('6-decimal conversion', () => {
    expect(displayToBase(0.002)).toBe(2000n);
    expect(baseToDisplay(1_000_000)).toBe(1);
  });
});

describe('error classification', () => {
  it('maps Solana failures to UI codes', () => {
    expect(classifyErr('Transfer: insufficient lamports 100, need 5000')).toBe('insufficient-funds');
    expect(classifyErr('Blockhash not found')).toBe('timeout');
    expect(classifyErr('429 Too Many Requests')).toBe('rpc-unavailable');
    expect(classifyErr('Error Number: 6012')).toBe('program-error');
  });
});

describe('dvpnctl scalar output', () => {
  it('parses a bare JSON string (daemon status)', () => {
    expect(parseCtlJson<string>('"SERVING"\n')).toBe('SERVING');
  });
});

// ─── dvpnctl config works with both config layouts ───
// Bug (2026-10-24 live deploy): dvpnctl at ddv18.32 / 8d5b93c reads `[key] name` and
// `[daemon] endpoint`; the app wrote `key = 'owner'` → "'key' expected a map or struct".

describe('ctlConfigToml', () => {
  it('leaves out the key line and names each renamed field both ways', async () => {
    const { ctlConfigToml } = await import('../../src/main/services/dvpnctl');
    const t = ctlConfigToml('https://api.devnet.solana.com', '/root/.dvpnd/tc/daemon.sock');
    expect(t).not.toMatch(/^key\s*=/m);
    for (const k of ['socket', 'endpoint']) expect(t).toContain(`${k} = '/root/.dvpnd/tc/daemon.sock'`);
    for (const k of ['priority_fee', 'priority_fee_lamports', 'max_priority_fee', 'max_priority_fee_lamports', 'compute_unit_margin', 'compute_unit_margin_percent', 'loaded_data_limit', 'loaded_data_limit_bytes']) {
      expect(t).toMatch(new RegExp(`^${k} = `, 'm'));
    }
    expect(t).toContain("ws_url = 'wss://api.devnet.solana.com'");
  });
});

describe('parseInitJson, newer dvpnd', () => {
  it('reads key_name (ddv18.32+) as the key file name', () => {
    const line = '{"api_port":20000,"home":"/tmp/h","id":"6b845412efee20bb1d5403ff181532a418621b459be0999d2a187fe4d1d407d1","key_name":"operator","public_key":"3njG4hhUEGC3kGPV9b2xir6rdWxUPT9UpcAhTASbLWu3","role":"node","tls_sha256":"acdc97f8e65a24a2d9af52c84743e71b932d8da55d2b1245970ba41d551f033b"}';
    const j = parseInitJson(`some log line\n${line}\n`);
    expect(j.key).toBe('operator');
    expect(j.tls_sha256).toMatch(/^acdc97/);
  });
});
