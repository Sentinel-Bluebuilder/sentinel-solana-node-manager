import { safeStorage } from 'electron';
import type { SSHCredentials } from '../../shared/types';
import { log } from './logger';
import { readStore, writeStore } from './store';

/**
 * Saved server logins (NM032, owner decision 2026-11-22: opt-in tick box, ON by default).
 *
 * Before 0.3.2 SSH logins lived only in memory, so after every restart each remote node
 * waited for a manual Reconnect, and a user whose node list was lost had no way back in
 * short of typing every login again. A login the user chooses to remember is kept here,
 * encrypted with the OS keychain (safeStorage, the same protection as the wallet), keyed by
 * host:port. Nothing is saved without the tick box; Settings can forget any of them.
 */

export interface SavedLoginInfo {
  host: string;
  port: number;
  username: string;
  method: 'password' | 'key';
  savedAt: string;
}

interface VaultEntry {
  creds: SSHCredentials;
  savedAt: string;
}

export function vaultKey(host: string, port?: number): string {
  return `${host.trim().toLowerCase()}:${port || 22}`;
}

function encrypt(entry: VaultEntry): string {
  return safeStorage.encryptString(JSON.stringify(entry)).toString('base64');
}

function decrypt(blob: string): VaultEntry {
  return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))) as VaultEntry;
}

/** Keep a login. Refuses (rather than storing in plain text) when the OS keychain is unavailable. */
export async function saveLogin(creds: SSHCredentials): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This computer has no OS keychain, so the login cannot be saved safely. It is used for this session only.');
  }
  const clean: SSHCredentials = {
    host: creds.host.trim(),
    port: creds.port || 22,
    username: creds.username,
    ...(creds.privateKey ? { privateKey: creds.privateKey, ...(creds.passphrase ? { passphrase: creds.passphrase } : {}) } : { password: creds.password }),
  };
  const store = await readStore();
  store.sshVault = { ...(store.sshVault ?? {}), [vaultKey(clean.host, clean.port)]: encrypt({ creds: clean, savedAt: new Date().toISOString() }) };
  await writeStore(store);
  log.info('server login saved', { host: clean.host, port: clean.port, method: clean.privateKey ? 'key' : 'password' });
}

export async function forgetLogin(host: string, port?: number): Promise<{ removed: boolean }> {
  const store = await readStore();
  const k = vaultKey(host, port);
  if (!store.sshVault?.[k]) return { removed: false };
  const next = { ...store.sshVault };
  delete next[k];
  store.sshVault = next;
  await writeStore(store);
  log.info('server login forgotten', { host, port: port || 22 });
  return { removed: true };
}

/** The saved login for a host, or null. A blob this keychain cannot open is skipped and logged. */
export async function savedLoginFor(host: string, port?: number): Promise<SSHCredentials | null> {
  const blob = (await readStore()).sshVault?.[vaultKey(host, port)];
  if (!blob) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return decrypt(blob).creds;
  } catch (err) {
    log.warn('saved server login could not be decrypted; Reconnect will ask again', { host, err: (err as Error).message });
    return null;
  }
}

/** For Settings: what is saved, never the secret itself. */
export async function listSavedLogins(): Promise<SavedLoginInfo[]> {
  const vault = (await readStore()).sshVault ?? {};
  const out: SavedLoginInfo[] = [];
  if (!safeStorage.isEncryptionAvailable()) return out;
  for (const [k, blob] of Object.entries(vault)) {
    try {
      const { creds, savedAt } = decrypt(blob);
      out.push({ host: creds.host, port: creds.port || 22, username: creds.username, method: creds.privateKey ? 'key' : 'password', savedAt });
    } catch (err) {
      log.warn('saved server login unreadable', { key: k, err: (err as Error).message });
    }
  }
  return out.sort((a, b) => a.host.localeCompare(b.host));
}
