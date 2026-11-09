import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// ─── Node image source identity ───
// Pure helpers (no Electron, no Docker) so unit tests can load them directly.

/**
 * Which upstream tree Settings.upstreamDir holds. cb33 (public sentinel-solana
 * 26de5240) ships the CLI as `sentinel-dvpn/`; the older trees as `sentinel-dvpnctl/`.
 */
export type SourceKind = 'legacy' | 'cb33';

/** The modules the image is built from, as packBuildContext ships them (older trees). */
export const BUILD_MODULES = ['sentinel-go-sdk', 'sentinel-programs/clients/go', 'sentinel-dvpnd', 'sentinel-dvpnctl'];
export const CB33_BUILD_MODULES = ['sentinel-go-sdk', 'sentinel-programs/clients/go', 'sentinel-dvpnd', 'sentinel-dvpn'];
const SKIP_DIRS = new Set(['bin', '.git', 'node_modules']);

export function modulesFor(kind: SourceKind): string[] {
  return kind === 'cb33' ? CB33_BUILD_MODULES : BUILD_MODULES;
}

/** cb33 when the tree has sentinel-dvpn/go.mod and no sentinel-dvpnctl/. */
export async function sourceKind(upstreamDir: string): Promise<SourceKind> {
  const has = (rel: string): Promise<boolean> =>
    fs.access(path.join(upstreamDir, rel)).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw new Error(`reading the node image source at "${upstreamDir}": ${err.message}`);
        return false;
      },
    );
  if ((await has('sentinel-dvpn/go.mod')) && !(await has('sentinel-dvpnctl'))) return 'cb33';
  return 'legacy';
}

/**
 * Hash of every file the build reads from the source tree (same excludes as the
 * build context: bin/, .git, node_modules, *_test.go). Path and content both
 * count, so an edit, an added file or a newer checkout all give a new value,
 * with or without git.
 */
export async function sourceFingerprint(upstreamDir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(path.join(upstreamDir, rel), { withFileTypes: true });
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(child);
      } else if (e.isFile() && !e.name.endsWith('_test.go')) {
        files.push(child);
      }
    }
  };
  for (const m of modulesFor(await sourceKind(upstreamDir))) await walk(m);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f).update('\0');
    h.update(await fs.readFile(path.join(upstreamDir, f))).update('\0');
  }
  return h.digest('hex');
}

// ─── Source version (GIT_COMMIT / GIT_TAG build args) ───

export interface SourceVersion {
  GIT_COMMIT: string;
  GIT_TAG: string;
}

/** Commit / tag text that is safe as a build arg and inside a remote shell line. */
const VERSION_VALUE_RE = /^[0-9A-Za-z._+-]{1,100}$/;
export const VERSION_FILE = 'VERSION';

/**
 * Parse a `VERSION` file: `GIT_COMMIT=<sha>` and `GIT_TAG=<tag>` lines (blank
 * lines and `#` comments allowed). Throws on an unknown key or an unsafe value,
 * so a typo can never build an image that claims the wrong version.
 */
export function parseVersionFile(text: string): Partial<SourceVersion> {
  const out: Partial<SourceVersion> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new Error(`${VERSION_FILE}: cannot read line "${line}" (expected KEY=value)`);
    const [, key, value] = m;
    if (key !== 'GIT_COMMIT' && key !== 'GIT_TAG') throw new Error(`${VERSION_FILE}: unknown key ${key} (only GIT_COMMIT and GIT_TAG)`);
    if (!VERSION_VALUE_RE.test(value)) throw new Error(`${VERSION_FILE}: ${key} "${value}" has characters other than letters, digits and . _ + -`);
    out[key] = value;
  }
  return out;
}

function git(dir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      const v = String(stdout ?? '').trim();
      resolve(err || !VERSION_VALUE_RE.test(v) ? undefined : v);
    });
  });
}

/**
 * What the daemon's `version` will print. A source export (e.g. `git archive`) has
 * no .git, so the Makefile's own `git describe` gives "unknown": a `VERSION`
 * file at the source root says it instead. Without one, the same git commands
 * as the Makefile (commit hash, `describe --tags --always --dirty`, leading v
 * dropped), and "unknown" when the folder is not a git checkout.
 */
export async function sourceVersion(upstreamDir: string): Promise<SourceVersion> {
  let fromFile: Partial<SourceVersion> = {};
  try {
    fromFile = parseVersionFile(await fs.readFile(path.join(upstreamDir, VERSION_FILE), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const commit = fromFile.GIT_COMMIT ?? (await git(upstreamDir, ['log', '-1', '--format=%H']));
  const tag = fromFile.GIT_TAG ?? (await git(upstreamDir, ['describe', '--tags', '--always', '--dirty']))?.replace(/^v/, '');
  return { GIT_COMMIT: commit ?? 'unknown', GIT_TAG: tag ?? 'unknown' };
}

/** `<repo>:devnet-<10 hex>` from the Dockerfile, the build args and (when given) the source fingerprint. */
export function imageTagFrom(repo: string, dockerfile: string, buildArgs: Record<string, string>, sourceFp?: string): string {
  const h = createHash('sha256').update(dockerfile).update(JSON.stringify(buildArgs));
  if (sourceFp !== undefined) h.update(sourceFp);
  return `${repo}:devnet-${h.digest('hex').slice(0, 10)}`;
}
