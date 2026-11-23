import { afterEach, describe, expect, it, vi } from 'vitest';

// ─── Q0598: a server that does not answer is remembered for a minute ───
// rc10 S4: a status check against a stopped server never finished in practice (~80 s each, run by
// the window, the poller and the CLI at once), so its nodes read 'online'. Now one failed connect
// marks the server down for HOST_DOWN_TTL_MS and status answers at once.

vi.mock('../../src/main/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const live = await import('../../src/main/services/host-liveness');

afterEach(() => {
  vi.useRealTimers();
  live.noteHostUp('20.115.161.26');
});

describe('host liveness memory', () => {
  it('a server that did not answer reads down at once, and again for the whole minute', () => {
    vi.useFakeTimers();
    live.noteHostDown('20.115.161.26', '20.115.161.26:22 does not answer over SSH');
    expect(live.hostDownNow('20.115.161.26')?.message).toMatch(/does not answer/);
    vi.advanceTimersByTime(live.HOST_DOWN_TTL_MS - 1);
    expect(live.hostDownNow('20.115.161.26')).toBeDefined();
  });

  it('after the minute it is probed again (not down from memory)', () => {
    vi.useFakeTimers();
    live.noteHostDown('20.115.161.26', 'x does not answer over SSH');
    vi.advanceTimersByTime(live.HOST_DOWN_TTL_MS + 1);
    expect(live.hostDownNow('20.115.161.26')).toBeUndefined();
  });

  it('a server that answers again is not down; other servers never were (controls)', () => {
    live.noteHostDown('20.115.161.26', 'x does not answer over SSH');
    live.noteHostUp('20.115.161.26');
    expect(live.hostDownNow('20.115.161.26')).toBeUndefined();
    expect(live.hostDownNow('20.98.93.220')).toBeUndefined();
    expect(live.hostDownNow(undefined)).toBeUndefined();
  });

  it('a probe that never settles fails with a "does not answer" error after the limit', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const p = live.withTimeout(never, 90_000, '20.115.161.26');
    const check = expect(p).rejects.toThrow(/20\.115\.161\.26 does not answer over SSH/);
    vi.advanceTimersByTime(90_001);
    await check;
  });
});

// ─── Q0602: one RPC 429 at app start marked three healthy nodes not live (rc12) ───
describe('provesNotLive', () => {
  it('a throttled or failed chain read is unknown, not "not live"', () => {
    expect(live.provesNotLive({ reachable: false })).toBe(false);
  });
  it('a server that does not answer is not live (Q0598)', () => {
    expect(live.provesNotLive({ reachable: false, serverDown: true })).toBe(true);
  });
  it('a chain read that says delisted / expired / gone is not live', () => {
    expect(live.provesNotLive({ reachable: false, chainStatus: 'delisted' })).toBe(true);
    expect(live.provesNotLive({ reachable: false, chainStatus: 'listed' })).toBe(true); // listing expired
    expect(live.provesNotLive({ reachable: false, chainStatus: 'not-found' })).toBe(true);
  });
  it('control: a reachable node is never not live', () => {
    expect(live.provesNotLive({ reachable: true, serverDown: true, chainStatus: 'listed' })).toBe(false);
  });
});
