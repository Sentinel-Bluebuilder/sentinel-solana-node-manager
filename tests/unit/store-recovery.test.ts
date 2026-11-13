import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── T8 (0.3.1): a damaged store.json ───
// Before: an unreadable store started empty and the next save overwrote it, losing every node
// record and the encrypted node keys (store.nodeBackups). Now: the damaged file is kept aside,
// the rolling backup is restored, the first save does not copy the damaged file over the
// backup, and the Activity feed says what happened.

const DIR = mkdtempSync(path.join(os.tmpdir(), 'snm-store-rec-'));
vi.mock('electron', () => ({ app: { getPath: () => DIR } }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const STORE = path.join(DIR, 'store.json');
const BAK = `${STORE}.bak`;
const good = { wallet: null, nodes: [{ id: 'n1', moniker: 'kept' }], events: [], logs: {}, nodeBackups: { n1: 'blob' } };

async function fresh() {
  vi.resetModules();
  return import('../../src/main/services/store');
}

beforeEach(() => {
  for (const f of readdirSync(DIR)) rmSync(path.join(DIR, f), { force: true });
});

describe('store recovery', () => {
  it('restores the backup, keeps the damaged file, and says so in Activity', async () => {
    writeFileSync(BAK, JSON.stringify(good));
    writeFileSync(STORE, '{"nodes": [ {"id": "n1", "mon'); // truncated on disk
    const { readStore, writeStore } = await fresh();
    const s = await readStore();
    expect(s.nodes.map((n) => n.id)).toEqual(['n1']);
    expect(s.nodeBackups).toEqual({ n1: 'blob' });
    expect(s.events[0]?.kind).toBe('store-recovered');
    expect(s.events[0]?.title).toMatch(/restored from a backup/);
    const damaged = readdirSync(DIR).filter((f) => f.startsWith('store.json.damaged-'));
    expect(damaged).toHaveLength(1);
    expect(readFileSync(path.join(DIR, damaged[0]), 'utf8')).toContain('"mon');
    // First save after recovery: the damaged file on disk must not replace the good backup.
    await writeStore(s);
    expect(JSON.parse(readFileSync(BAK, 'utf8')).nodeBackups).toEqual({ n1: 'blob' });
    expect(JSON.parse(readFileSync(STORE, 'utf8')).nodes[0].id).toBe('n1');
  });

  it('callers racing at startup share one recovery (one damaged copy, one event)', async () => {
    writeFileSync(BAK, JSON.stringify(good));
    writeFileSync(STORE, '{"nodes": [');
    const { readStore } = await fresh();
    const [a, b, c] = await Promise.all([readStore(), readStore(), readStore()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(readdirSync(DIR).filter((f) => f.startsWith('store.json.damaged-'))).toHaveLength(1);
    expect(a.events.filter((e) => e.kind === 'store-recovered')).toHaveLength(1);
  });

  it('with no usable backup: starts empty but never loses the damaged file', async () => {
    writeFileSync(STORE, 'garbage');
    const { readStore } = await fresh();
    const s = await readStore();
    expect(s.nodes).toEqual([]);
    expect(s.events[0]?.title).toMatch(/could not be restored/);
    expect(s.events[0]?.subtitle).toMatch(/Do not delete the damaged file/);
    expect(readdirSync(DIR).some((f) => f.startsWith('store.json.damaged-'))).toBe(true);
  });

  it('a valid JSON value that is not a store (null, a list) counts as damaged', async () => {
    writeFileSync(BAK, JSON.stringify(good));
    writeFileSync(STORE, 'null');
    const { readStore } = await fresh();
    expect((await readStore()).nodes.map((n) => n.id)).toEqual(['n1']);
  });

  it('a missing store is a fresh install: empty, no event, no backup resurrected', async () => {
    writeFileSync(BAK, JSON.stringify(good));
    const { readStore } = await fresh();
    const s = await readStore();
    expect(s.nodes).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it('the first save of a session copies the previous store to the backup', async () => {
    writeFileSync(STORE, JSON.stringify(good));
    const { readStore, writeStore } = await fresh();
    const s = await readStore();
    await writeStore({ ...s, nodes: [] });
    expect(JSON.parse(readFileSync(BAK, 'utf8')).nodes[0].id).toBe('n1');
    expect(JSON.parse(readFileSync(STORE, 'utf8')).nodes).toEqual([]);
  });
});
