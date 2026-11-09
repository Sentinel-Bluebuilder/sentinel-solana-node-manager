import { describe, expect, it } from 'vitest';
import {
  RESERVED_RUNTIME_HOME_IDS,
  hostCleanupMustBeRetried,
  isReservedRuntimeHome,
  leftoverVerdict,
  shouldRetryHostCleanup,
  forgetServerBlocker,
  withdrawBondBlocker,
} from '../../src/main/services/validate';
import type { NodeDeployTarget } from '../../src/shared/types';

/**
 * Removal's last stage deletes the ufw rules the app opened and the node's home
 * directory. On a remote box that needs SSH, and the node record is the ONLY place
 * that knows which rules and which directory are ours — so a cleanup that could not
 * run must keep the record (parking at 'sweep') rather than drop it and orphan them.
 *
 * Regression: the branch was first written `target !== 'ssh'`, which typechecks
 * against the `'local' | 'remote'` union and is never equal, so every remote node
 * took the local branch and was dropped with its rules left behind on the host.
 */
describe('hostCleanupMustBeRetried', () => {
  it('keeps the record for a remote node, whose leftovers live on someone else’s box', () => {
    expect(hostCleanupMustBeRetried('remote')).toBe(true);
  });

  it('lets a local node finish: nothing is hidden and no remote box is left dirty', () => {
    expect(hostCleanupMustBeRetried('local')).toBe(false);
  });

  it('covers every target the type allows, so a new target cannot be silently skipped', () => {
    const targets: NodeDeployTarget[] = ['local', 'remote'];
    for (const t of targets) {
      expect(typeof hostCleanupMustBeRetried(t)).toBe('boolean');
    }
    // Exactly one of the current targets needs the retry; if a target is added this
    // count changes and forces a decision about which side it belongs on.
    expect(targets.filter(hostCleanupMustBeRetried)).toEqual(['remote']);
  });

  it('is not satisfied by a value outside the union (the original typo)', () => {
    // 'ssh' was never a NodeDeployTarget; a stale comparison against it must not
    // read as "retry this host".
    expect(hostCleanupMustBeRetried('ssh' as NodeDeployTarget)).toBe(false);
  });
});

/**
 * A node directory on a host holds the node key, so deleting one is only safe when
 * the node is provably finished with. These are the rules that decide that; the
 * dangerous direction is deleting something still in use, so every uncertain case
 * must come back as 'keep'.
 */
describe('leftoverVerdict', () => {
  it('never touches a directory an app record still claims', () => {
    expect(leftoverVerdict({ claimedByRecord: true })).toEqual({ act: 'skip' });
    // Even with everything else pointing at deletion.
    expect(leftoverVerdict({ claimedByRecord: true, owner: 'OWNER', keyEmpty: true })).toEqual({
      act: 'skip',
    });
  });

  it('keeps a directory whose key owner is unknown: emptiness cannot be proven', () => {
    const v = leftoverVerdict({ claimedByRecord: false });
    expect(v.act).toBe('keep');
    expect(v).toHaveProperty('reason', expect.stringContaining('cannot prove it is empty'));
  });

  it('keeps a directory whose key still holds value on chain', () => {
    const v = leftoverVerdict({ claimedByRecord: false, owner: 'OWNER', keyEmpty: false });
    expect(v.act).toBe('keep');
    expect(v).toHaveProperty('reason', expect.stringContaining('still holds value'));
  });

  it('deletes only an unclaimed directory whose key is verifiably empty', () => {
    expect(leftoverVerdict({ claimedByRecord: false, owner: 'OWNER', keyEmpty: true })).toEqual({
      act: 'delete',
    });
  });

  it('a dry run never deletes', () => {
    expect(
      leftoverVerdict({ claimedByRecord: false, owner: 'OWNER', keyEmpty: true, dryRun: true }),
    ).toEqual({ act: 'keep', reason: 'dry run' });
  });

  it('an undefined keyEmpty is treated as not-empty, never as permission to delete', () => {
    // keyEmpty is only populated after a successful chain read; a failed or skipped
    // read must not read as "empty".
    const v = leftoverVerdict({ claimedByRecord: false, owner: 'OWNER' });
    expect(v.act).toBe('keep');
  });
});

/**
 * The poller must not retry a cleanup that cannot succeed yet on every tick, but the
 * user must never be made to wait: Reconnect / "withdraw bond now" happen right after
 * they supplied the missing credentials, and a silent 10-minute wait there is the
 * stuck-looking behaviour this fix exists to remove.
 */
describe('shouldRetryHostCleanup', () => {
  const retryMs = 10 * 60_000;
  const now = 1_000_000_000;

  it('attempts a cleanup that has never been tried', () => {
    expect(shouldRetryHostCleanup({ now, retryMs })).toBe(true);
  });

  it('makes the poller wait out the backoff after a failure', () => {
    expect(shouldRetryHostCleanup({ lastAttemptAt: now - 60_000, now, retryMs })).toBe(false);
  });

  it('lets the poller through once the backoff has elapsed', () => {
    expect(shouldRetryHostCleanup({ lastAttemptAt: now - retryMs, now, retryMs })).toBe(true);
  });

  it('never makes a user-initiated retry wait', () => {
    // The whole point: they just reconnected with the credentials that were missing.
    expect(shouldRetryHostCleanup({ lastAttemptAt: now - 1, now, retryMs, force: true })).toBe(true);
  });
});

/**
 * The app keeps two of its own scratch runtime homes next to real node homes (the
 * outside-client test container and the wallet-level dvpnctl home). They have UUID
 * shape because the runtime demands it and hold no node key, so leftover cleanup must
 * pass over them — otherwise every run reports them as unexplained directories, and
 * the real signal gets buried in noise that can never be acted on.
 */
describe('reserved runtime homes', () => {
  it('recognises both reserved ids', () => {
    for (const id of RESERVED_RUNTIME_HOME_IDS) {
      expect(isReservedRuntimeHome(id)).toBe(true);
    }
  });

  it('does not treat a real node id as reserved', () => {
    expect(isReservedRuntimeHome('3ed2f331-4f74-4c7a-ab1c-1e038ebb06e6')).toBe(false);
  });

  it('keeps the two ids distinct and UUID-shaped, as the runtime requires', () => {
    expect(new Set(RESERVED_RUNTIME_HOME_IDS).size).toBe(RESERVED_RUNTIME_HOME_IDS.length);
    for (const id of RESERVED_RUNTIME_HOME_IDS) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });
});

/**
 * G11 (FS36, 2026-11-08): the server was deleted after nodes.remove. The bond came back and the
 * key was swept (stage 'sweep', host cleanup pending on SSH), but withdrawBond said "This node is
 * not unbonding." and Reconnect needs the server, so the record could never be finished.
 */
describe('a removal whose server is gone', () => {
  it('lets the user finish once only the server cleanup is left and the key is empty', () => {
    expect(forgetServerBlocker({ removalStage: 'sweep', pendingHostCleanup: true, keyEmpty: true })).toBeNull();
  });

  it('refuses while money or chain steps are still outstanding', () => {
    expect(forgetServerBlocker({ removalStage: 'sweep', pendingHostCleanup: true, keyEmpty: false })).toMatch(/still holds funds/);
    for (const stage of ['redeem', 'stop', 'delist', 'close', 'unbonding', 'withdraw-bond'] as const) {
      expect(forgetServerBlocker({ removalStage: stage, pendingHostCleanup: true, keyEmpty: true })).toMatch(/not at the server-cleanup step/);
    }
    expect(forgetServerBlocker({ removalStage: 'sweep', pendingHostCleanup: false, keyEmpty: true })).toMatch(/has not failed/);
    expect(forgetServerBlocker({ removalStage: undefined, pendingHostCleanup: false, keyEmpty: true })).toMatch(/not being removed/);
  });

  it('says the bond is already home instead of "not unbonding"', () => {
    expect(withdrawBondBlocker('sweep', true)).toMatch(/already back in your wallet.*Server is gone/);
    expect(withdrawBondBlocker('sweep', false)).toMatch(/already back in your wallet/);
    expect(withdrawBondBlocker('unbonding', false)).toBeNull();
    // The poller may have moved on to withdraw-bond and failed there; the manual retry must still run.
    expect(withdrawBondBlocker('withdraw-bond', false)).toBeNull();
    expect(withdrawBondBlocker('close', false)).toMatch(/not unbonding yet/);
  });
});
