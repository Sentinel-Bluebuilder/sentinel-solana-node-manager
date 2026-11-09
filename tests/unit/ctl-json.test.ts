import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/snm-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { camelKeys, fixedText, idHex, numberField } = await import('../../src/main/services/ctl-json');
const { decodeNode, programParamsFrom } = await import('../../src/main/services/dvpnctl');

// ─── dvpnctl JSON from both layouts ───
// Bug (2026-10-24 live deploy): dvpnctl at ddv18.32 / 8d5b93c prints snake_case, hex ids
// and text country/uri, so the app read minNodeBond as undefined → "NaN cannot be
// converted to a BigInt". Samples below are real output of both images for one node.

const ID_HEX = '2b9702466ab8ef3d30e99eace6110faf20f1268614746577335ff02821289942';
const URI = 'https://198.51.100.50:18712';

const OLD_NODE = {
  address: '1PwMkSjnyugAZHdHvDsddETzPUAubPkeyWymT7Ercn6',
  slot: 514612824,
  value: {
    nodeId: [...Buffer.from(ID_HEX, 'hex')],
    owner: 'CUeZM72prU4wVfPCQzfPV8VqGqDvHYTSzWNuMePYnkBr',
    status: 1,
    listedAt: 1792834111,
    channelPricePerGb: 1000,
    channelPricePerHour: 1000,
    leasePricePerHour: 1000,
    protocols: 32,
    country: [85, 83],
    uriLen: 28,
    uri: [...Buffer.from(URI), ...new Array(100).fill(0)],
    bond: 1000000,
    revenue: 46698,
    feesAccrued: 0,
    rentPayer: 'CUeZM72prU4wVfPCQzfPV8VqGqDvHYTSzWNuMePYnkBr',
    openedAt: 1792750865,
  },
};

const NEW_NODE = {
  address: '1PwMkSjnyugAZHdHvDsddETzPUAubPkeyWymT7Ercn6',
  slot: 514612840,
  value: {
    node_id: ID_HEX,
    owner: 'CUeZM72prU4wVfPCQzfPV8VqGqDvHYTSzWNuMePYnkBr',
    status: 1,
    listed_at: 1792834111,
    channel_price_per_gb: 1000,
    channel_price_per_hour: 1000,
    lease_price_per_hour: 1000,
    protocols: 32,
    country: 'US',
    uri: URI,
    bond: 1000000,
    revenue: 46698,
    fees_accrued: 0,
    rent_payer: 'CUeZM72prU4wVfPCQzfPV8VqGqDvHYTSzWNuMePYnkBr',
    opened_at: 1792750865,
    bump: 255,
  },
};

describe('decodeNode', () => {
  it('reads the same node identically from both layouts', () => {
    const a = decodeNode(OLD_NODE);
    const b = decodeNode(NEW_NODE);
    expect(b).toEqual(a);
    expect(a.nodeIdHex).toBe(ID_HEX);
    expect(a.country).toBe('US');
    expect(a.uri).toBe(URI);
    expect(a.prices).toEqual({ perGb: 1000, perHour: 1000, leasePerHour: 1000 });
  });
});

describe('programParamsFrom', () => {
  const common = { mint: 'Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa', vault: 'EQJyAyWLGZSye3BMfDQVdhrfp1QKEByNX9q2J9TzFmfy', treasury: 'Gej7quWtz869TiidkTjrm7yer7EnR8yE82TGEyHdmDYr' };
  it('reads both layouts, including the renamed pause mask', () => {
    const older = programParamsFrom({ ...common, feeBps: 200, minNodeBond: 1000000, unbondingSeconds: 3600, channelCloseGraceSeconds: 7200, nodeListingTtlSeconds: 86400, paused: 0 });
    const newer = programParamsFrom({ ...common, fee_bps: 200, min_node_bond: 1000000, unbonding_seconds: 3600, channel_close_grace_seconds: 7200, node_listing_ttl_seconds: 86400, paused_mask: 0 });
    expect(newer).toEqual(older);
    expect(newer.minNodeBond).toBe(1000000);
  });

  it('fails with a clear message instead of a NaN later', () => {
    expect(() => programParamsFrom({ ...common, fee_bps: 200 })).toThrow(/no min_node_bond/);
  });
});

describe('helpers', () => {
  it('camelKeys converts nested snake_case and leaves camelCase alone', () => {
    expect(camelKeys({ closed_at: 1, rentPayer: 'x', rows: [{ node_id: 'ab' }] })).toEqual({ closedAt: 1, rentPayer: 'x', rows: [{ nodeId: 'ab' }] });
  });

  it('idHex and fixedText accept bytes or text and refuse anything else', () => {
    expect(idHex([171, 205], 'id')).toBe('abcd');
    expect(idHex('ABCD', 'id')).toBe('abcd');
    expect(() => idHex(42, 'id')).toThrow(/unreadable id/);
    expect(fixedText([85, 83, 0, 0], 'c')).toBe('US');
    expect(fixedText('US', 'c')).toBe('US');
    expect(() => fixedText(null, 'c')).toThrow(/unreadable c/);
  });

  it('numberField takes the first name present (unbonding amount → bond)', () => {
    expect(numberField({ bond: 1000000 }, ['amount', 'bond'], 'x')).toBe(1000000);
    expect(numberField({ amount: 5, bond: 1 }, ['amount', 'bond'], 'x')).toBe(5);
  });
});
