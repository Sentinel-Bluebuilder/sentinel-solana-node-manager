import type { DeployedNode } from '../../shared/types';
import { UUID_RE } from './validate';

// ─── Node references (Q0169 / NM11) ───
// A node is named either by this app's record id (a UUID) or by its on-chain
// account address (base58, 32 bytes). An address can belong to a node this app
// deployed (its record's nodePda) or to one it did not (an operator's existing
// node), which the app can still read from chain but not manage.

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decoded byte length of a base58 string (no checksum), or -1 when it is not base58. */
function base58Length(s: string): number {
  let bytes: number[] = [];
  for (const ch of s) {
    const v = BASE58_ALPHABET.indexOf(ch);
    if (v < 0) return -1;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  bytes = bytes.reverse();
  return zeros + bytes.length;
}

/** True for a base58 string that decodes to exactly 32 bytes (a Solana account address). */
export function isChainAddress(s: string): boolean {
  return BASE58_RE.test(s) && base58Length(s) === 32;
}

export type NodeRef =
  | { kind: 'managed'; node: DeployedNode }
  | { kind: 'address'; address: string };

/**
 * Resolve a node reference against the app's records. A UUID must name a
 * record; an address resolves to the record that holds it, else to a bare
 * address (a node this app did not deploy).
 */
export function resolveNodeRef(ref: string, nodes: readonly DeployedNode[]): NodeRef {
  if (UUID_RE.test(ref)) {
    const node = nodes.find((n) => n.id === ref);
    if (!node) throw new Error(`Node ${ref} not found.`);
    return { kind: 'managed', node };
  }
  if (isChainAddress(ref)) {
    const node = nodes.find((n) => n.nodePda === ref);
    return node ? { kind: 'managed', node } : { kind: 'address', address: ref };
  }
  throw new Error("Invalid node id: expected this app's node id (UUID) or an on-chain node address (base58)");
}
