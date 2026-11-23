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
vi.mock('../../src/main/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
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

  // NM032 changed this rule: a .bak exists only after an earlier save, so a missing store beside one is
  // lost data (a crash between unlink and rename, a deleted file), not a fresh install.
  it('a missing store with a backup is restored from the backup (NM032)', async () => {
    writeFileSync(BAK, JSON.stringify(good));
    const { readStore } = await fresh();
    expect((await readStore()).nodes.map((n) => n.id)).toEqual(['n1']);
  });

  it('control: a missing store with no backup is a fresh install: empty, no event', async () => {
    const { readStore } = await fresh();
    const s = await readStore();
    expect(s.nodes).toEqual([]);
    expect(s.events).toEqual([]);
  });

  // Q0596: the backup used to copy the previous file at most every 5 minutes, so a restore brought
  // back h1-b at 0.004 after a change to 0.005 (rc8 S6), and could miss a node deployed minutes earlier.
  it('a price change reaches the backup at once (Q0596)', async () => {
    writeFileSync(STORE, JSON.stringify({ ...good, nodes: [{ id: 'n1', moniker: 'kept', gigabytePriceDVPN: 0.004 }] }));
    const { readStore, writeStore } = await fresh();
    const s = await readStore();
    await writeStore(s);
    await writeStore({ ...s, nodes: [{ ...s.nodes[0], gigabytePriceDVPN: 0.005 }] });
    expect(JSON.parse(readFileSync(BAK, 'utf8')).nodes[0].gigabytePriceDVPN).toBe(0.005);
  });

  it('a new node and its key backup reach the backup at once', async () => {
    writeFileSync(STORE, JSON.stringify(good));
    const { readStore, writeStore } = await fresh();
    const s = await readStore();
    await writeStore(s);
    await writeStore({ ...s, nodes: [...s.nodes, { id: 'n2', moniker: 'new' } as never], nodeBackups: { ...s.nodeBackups, n2: 'blob2' } });
    const bak = JSON.parse(readFileSync(BAK, 'utf8'));
    expect(bak.nodes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2']);
    expect(bak.nodeBackups.n2).toBe('blob2');
  });

  it('control: a save with no nodes never replaces a backup that has some', async () => {
    writeFileSync(STORE, JSON.stringify(good));
    const { readStore, writeStore } = await fresh();
    const s = await readStore();
    await writeStore(s);
    await writeStore({ ...s, nodes: [] });
    expect(JSON.parse(readFileSync(BAK, 'utf8')).nodes[0].id).toBe('n1');
    expect(JSON.parse(readFileSync(STORE, 'utf8')).nodes).toEqual([]);
  });
});
