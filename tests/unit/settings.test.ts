import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) =>
      k === 'home' ? (process.env['SENTINEL_TEST_HOME'] ?? '/home/test') : (process.env['SENTINEL_TEST_USERDATA'] ?? ''),
  },
}));

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-settings-'));
  process.env['SENTINEL_TEST_USERDATA'] = tmp;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  delete process.env['SENTINEL_TEST_USERDATA'];
  delete process.env['SENTINEL_TEST_HOME'];
});

describe('settings persistence', () => {
  it('returns defaults when no settings.json exists', async () => {
    const { getSettings } = await import('../../src/main/services/settings');
    const s = await getSettings();
    expect(s.priorityFeeMicroLamports).toBe(0);
    expect(s.rpcUrls).toEqual(['https://api.devnet.solana.com']);
    expect(s.upstreamDir).toMatch(/sentinel-solana[\\/]upstream$/);
    expect(s.dockerSocket).toBe('');
    expect(s.seenOnboarding).toBe(false);
  });

  it('persists a patch and returns it on the next read', async () => {
    const { getSettings, updateSettings } = await import('../../src/main/services/settings');
    await updateSettings({
      priorityFeeMicroLamports: 5000,
      seenOnboarding: true,
    });
    const s = await getSettings();
    expect(s.priorityFeeMicroLamports).toBe(5000);
    expect(s.seenOnboarding).toBe(true);
  });

  it('filters empty RPC URLs and resets to defaults when list becomes empty', async () => {
    const { updateSettings } = await import('../../src/main/services/settings');
    const s = await updateSettings({ rpcUrls: ['  ', '', ''] });
    // Empty list → defaults back to the pool
    expect(s.rpcUrls).toEqual(['https://api.devnet.solana.com']);
  });
});

// ─── Refuse bad values instead of storing or silently changing them ───
// Found by the 2026-10-24 test pass: "stopNodesOnQuit":"no" was saved as a truthy
// string, so nodes were stopped on quit; bad numbers were clamped with a success reply.

describe('settings validation', () => {
  it('refuses a switch that is not true/false, and keeps the stored value', async () => {
    const { getSettings, updateSettings } = await import('../../src/main/services/settings');
    await expect(updateSettings({ stopNodesOnQuit: 'no' as unknown as boolean })).rejects.toThrow(/stopNodesOnQuit must be true or false/);
    expect((await getSettings()).stopNodesOnQuit).toBe(false);
  });

  it('refuses an unknown key and a prototype key', async () => {
    const { updateSettings } = await import('../../src/main/services/settings');
    await expect(updateSettings({ nope: 1 } as never)).rejects.toThrow(/Unknown setting "nope"/);
    await expect(updateSettings(JSON.parse('{"__proto__":{"x":1}}'))).rejects.toThrow(/Unknown setting "__proto__"/);
  });

  it('refuses out-of-range numbers instead of clamping them', async () => {
    const { updateSettings } = await import('../../src/main/services/settings');
    await expect(updateSettings({ walletRefreshIntervalSec: -5 })).rejects.toThrow(/from 10 to 600/);
    await expect(updateSettings({ priorityFeeMicroLamports: 999_999_999_999 })).rejects.toThrow(/from 0 to 10000000/);
    await expect(updateSettings({ priorityFeeMicroLamports: 1.5 })).rejects.toThrow(/whole number/);
    await expect(updateSettings({ nodeRefreshIntervalSec: '60' as unknown as number })).rejects.toThrow(/whole number/);
  });

  it('refuses a bad RPC URL instead of falling back to the public pool', async () => {
    const { getSettings, updateSettings } = await import('../../src/main/services/settings');
    await expect(updateSettings({ rpcUrls: ['http://example.com'] })).rejects.toThrow(/RPC URL not accepted: http:\/\/example.com/);
    await expect(updateSettings({ rpcUrls: 'https://x' as unknown as string[] })).rejects.toThrow(/must be a list/);
    expect((await getSettings()).rpcUrls).toEqual(['https://api.devnet.solana.com']);
    const s = await updateSettings({ rpcUrls: [' https://rpc.example.org ', 'http://127.0.0.1:8899'] });
    expect(s.rpcUrls).toEqual(['https://rpc.example.org', 'http://127.0.0.1:8899']);
  });

  it('checks the source folder when it changes; blank means the default folder', async () => {
    const { updateSettings } = await import('../../src/main/services/settings');
    await expect(updateSettings({ upstreamDir: path.join(tmp, 'missing') })).rejects.toThrow(/not a node source folder/);
    await expect(updateSettings({ upstreamDir: 42 as unknown as string })).rejects.toThrow(/must be a folder path/);
    const src = path.join(tmp, 'src');
    await fs.mkdir(path.join(src, 'sentinel-dvpnd'), { recursive: true });
    expect((await updateSettings({ upstreamDir: src })).upstreamDir).toBe(src);

    // NM4: blank = the default folder, which must exist like any other (here it does not).
    process.env['SENTINEL_TEST_HOME'] = path.join(tmp, 'home');
    await expect(updateSettings({ upstreamDir: '' })).rejects.toThrow(/means the default folder.*not a node source folder/);
    expect((await updateSettings({ upstreamDir: src })).upstreamDir).toBe(src);

    const fallback = path.join(tmp, 'home', 'Desktop', 'sentinel-solana', 'upstream');
    await fs.mkdir(path.join(fallback, 'sentinel-dvpnd'), { recursive: true });
    expect((await updateSettings({ upstreamDir: '' })).upstreamDir).toBe(fallback);
  });

  it('lets an unchanged field through, so the Settings screen can send its whole draft', async () => {
    const { getSettings, updateSettings } = await import('../../src/main/services/settings');
    const draft = { ...(await getSettings()), seenOnboarding: true };
    // The default source folder does not exist here; it is unchanged, so the save passes.
    expect((await updateSettings(draft)).seenOnboarding).toBe(true);
  });

  it('refuses a docker socket path that is not a socket', async () => {
    const { updateSettings } = await import('../../src/main/services/settings');
    const plain = path.join(tmp, 'plain-file');
    await fs.writeFile(plain, 'x');
    await expect(updateSettings({ dockerSocket: plain })).rejects.toThrow(process.platform === 'win32' ? /named pipe/ : /not a socket/);
    expect((await updateSettings({ dockerSocket: '' })).dockerSocket).toBe('');
  });

  it('a switch saved with a wrong type by an older build reads back as its default', async () => {
    await fs.writeFile(path.join(tmp, 'settings.json'), JSON.stringify({ stopNodesOnQuit: 'no', priorityFeeMicroLamports: -3 }));
    const { getSettings } = await import('../../src/main/services/settings');
    const s = await getSettings();
    expect(s.stopNodesOnQuit).toBe(false);
    expect(s.priorityFeeMicroLamports).toBe(0);
  });
});
