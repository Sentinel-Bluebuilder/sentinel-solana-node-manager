import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger';

/**
 * Lightweight TOFU (trust-on-first-use) record for SSH host keys.
 *
 * First contact records the host key's SHA-256; a later connection that
 * presents a DIFFERENT key is refused by ssh.ts's hostVerifier (and logged
 * with both fingerprints) until the user runs ssh.forgetHostKey after
 * checking the host out of band.
 */

type HostKeyMap = Record<string, { sha256: string; firstSeen: string; lastSeen: string }>;

let cache: HostKeyMap | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'known-hosts.json');
}

async function load(): Promise<HostKeyMap> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(file(), 'utf8');
    cache = JSON.parse(raw) as HostKeyMap;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('known-hosts unreadable, starting empty', { err: (err as Error).message });
    cache = {};
  }
  return cache;
}

async function save(): Promise<void> {
  if (!cache) return;
  try {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    log.warn('failed to persist known-hosts', { err: String(err) });
  }
}

export async function knownHostKey(host: string, port: number): Promise<string | null> {
  const map = await load();
  return map[`${host}:${port}`]?.sha256 ?? null;
}

export async function rememberHostKey(
  host: string,
  port: number,
  sha256: string,
): Promise<{ status: 'new' | 'match' | 'changed'; previous?: string }> {
  const map = await load();
  const key = `${host}:${port}`;
  const now = new Date().toISOString();
  const existing = map[key];
  if (!existing) {
    map[key] = { sha256, firstSeen: now, lastSeen: now };
    await save();
    return { status: 'new' };
  }
  if (existing.sha256 === sha256) {
    existing.lastSeen = now;
    await save();
    return { status: 'match' };
  }
  const previous = existing.sha256;
  log.warn('SSH host key changed — possible MITM or host re-keyed', {
    host,
    port,
    previous,
    current: sha256,
  });
  // Do NOT auto-overwrite the stored fingerprint. We keep the original
  // first-seen value so the connection is blocked at the verifier layer
  // until the user explicitly trusts the new key (forgetHostKey + reconnect).
  return { status: 'changed', previous };
}

/**
 * Drop the stored fingerprint for a host so the next connection treats it
 * as TOFU-fresh. Use after a user explicitly accepts a new host key, or
 * when retiring a host.
 */
export async function forgetHostKey(host: string, port: number): Promise<void> {
  const map = await load();
  delete map[`${host}:${port}`];
  await save();
}
