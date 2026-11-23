import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── NM032: a user's node list vanished after an unclean shutdown ───
// 0.3.0 reported store problems only on stderr (his app.log showed nothing), never flushed a save
// before the rename, and a store.json that disappeared beside a good backup started empty.

const DIR = mkdtempSync(path.join(os.tmpdir(), 'snm-store-dur-'));
const warn = vi.fn();
const info = vi.fn();
vi.mock('electron', () => ({ app: { getPath: () => DIR } }));
vi.mock('../../src/main/services/logger', () => ({ log: { info, warn, debug: vi.fn(), error: vi.fn() } }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const STORE = path.join(DIR, 'store.json');
const BAK = `${STORE}.bak`;
const good = { wallet: { address: 'W' }, nodes: [{ id: 'n1', moniker: 'kept' }], events: [], logs: {}, nodeBackups: { n1: 'blob' } };

async function fresh() {
  vi.resetModules();
  return import('../../src/main/services/store');
}

beforeEach(() => {
  for (const f of readdirSync(DIR)) rmSync(path.join(DIR, f), { force: true });
  warn.mockClear();
  info.mockClear();
});

describe('store durability (NM032)', () => {
  it('store.json missing but a backup exists: restores the backup and logs it to app.log', async () => {
    writeFileSync(BAK, JSON.stringify(good));
    const { readStore } = await fresh();
    const s = await readStore();
    expect(s.nodes.map((n) => n.moniker)).toEqual(['kept']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('restored 1 node(s) from store.json.bak'), undefined);
  });

  it('control: first run (no store, no backup) starts empty without a warning', async () => {
    const { readStore } = await fresh();
    expect((await readStore()).nodes).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a damaged store.json is reported in app.log, not only stderr', async () => {
    writeFileSync(STORE, '\0\0\0\0');
    writeFileSync(BAK, JSON.stringify(good));
    const { readStore } = await fresh();
    expect((await readStore()).nodes).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store.json unreadable; restored 1 node(s)'), expect.objectContaining({ err: expect.any(String) }));
  });

  it('a load logs the node count, so app.log shows when a list went empty', async () => {
    writeFileSync(STORE, JSON.stringify(good));
    const { readStore } = await fresh();
    await readStore();
    expect(info).toHaveBeenCalledWith('store loaded', expect.objectContaining({ nodes: 1, wallet: 'set' }));
  });

  it('a store.json damaged on disk never reaches the backup (written from the saved state, Q0596)', async () => {
    writeFileSync(STORE, JSON.stringify(good));
    const { readStore, writeStore } = await fresh();
    const s = await readStore();
    writeFileSync(BAK, JSON.stringify(good));
    writeFileSync(STORE, '{"nodes": [trunc'); // damaged on disk after the load
    await writeStore({ ...s, events: [] });
    const bak = readFileSync(BAK, 'utf8');
    expect(bak).not.toContain('trunc');
    expect(JSON.parse(bak).nodes).toHaveLength(1);
  });

  it('a save leaves a complete, parseable store.json and no temp files', async () => {
    const { readStore, writeStore } = await fresh();
    const s = await readStore();
    await writeStore({ ...s, nodes: [{ id: 'a' } as never, { id: 'b' } as never] });
    expect(JSON.parse(readFileSync(STORE, 'utf8')).nodes).toHaveLength(2);
    expect(readdirSync(DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Q0596: the backup is a second copy of the saved state from the first save on.
    expect(JSON.parse(readFileSync(BAK, 'utf8')).nodes).toHaveLength(2);
    expect(readdirSync(DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
