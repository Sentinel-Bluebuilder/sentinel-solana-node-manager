import { describe, expect, it } from 'vitest';
import { commandKey, layoutFromInitHelp, translateArgs } from '../../src/main/services/cli-layout';

// ─── dvpnd / dvpnctl flags, older and newer images ───
// Bug (2026-10-24 live deploy): dvpnd at ddv18.34 refused `init --api-addrs` (now
// --api-hosts) after the node key had been funded.

describe('layoutFromInitHelp', () => {
  it('tells the layouts apart from `dvpnd init --help`', () => {
    expect(layoutFromInitHelp('      --api-hosts strings   public api hosts (node, provider)')).toBe('newer');
    expect(layoutFromInitHelp('      --api-addrs strings   public api addresses (node, provider)')).toBe('older');
  });

  it('refuses output it cannot place instead of guessing', () => {
    expect(() => layoutFromInitHelp('error: unknown command "init"')).toThrow(/cannot tell the dvpnd version/);
  });
});

describe('translateArgs', () => {
  const init = ['init', '--role', 'node', '--api-addrs', '1.2.3.4', '--prices.channel-price-per-gb', '2000', '--prices.channel-price-per-hour=1000', '--prices.lease-price-per-hour', '1000'];

  it('renames the init flags for a newer dvpnd', () => {
    expect(translateArgs('dvpnd', init, 'newer')).toEqual(['init', '--role', 'node', '--api-hosts', '1.2.3.4', '--prices.channel-per-gb', '2000', '--prices.channel-per-hour=1000', '--prices.lease-per-hour', '1000']);
  });

  it('leaves the older layout and unaffected commands unchanged', () => {
    expect(translateArgs('dvpnd', init, 'older')).toEqual(init);
    const open = ['node', 'open-node', '--rent-payer', 'X', '--prices.channel-price-per-gb', '1'];
    expect(translateArgs('dvpnctl', open, 'newer')).toEqual(open);
  });

  it('renames --rent-payer only where the newer dvpnctl calls it --rent-recipient', () => {
    expect(translateArgs('dvpnctl', ['node', 'withdraw-node-bond', '--rent-payer', 'X'], 'newer')).toEqual(['node', 'withdraw-node-bond', '--rent-recipient', 'X']);
    expect(translateArgs('dvpnctl', ['user', 'withdraw-user-balance', '--rent-payer', 'X'], 'newer')).toEqual(['user', 'withdraw-user-balance', '--rent-recipient', 'X']);
    expect(translateArgs('dvpnctl', ['node', 'close-node', '--rent-payer', 'X'], 'newer')).toEqual(['node', 'close-node', '--rent-payer', 'X']);
  });
});

describe('commandKey', () => {
  it('takes the words before the first flag', () => {
    expect(commandKey('dvpnctl', ['node', 'unbonding', 'show', 'ADDR'])).toBe('dvpnctl node unbonding show ADDR');
    expect(commandKey('dvpnctl', ['node', 'withdraw-node-bond', '--node-unbonding', 'X'])).toBe('dvpnctl node withdraw-node-bond');
  });
});
