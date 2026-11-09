import { describe, expect, it } from 'vitest';
import {
  blockPorts,
  getKey,
  patchNodeConfig,
  patchTopConfig,
  pinServicePorts,
  servicePublicPorts,
  setKey,
} from '../../src/main/services/node-config';

// Fixtures are verbatim `dvpnd init --role node` output from the devnet image.
const NODE = `country = 'US'
id = 'dbd14c111d963a16760e4891fdacea8404cf71954efdde08b39dfa75c9fc0fe7'
owner = '11111111111111111111111111111111'
service = 'wireguard'

[api]
addrs = ['192.168.1.183']
port = 20000

[price_feed]
api_key = ''
channel_per_gb_usd = 0.0
enabled = false

[prices]
channel_per_gb = 1000
channel_per_hour = 1000
lease_per_hour = 1000

[redeem]
threshold = 10000000

[sessions]
grace_bytes = 50000000
idle_timeout = 900000000000
`;

const XRAY = `api_port = 27224

[[inbounds]]
port = 42380
protocol = 'vless'
security = 'tls'
transport = 'ws'

[[inbounds]]
port = 23010
protocol = 'vmess'
security = 'tls'
transport = 'grpc'

[[inbounds]]
port = 12877
protocol = 'vless'
security = 'reality'
transport = 'tcp'

[inbounds.reality]
dest = 'www.apple.com:443'
fingerprint = 'chrome'
server_name = 'www.apple.com'
`;

const HYSTERIA = `auth_port = 27992
listen_port = 26707
masquerade_url = ''
obfs_password = 'e5ab8ff28c14d36597ed021df5367de2'
stats_port = 14042
stats_secret = '236fa71d7b8a280d3ebcfc752ffb3d44'
`;

const TOP = `[daemon]
role = 'node'

[rpc]
commitment = 'confirmed'
timeout = 10000000000
url = 'https://api.devnet.solana.com'
ws_url = 'wss://api.devnet.solana.com'
`;

describe('setKey / getKey', () => {
  it('replaces in place and leaves floats/durations untouched', () => {
    const out = setKey(NODE, 'redeem', 'threshold', 1);
    expect(getKey(out, 'redeem', 'threshold')).toBe('1');
    expect(out).toContain('channel_per_gb_usd = 0.0');
    expect(out).toContain('idle_timeout = 900000000000');
  });
  it('top-level keys stay above the first table', () => {
    const out = setKey(NODE, '', 'service', 'xray');
    expect(out.split('\n')[3]).toBe("service = 'xray'");
  });
  it('appends a missing section', () => {
    const out = setKey('a = 1\n', 'new', 'k', 'v');
    expect(getKey(out, 'new', 'k')).toBe('v');
  });
});

describe('patchNodeConfig', () => {
  it('writes service, prices, api and redeem threshold', () => {
    const out = patchNodeConfig(NODE, {
      service: 'hysteria2',
      apiPort: 31000,
      apiAddrs: ['1.2.3.4'],
      prices: { perGb: 3000, perHour: 2000, leasePerHour: 1500 },
      redeemThreshold: 1,
    });
    expect(getKey(out, '', 'service')).toBe('hysteria2');
    expect(getKey(out, 'api', 'port')).toBe('31000');
    expect(getKey(out, 'api', 'addrs')).toBe("['1.2.3.4']");
    expect(getKey(out, 'prices', 'channel_per_gb')).toBe('3000');
    expect(getKey(out, 'prices', 'channel_per_hour')).toBe('2000');
    expect(getKey(out, 'prices', 'lease_per_hour')).toBe('1500');
    expect(getKey(out, 'redeem', 'threshold')).toBe('1');
    expect(getKey(out, '', 'owner')).toBe('11111111111111111111111111111111');
  });
});

describe('patchTopConfig', () => {
  it('sets url and the matching ws url', () => {
    const out = patchTopConfig(TOP, 'https://devnet.helius-rpc.com/?api-key=x');
    expect(getKey(out, 'rpc', 'url')).toBe('https://devnet.helius-rpc.com/?api-key=x');
    expect(getKey(out, 'rpc', 'ws_url')).toBe('wss://devnet.helius-rpc.com/?api-key=x');
  });
});

describe('pinServicePorts', () => {
  const { service } = blockPorts(20000, 5);

  it('blocks are api + 4 service ports', () => {
    expect(blockPorts(20000, 5)).toEqual({ api: 20000, service: [20001, 20002, 20003, 20004] });
  });

  it('listen_port protocols get the first service port; internal ports untouched', () => {
    const { toml, publicPorts } = pinServicePorts('hysteria2', HYSTERIA, service);
    expect(publicPorts).toEqual([20001]);
    expect(getKey(toml, '', 'listen_port')).toBe('20001');
    expect(getKey(toml, '', 'auth_port')).toBe('27992');
    expect(getKey(toml, '', 'stats_port')).toBe('14042');
  });

  it('inbound protocols: REALITY stripped, survivors renumbered', () => {
    const { toml, publicPorts } = pinServicePorts('xray', XRAY, service);
    expect(publicPorts).toEqual([20001, 20002]);
    expect(toml).not.toContain('reality');
    expect(toml).toContain("api_port = 27224");
    expect(servicePublicPorts('xray', toml)).toEqual([20001, 20002]);
    expect((toml.match(/\[\[inbounds\]\]/g) ?? []).length).toBe(2);
  });

  it('is idempotent', () => {
    const once = pinServicePorts('xray', XRAY, service).toml;
    const twice = pinServicePorts('xray', once, service).toml;
    expect(twice).toBe(once);
  });

  it('fails loudly when the block is too small', () => {
    expect(() => pinServicePorts('xray', XRAY, [20001])).toThrow(/needs 2 ports/);
  });
});

// ─── Newer dvpnd node config (ddv18.32+): [api] hosts, [redeem] threshold_base_units ───
// Verbatim sections of `dvpnd init --role node` from the ddv18.34 image.
const NODE_NEWER = `country = 'IN'
service = 'wireguard'

[api]
hosts = ['1.2.3.4']
port = 20000

[redeem]
threshold_base_units = 10000000
`;

describe('patchNodeConfig on the newer layout', () => {
  it('writes the key names the file already uses, and adds no older ones', () => {
    const out = patchNodeConfig(NODE_NEWER, { apiAddrs: ['5.6.7.8'], redeemThreshold: 1 });
    expect(getKey(out, 'api', 'hosts')).toBe("['5.6.7.8']");
    expect(getKey(out, 'redeem', 'threshold_base_units')).toBe('1');
    expect(getKey(out, 'api', 'addrs')).toBeUndefined();
    expect(getKey(out, 'redeem', 'threshold')).toBeUndefined();
  });

  it('keeps the older names on an older file', () => {
    const out = patchNodeConfig(NODE, { apiAddrs: ['5.6.7.8'], redeemThreshold: 1 });
    expect(getKey(out, 'api', 'addrs')).toBe("['5.6.7.8']");
    expect(getKey(out, 'api', 'hosts')).toBeUndefined();
  });
});
