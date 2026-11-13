import { describe, expect, it } from 'vitest';
import { chainHelperCandidates, isDockerUnavailable, isOlderPrebuiltTag, keyedExclusive, noChainHostMessage, shouldLogRepeat, sweepIsDue } from '../../src/main/services/validate';

// Fix A (0.3.1): chain commands fall back to another server when this computer's Docker cannot run them.
// Regression: a removal sat at withdraw-bond for a day with Docker Desktop off (2026-11-12).

const a = { host: '10.0.0.1', port: 22, username: 'root' };
const b = { host: '10.0.0.2', port: 22, username: 'root' };
const c = { host: '10.0.0.3', port: 2222, username: 'ubuntu' };

describe('chainHelperCandidates', () => {
  it('puts the chain-call server first, then connected node servers', () => {
    const out = chainHelperCandidates({ chainHost: c, connected: [a, b] });
    expect(out.map((x) => `${x.source}:${x.host}`)).toEqual(['chain-host:10.0.0.3', 'node:10.0.0.1', 'node:10.0.0.2']);
  });

  it('skips the node own server (already tried) and duplicates', () => {
    const out = chainHelperCandidates({ nodeHost: '10.0.0.1', chainHost: b, connected: [a, b, b] });
    expect(out.map((x) => x.host)).toEqual(['10.0.0.2']);
  });

  it('keeps the same host on another port or user as a separate candidate', () => {
    const out = chainHelperCandidates({ connected: [a, { ...a, port: 2200 }, { ...a, username: 'ubuntu' }] });
    expect(out).toHaveLength(3);
  });

  it('returns nothing when the app holds no SSH credentials (the laptop case)', () => {
    expect(chainHelperCandidates({ connected: [] })).toEqual([]);
  });
});

describe('isDockerUnavailable', () => {
  it('recognises the three structured Docker errors', () => {
    for (const reason of ['desktop-not-running', 'desktop-not-installed', 'engine-not-running']) {
      expect(isDockerUnavailable(Object.assign(new Error('x'), { reason }))).toBe(true);
    }
  });
  it('is false for other errors and non-errors', () => {
    expect(isDockerUnavailable(new Error('No such image'))).toBe(false);
    expect(isDockerUnavailable(null)).toBe(false);
    expect(isDockerUnavailable(undefined)).toBe(false);
  });
});

describe('noChainHostMessage', () => {
  it('names both ways out and keeps the local reason, bounded', () => {
    const m = noChainHostMessage(`Docker Desktop is installed but not running. ${'x'.repeat(1000)}`);
    expect(m).toMatch(/Start Docker Desktop/);
    expect(m).toMatch(/Settings → Chain-call server/);
    expect(m).toMatch(/This computer said: Docker Desktop is installed but not running/);
    expect(m.length).toBeLessThan(600);
  });
});

describe('sweepIsDue (fix B)', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  it('is due for an open channel or a pending refund', () => {
    expect(sweepIsDue({ open: 1, refundPending: false }, [], now)).toBe(true);
    expect(sweepIsDue({ open: 0, refundPending: true }, [], now)).toBe(true);
  });
  it('waits while every close is in its grace period', () => {
    expect(sweepIsDue({ open: 0, refundPending: false }, ['2026-11-12T11:00:00Z'], now)).toBe(false);
  });
  it('is due once one close has matured', () => {
    expect(sweepIsDue({ open: 0, refundPending: false }, ['2026-11-12T11:00:00Z', '2026-11-12T09:59:59Z'], now)).toBe(true);
  });
  it('is not due with nothing out', () => {
    expect(sweepIsDue({ open: 0, refundPending: false }, [], now)).toBe(false);
  });
});

describe('isOlderPrebuiltTag (HNS toggle recreates on the current image)', () => {
  const cur = 'node-manager/dvpnd:prebuilt-0.3.1';
  it('moves a 0.3.0 prebuilt node to the current image', () => {
    expect(isOlderPrebuiltTag('node-manager/dvpnd:prebuilt-0.3.0', cur)).toBe(true);
  });
  it('leaves the current image, source builds and unknown tags alone', () => {
    expect(isOlderPrebuiltTag(cur, cur)).toBe(false);
    expect(isOlderPrebuiltTag('node-manager/dvpnd:devnet-abc123', cur)).toBe(false);
    expect(isOlderPrebuiltTag(undefined, cur)).toBe(false);
  });
});

// T4 log hygiene (0.3.1): the 5-min escrow sweep logged the same failure twice per tick.
describe('shouldLogRepeat (T4)', () => {
  const t = Date.parse('2026-11-12T10:00:00Z');
  it('logs the first failure and a changed message', () => {
    expect(shouldLogRepeat(undefined, 'docker down', t)).toBe(true);
    expect(shouldLogRepeat({ message: 'docker down', at: t }, 'rpc 429', t + 1000)).toBe(true);
  });
  it('holds the same message for an hour, then logs it again', () => {
    const prev = { message: 'docker down', at: t };
    expect(shouldLogRepeat(prev, 'docker down', t + 10 * 60_000)).toBe(false);
    expect(shouldLogRepeat(prev, 'docker down', t + 59 * 60_000)).toBe(false);
    expect(shouldLogRepeat(prev, 'docker down', t + 60 * 60_000)).toBe(true);
  });
  it('a failing 10-min tick writes at most 2 lines in an hour', () => {
    let prev: { message: string; at: number } | undefined;
    let lines = 0;
    for (let i = 0; i <= 6; i++) {
      const now = t + i * 10 * 60_000;
      if (shouldLogRepeat(prev, 'same', now)) { lines++; prev = { message: 'same', at: now }; }
    }
    expect(lines).toBe(2);
  });
});

// T7 (0.3.1): two config changes on one node at once lost one change or started two containers.
describe('keyedExclusive (T7)', () => {
  it('refuses a second job on the same node while the first runs, with a plain message', async () => {
    const ex = keyedExclusive();
    let release!: () => void;
    const first = ex.run('n1', 'A protocol switch', () => new Promise<string>((r) => (release = () => r('done'))));
    expect(ex.current('n1')).toBe('A protocol switch');
    await expect(ex.run('n1', 'An HNS resolver switch', async () => 'x')).rejects.toThrow(/A protocol switch is still running on this node.*Try again when it finishes/);
    release();
    await expect(first).resolves.toBe('done');
    expect(ex.current('n1')).toBeUndefined();
    await expect(ex.run('n1', 'A restart', async () => 'ok')).resolves.toBe('ok');
  });
  it('other nodes run side by side, and a failed job frees the node', async () => {
    const ex = keyedExclusive();
    let release!: () => void;
    const a = ex.run('n1', 'A restart', () => new Promise<void>((r) => (release = r)));
    await expect(ex.run('n2', 'A restart', async () => 2)).resolves.toBe(2);
    release();
    await a;
    await expect(ex.run('n1', 'A price change', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(ex.current('n1')).toBeUndefined();
  });
});
