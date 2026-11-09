import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_IDLE_LIMIT_MS,
  IMAGE_BUILD_NETWORK,
  buildStalledError,
  idleWatchdog,
} from '../../src/main/services/validate';

// ─── Q0405: image build behind a sub-1500 MTU ───
// On a VPS whose NIC MTU is 1450/1400, the 1500 Docker bridge loses large TLS packets, `apk add`
// hangs, and the deploy only failed at the 45-min build timeout. Builds now run on the host
// network, and a build silent for BUILD_IDLE_LIMIT_MS is stopped with a network hint.

describe('IMAGE_BUILD_NETWORK', () => {
  it('builds on the host network', () => {
    expect([...IMAGE_BUILD_NETWORK]).toEqual(['--network', 'host']);
  });
});

describe('BUILD_IDLE_LIMIT_MS', () => {
  it('fails a silent build well before the 45-min build timeout', () => {
    expect(BUILD_IDLE_LIMIT_MS).toBeLessThanOrEqual(15 * 60_000);
    expect(BUILD_IDLE_LIMIT_MS).toBeLessThan(45 * 60_000);
  });
  it('leaves room for a quiet Go compile (at least 5 min)', () => {
    expect(BUILD_IDLE_LIMIT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('idleWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the limit with no output', () => {
    const onIdle = vi.fn();
    idleWatchdog(1000, onIdle);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
  it('steady output (poke) keeps a long build alive', () => {
    const onIdle = vi.fn();
    const w = idleWatchdog(1000, onIdle);
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(900);
      w.poke();
    }
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
  it('stop() cancels it (a finished build never fires)', () => {
    const onIdle = vi.fn();
    const w = idleWatchdog(1000, onIdle);
    w.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('buildStalledError', () => {
  it('names where, how long, the last line and the network cause', () => {
    const m = buildStalledError('vps-1 (203.0.113.10)', 15 * 60_000, '#7 [build 2/9] RUN apk add --no-cache git make').message;
    expect(m).toContain('on vps-1 (203.0.113.10) printed nothing for 15 minutes');
    expect(m).toContain('RUN apk add');
    expect(m).toContain('MTU');
    expect(m).toContain('deploy again');
  });
});
