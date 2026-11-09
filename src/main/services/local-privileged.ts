// ─── Local node-home access when the node container wrote the files as root ───
// See privilegedFallbackApplies (validate.ts): every operation is tried with plain fs
// first; only an EACCES/EPERM on Linux as a non-root user is retried through `sudo -n`.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from './logger';
import { localSudoMissingError, privilegedFallbackApplies } from './validate';

let sudoUsable: boolean | undefined;

function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(args[0], args.slice(1), { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function sudo(args: string[], timeoutMs = 30_000): Promise<string> {
  // Probe with a command the suggested sudoers line allows (it allows only cat, install and rm).
  if (sudoUsable === undefined) sudoUsable = (await run(['sudo', '-n', 'cat', '/dev/null'], 15_000)).code === 0;
  if (!sudoUsable) throw new Error(localSudoMissingError(os.userInfo().username));
  const r = await run(['sudo', '-n', ...args], timeoutMs);
  if (r.code !== 0) throw new Error(`sudo ${args[0]} ${args[args.length - 1]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

/** Run `op`; on a root-ownership error (Linux, non-root) run `viaSudo` instead. */
export async function withRootFallback<T>(what: string, op: () => Promise<T>, viaSudo: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!privilegedFallbackApplies(err as NodeJS.ErrnoException, process.platform, process.getuid?.())) throw err;
    log.debug('node home is root-owned; retrying with sudo', { what, err: (err as Error).message });
    return viaSudo();
  }
}

export function sudoRead(file: string): Promise<string> {
  return sudo(['cat', '--', file]);
}

/** Write `content` to `file` (parents created) as root, with `mode`. */
export async function sudoWrite(file: string, content: string, mode: number): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-write-'));
  const src = path.join(tmp, 'f');
  try {
    await fs.writeFile(src, content, { mode: 0o600 });
    await sudo(['install', '-D', '-m', mode.toString(8), '--', src, file]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch((err: unknown) =>
      log.warn('temp file cleanup failed', { tmp, err: (err as Error).message }),
    );
  }
}

export async function sudoRemove(target: string, recursive: boolean): Promise<void> {
  await sudo(['rm', recursive ? '-rf' : '-f', '--', target], 60_000);
}

/** Remove a path, falling back to sudo when its contents are root-owned. */
export function removePath(target: string, recursive: boolean): Promise<void> {
  return withRootFallback(
    `rm ${target}`,
    () => fs.rm(target, { recursive, force: true }),
    () => sudoRemove(target, recursive),
  );
}
