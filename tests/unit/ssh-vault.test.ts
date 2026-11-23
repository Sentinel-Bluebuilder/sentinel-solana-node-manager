import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── NM032: saved server logins ───
// Logins were memory-only, so every restart (and a lost node list) meant typing each one again.
// A remembered login is kept encrypted (safeStorage) and never in plain text.

const DIR = mkdtempSync(path.join(os.tmpdir(), 'snm-vault-'));
let keychain = true;
// A reversible stand-in for the OS keychain: the plain text must never reach store.json.
const enc = (s: string) => Buffer.from(`ENC:${Buffer.from(s).toString('hex')}`);
const dec = (b: Buffer) => {
  const t = b.toString();
  if (!t.startsWith('ENC:')) throw new Error('bad blob');
  return Buffer.from(t.slice(4), 'hex').toString();
};
vi.mock('electron', () => ({
  app: { getPath: () => DIR },
  safeStorage: { isEncryptionAvailable: () => keychain, encryptString: enc, decryptString: dec },
}));
vi.mock('../../src/main/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const vault = await import('../../src/main/services/ssh-vault');
const { readStore, writeStore } = await import('../../src/main/services/store');

beforeEach(async () => {
  keychain = true;
  const s = await readStore();
  await writeStore({ ...s, sshVault: {} });
});

describe('ssh vault', () => {
  it('saves, finds and forgets a password login; the password never appears in store.json', async () => {
    await vault.saveLogin({ host: '10.0.0.5', port: 22, username: 'root', password: 'hunter2-secret' });
    expect(readFileSync(path.join(DIR, 'store.json'), 'utf8')).not.toContain('hunter2-secret');
    expect(await vault.savedLoginFor('10.0.0.5')).toEqual({ host: '10.0.0.5', port: 22, username: 'root', password: 'hunter2-secret' });
    expect(await vault.listSavedLogins()).toEqual([expect.objectContaining({ host: '10.0.0.5', port: 22, username: 'root', method: 'password' })]);
    expect(JSON.stringify(await vault.listSavedLogins())).not.toContain('hunter2');
    expect(await vault.forgetLogin('10.0.0.5', 22)).toEqual({ removed: true });
    expect(await vault.savedLoginFor('10.0.0.5')).toBeNull();
  });

  it('a key login keeps the key + passphrase and drops any password', async () => {
    await vault.saveLogin({ host: 'h2', port: 2222, username: 'ubuntu', privateKey: 'KEY', passphrase: 'pp', password: 'ignored' });
    expect(await vault.savedLoginFor('h2', 2222)).toEqual({ host: 'h2', port: 2222, username: 'ubuntu', privateKey: 'KEY', passphrase: 'pp' });
    expect(await vault.savedLoginFor('h2', 22)).toBeNull(); // port is part of the key
  });

  it('refuses to save without an OS keychain (never falls back to plain text)', async () => {
    keychain = false;
    await expect(vault.saveLogin({ host: 'h3', port: 22, username: 'root', password: 'pw' })).rejects.toThrow(/no OS keychain/);
    expect((await readStore()).sshVault).toEqual({});
  });

  it('a blob this keychain cannot open is skipped, not thrown', async () => {
    const s = await readStore();
    await writeStore({ ...s, sshVault: { [vault.vaultKey('h4')]: Buffer.from('garbage').toString('base64') } });
    expect(await vault.savedLoginFor('h4')).toBeNull();
    expect(await vault.listSavedLogins()).toEqual([]);
  });

  it('host keys are case-insensitive and default to port 22', () => {
    expect(vault.vaultKey(' Example.COM ')).toBe('example.com:22');
  });
});
