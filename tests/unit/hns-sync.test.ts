import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0.0.0' } }));
const { parseHnsSync, hnsSyncState, HNS_STALL_SEC } = await import('../../src/main/services/hnsd');

// ─── HNS chain sync (image 0.3.5) ───
// "hnsd running" was only `pidof hnsd`, which the supervisor also matches; a node whose hnsd can't
// reach peers or is still syncing showed "Routing users' DNS" while HNS names failed.
// Real numbers: on 2026-11-12 ~13:00Z hnsd reached height 355483 (container clock 1794488000).

const NOW = 1_794_488_000;

describe('parseHnsSync', () => {
  it('reads height, age and the container clock', () => {
    expect(parseHnsSync(`HNSD\nROUTING\nHSTAT 355483 ${NOW - 30} NOW ${NOW}\n`)).toEqual({ height: 355483, ageSec: 30, nowSec: NOW });
  });
  it('no status file (image before 0.3.5) -> undefined', () => {
    expect(parseHnsSync(`HNSD\nHSTAT  NOW ${NOW}\n`)).toBeUndefined();
    expect(parseHnsSync('HNSD\n')).toBeUndefined();
  });
  it('the supervisor start line "0 <time>" means no header yet', () => {
    expect(parseHnsSync(`HSTAT 0 ${NOW - 10} NOW ${NOW}`)).toEqual({ height: undefined, ageSec: 10, nowSec: NOW });
  });
  it('a clock behind the status time never gives a negative age', () => {
    expect(parseHnsSync(`HSTAT 355483 ${NOW + 5} NOW ${NOW}`)?.ageSec).toBe(0);
  });
});

describe('hnsSyncState', () => {
  it('older image: unknown (the UI keeps the old label)', () => {
    expect(hnsSyncState(undefined).state).toBe('unknown');
  });
  it('at the tip: synced', () => {
    const r = hnsSyncState({ height: 355483, ageSec: 120, nowSec: NOW });
    expect(r.state).toBe('synced');
    expect(r.percent).toBeGreaterThanOrEqual(99);
  });
  it('mid-sync: syncing with a percentage', () => {
    const r = hnsSyncState({ height: 163120, ageSec: 2, nowSec: NOW });
    expect(r.state).toBe('syncing');
    expect(r.percent).toBe(45);
  });
  it('0.5% behind the tip (a fresh checkpoint restart) is still syncing, not synced', () => {
    // P21: right after a restart hnsd sat at the checkpoint height 352000, ~4,000 blocks behind.
    expect(hnsSyncState({ height: 352000, ageSec: 5, nowSec: NOW }).state).toBe('syncing');
  });
  it('no new header for 45 min: stalled, even at the tip', () => {
    expect(hnsSyncState({ height: 355483, ageSec: HNS_STALL_SEC + 1, nowSec: NOW }).state).toBe('stalled');
    expect(hnsSyncState({ height: 355483, ageSec: HNS_STALL_SEC - 1, nowSec: NOW }).state).toBe('synced');
  });
  it('never reached a peer: starting, then stalled after 45 min', () => {
    expect(hnsSyncState({ height: undefined, ageSec: 60, nowSec: NOW }).state).toBe('starting');
    expect(hnsSyncState({ height: undefined, ageSec: HNS_STALL_SEC + 1, nowSec: NOW }).state).toBe('stalled');
  });
});
