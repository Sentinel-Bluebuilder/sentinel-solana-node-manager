import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { DeployedNode } from '../../src/shared/types';
import { isChainAddress, resolveNodeRef } from '../../src/main/services/node-ref';

// Q0169 / NM11: a node this app did not deploy (e.g. nodes another operator runs)
// must be readable by its on-chain address.
const FOREIGN = '6ZCHcPjGR5BRS3UdiUBasUWhDB1tueTuPWNSjuhSguWc'; // another operator's amneziawg node
const OWN_PDA = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toBase58();
const OWN_ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const nodes = [{ id: OWN_ID, nodePda: OWN_PDA } as DeployedNode];

describe('isChainAddress', () => {
  it('accepts 32-byte base58 addresses, including ones with leading 1s', () => {
    expect(isChainAddress(FOREIGN)).toBe(true);
    expect(isChainAddress(OWN_PDA)).toBe(true);
    expect(isChainAddress('11111111111111111111111111111111')).toBe(true); // system program, 32 zero bytes
  });
  it('agrees with web3.js on every byte length it accepts', () => {
    for (let len = 28; len <= 36; len++) {
      const s = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + len) & 0xff)).toBase58();
      expect(isChainAddress(s)).toBe(true);
    }
  });
  it('refuses UUIDs, non-base58 characters and wrong lengths', () => {
    expect(isChainAddress(OWN_ID)).toBe(false);
    expect(isChainAddress(FOREIGN.replace('6', '0'))).toBe(false); // 0 is not base58
    expect(isChainAddress(FOREIGN.slice(0, 30))).toBe(false); // too short
    expect(isChainAddress(`${FOREIGN}zz`)).toBe(false); // decodes past 32 bytes
  });
});

describe('resolveNodeRef', () => {
  it('a UUID resolves to its record', () => {
    expect(resolveNodeRef(OWN_ID, nodes)).toEqual({ kind: 'managed', node: nodes[0] });
  });
  it("an address the app manages resolves to that record, so managed reads still use the node's own runtime", () => {
    expect(resolveNodeRef(OWN_PDA, nodes)).toEqual({ kind: 'managed', node: nodes[0] });
  });
  it('an address the app does not manage resolves to a bare address (the NM11 case)', () => {
    expect(resolveNodeRef(FOREIGN, nodes)).toEqual({ kind: 'address', address: FOREIGN });
    expect(resolveNodeRef(FOREIGN, [])).toEqual({ kind: 'address', address: FOREIGN });
  });
  it('negative control: an unknown UUID and garbage are still refused', () => {
    expect(() => resolveNodeRef('00000000-0000-4000-8000-000000000000', nodes)).toThrow(/not found/);
    expect(() => resolveNodeRef('not-a-node', nodes)).toThrow(/expected this app's node id \(UUID\) or an on-chain node address/);
  });
});
