import { describe, expect, it } from 'vitest';
import { statusWhileRemoving } from '../../src/main/services/validate';

// ─── Q0328: a node being removed never reads "online" ───
// FLX2 (10-31): during removal nodes.list said status "online" although the stop stage had
// already removed the container on the host.

describe('statusWhileRemoving', () => {
  it('no removal: the requested status passes through', () => {
    expect(statusWhileRemoving(undefined, 'online')).toBe('online');
    expect(statusWhileRemoving(undefined, 'error')).toBe('error');
  });
  it('redeem/stop: a late poll cannot set online (container may still be up → loading)', () => {
    expect(statusWhileRemoving('redeem', 'online')).toBe('loading');
    expect(statusWhileRemoving('stop', 'online')).toBe('loading');
    expect(statusWhileRemoving('stop', 'error')).toBe('error');
  });
  it('from delist on the container is gone → offline, whatever was requested', () => {
    for (const s of ['delist', 'close', 'unbonding', 'withdraw-bond', 'sweep', 'done'] as const) {
      expect(statusWhileRemoving(s, 'online')).toBe('offline');
      expect(statusWhileRemoving(s, 'loading')).toBe('offline');
    }
  });
});
