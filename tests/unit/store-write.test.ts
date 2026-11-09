import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// ─── Q0408: concurrent store writes ───
// FLX2 (10-31): "wallet balance refresh failed: ENOENT … rename store.json.<pid>.<ms>.tmp ->
// store.json" right after a withdraw: two saves in one millisecond shared one temp file.

const DIR = mkdtempSync(path.join(os.tmpdir(), 'snm-store-'));
vi.mock('electron', () => ({ app: { getPath: () => DIR } }));

const { readStore, writeStore } = await import('../../src/main/services/store');

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe('writeStore under concurrency', () => {
  it('40 saves fired at once all succeed, the file holds the LAST one, no temp file is left', async () => {
    const base = await readStore();
    const writes = Array.from({ length: 40 }, (_, i) => writeStore({ ...base, events: [{ id: `e${i}` } as never] }));
    const results = await Promise.allSettled(writes);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const onDisk = JSON.parse(readFileSync(path.join(DIR, 'store.json'), 'utf8')) as { events: Array<{ id: string }> };
    expect(onDisk.events).toEqual([{ id: 'e39' }]);
    expect(readdirSync(DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('a failed save does not block the next one', async () => {
    const base = await readStore();
    const bad = writeStore({ ...base, events: [{ id: 'bad', loop: undefined } as never], nodes: { toJSON() { throw new Error('boom'); } } as never });
    await expect(bad).rejects.toThrow('boom');
    await writeStore({ ...base, events: [{ id: 'after' } as never] });
    const onDisk = JSON.parse(readFileSync(path.join(DIR, 'store.json'), 'utf8')) as { events: Array<{ id: string }> };
    expect(onDisk.events).toEqual([{ id: 'after' }]);
  });
});
