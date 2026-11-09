import { describe, expect, it } from 'vitest';
import { SSH_CONNECT_ATTEMPTS, ctlImageChoice, failedDeployVerdict, firstRemovalStage, sshConnectError, sshConnectRetryable } from '../../src/main/services/validate';

/**
 * A remote deploy whose open_node failed in SIMULATION (no transaction) must sweep the
 * funding back and drop the record. Seen on a remote test host (Q0322/Q0323): recovery read
 * the node account through dvpnctl on LOCAL Docker, the remote node's image was not
 * there, the read failed, the failure was taken as "opened", and the record was marked
 * on chain and parked in a removal that retried "No such image" forever, with
 * 0.05 SOL + 1 tDVPN left on the node key.
 */
describe('failedDeployVerdict', () => {
  it('opened when the node account exists', () => {
    expect(failedDeployVerdict('exists')).toBe('opened');
  });
  it('funded (sweep + drop) when the account is missing', () => {
    expect(failedDeployVerdict('missing')).toBe('funded');
  });
  it('keeps the record when the chain could not be read — never guesses "opened"', () => {
    expect(failedDeployVerdict('unknown')).toBe('keep');
    expect(failedDeployVerdict('unknown')).not.toBe('opened');
  });
});

describe('ctlImageChoice', () => {
  it('uses the node image when this machine has it', () => {
    expect(ctlImageChoice({ nodeTag: 'node-manager/dvpnd:devnet-aaaa', nodeTagLocal: true, currentTag: 'node-manager/dvpnd:devnet-bbbb' }))
      .toEqual({ tag: 'node-manager/dvpnd:devnet-aaaa', build: false });
  });
  it('a remote node image absent here → the current source image, built on demand', () => {
    expect(ctlImageChoice({ nodeTag: 'node-manager/dvpnd:devnet-8b4aca54a4', nodeTagLocal: false, currentTag: 'node-manager/dvpnd:devnet-cf4c' }))
      .toEqual({ tag: 'node-manager/dvpnd:devnet-cf4c', build: true });
  });
  it('a node without a recorded tag → the current source image', () => {
    expect(ctlImageChoice({ nodeTag: undefined, nodeTagLocal: false, currentTag: 'node-manager/dvpnd:devnet-cf4c' }).tag)
      .toBe('node-manager/dvpnd:devnet-cf4c');
  });
});

describe('firstRemovalStage', () => {
  it('on-chain node starts at redeem', () => {
    expect(firstRemovalStage({ registeredOnChain: true, runtimeId: 'c1', nodePda: 'P', chainNodeId: '1' })).toBe('redeem');
  });
  it('a running container is stopped first', () => {
    expect(firstRemovalStage({ runtimeId: 'c1', nodePda: 'P', chainNodeId: '1' })).toBe('stop');
  });
  it('an unconfirmed open_node goes through delist (reads the chain) so a bond is never skipped', () => {
    expect(firstRemovalStage({ nodePda: 'P', chainNodeId: '1' })).toBe('delist');
  });
  it('nothing on chain and no container → sweep', () => {
    expect(firstRemovalStage({})).toBe('sweep');
  });
});

/**
 * a remote test host came back on a new IP; the node record kept the old one and every remote step
 * failed with a bare "connect ETIMEDOUT". DIR: the app must say clearly what is wrong.
 */
describe('sshConnectError', () => {
  it.each([
    'connect ETIMEDOUT 198.51.100.30:22',
    'connect EHOSTUNREACH 10.0.0.9:22',
    'connect ECONNREFUSED 1.2.3.4:22',
    'getaddrinfo ENOTFOUND old.example',
    'Timed out while waiting for handshake',
  ])('an address that does not answer names the IP-change cause: %s', (msg) => {
    const e = sshConnectError('198.51.100.30', 22, new Error(msg));
    expect(e.message).toContain('198.51.100.30:22 does not answer over SSH');
    expect(e.message).toContain('IP address changed');
    expect(e.message).toContain(msg);
  });
  it('credentials / host-key errors pass through unchanged', () => {
    const auth = new Error('All configured authentication methods failed');
    expect(sshConnectError('h', 22, auth)).toBe(auth);
  });
});

/** Q0341: one stalled SSH handshake (1 of 6 protocol switches) failed the user's action. */
describe('sshConnectRetryable', () => {
  it('a stalled or reset handshake is retried', () => {
    expect(sshConnectRetryable('Timed out while waiting for handshake')).toBe(true);
    expect(sshConnectRetryable('read ECONNRESET')).toBe(true);
    expect(SSH_CONNECT_ATTEMPTS).toBeGreaterThan(1);
  });
  it.each([
    'connect ETIMEDOUT 198.51.100.30:22',
    'connect ECONNREFUSED 1.2.3.4:22',
    'getaddrinfo ENOTFOUND old.example',
    'All configured authentication methods failed',
    'Handshake failed: no matching host key format',
  ])('a dead address or a credentials/host-key failure is NOT retried: %s', (msg) => {
    expect(sshConnectRetryable(msg)).toBe(false);
  });
});
