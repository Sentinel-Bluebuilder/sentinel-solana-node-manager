import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILD_MODULES,
  imageTagFrom,
  parseVersionFile,
  sourceFingerprint,
  sourceVersion,
} from '../../src/main/services/image-source';

// ─── Image tag follows the source ───
// Bug: the tag hashed only the Dockerfile + build args, so pointing upstreamDir at a
// newer tree reused an image with the old dvpnd under the same name.

let dir: string;

async function put(rel: string, content: string): Promise<void> {
  const p = path.join(dir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'img-src-'));
  for (const m of BUILD_MODULES) await put(`${m}/go.mod`, `module ${m}\n`);
  await put('sentinel-dvpnd/cmd/main.go', 'package main\n');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('sourceFingerprint', () => {
  it('is stable for the same tree', async () => {
    expect(await sourceFingerprint(dir)).toBe(await sourceFingerprint(dir));
  });

  it('changes when a source file changes', async () => {
    const before = await sourceFingerprint(dir);
    await put('sentinel-dvpnd/cmd/main.go', 'package main // newer daemon\n');
    expect(await sourceFingerprint(dir)).not.toBe(before);
  });

  it('changes when a file is added', async () => {
    const before = await sourceFingerprint(dir);
    await put('sentinel-go-sdk/extra.go', 'package sdk\n');
    expect(await sourceFingerprint(dir)).not.toBe(before);
  });

  it('ignores what the build context leaves out (tests, bin, .git, node_modules, other folders)', async () => {
    const before = await sourceFingerprint(dir);
    await put('sentinel-dvpnd/cmd/main_test.go', 'package main\n');
    await put('sentinel-dvpnd/bin/dvpnd', 'binary');
    await put('sentinel-dvpnd/.git/HEAD', 'ref: refs/heads/main\n');
    await put('sentinel-dvpnctl/node_modules/x/index.js', '');
    await put('unrelated/notes.md', 'x');
    expect(await sourceFingerprint(dir)).toBe(before);
  });

  it('fails when a module is missing, so a wrong folder cannot pass as a source', async () => {
    await fs.rm(path.join(dir, 'sentinel-dvpnctl'), { recursive: true });
    await expect(sourceFingerprint(dir)).rejects.toThrow();
  });
});

// ─── GIT_COMMIT / GIT_TAG for a source export with no .git ───

describe('sourceVersion', () => {
  it('reads a VERSION file, so an export without .git still names its commit and tag', async () => {
    await put('VERSION', '# export of cf4c372 + ddv patches\nGIT_COMMIT=8d5b93c\nGIT_TAG=cf4c372-ddv18.32\n');
    expect(await sourceVersion(dir)).toEqual({ GIT_COMMIT: '8d5b93c', GIT_TAG: 'cf4c372-ddv18.32' });
  });

  it('says unknown when there is neither a VERSION file nor a git checkout', async () => {
    expect(await sourceVersion(dir)).toEqual({ GIT_COMMIT: 'unknown', GIT_TAG: 'unknown' });
  });

  it('the VERSION file is outside the hashed modules, so the version enters the tag through the build args', async () => {
    const before = await sourceFingerprint(dir);
    await put('VERSION', 'GIT_COMMIT=8d5b93c\n');
    expect(await sourceFingerprint(dir)).toBe(before);
    const args = { SENTINEL_NETWORK: 'devnet' };
    expect(imageTagFrom('r', 'F', { ...args, GIT_COMMIT: 'a' }, before)).not.toBe(imageTagFrom('r', 'F', { ...args, GIT_COMMIT: 'b' }, before));
  });
});

describe('parseVersionFile', () => {
  it('accepts CRLF, blank lines and comments', () => {
    expect(parseVersionFile('GIT_TAG=v1.2.3\r\n\r\n# x\r\nGIT_COMMIT=abc123\r\n')).toEqual({ GIT_TAG: 'v1.2.3', GIT_COMMIT: 'abc123' });
  });

  it('refuses an unknown key', () => {
    expect(() => parseVersionFile('GIT_SHA=abc\n')).toThrow(/unknown key GIT_SHA/);
  });

  it('refuses a value that could break the build command', () => {
    expect(() => parseVersionFile('GIT_TAG=x; rm -rf /\n')).toThrow(/characters other than/);
    expect(() => parseVersionFile('GIT_COMMIT=$(id)\n')).toThrow(/characters other than/);
  });
});

describe('imageTagFrom', () => {
  const args = { SENTINEL_NETWORK: 'devnet' };

  it('without a source matches the old tag formula, so already-deployed nodes keep their image', () => {
    const old = `r:devnet-${createHash('sha256').update('FROM x').update(JSON.stringify(args)).digest('hex').slice(0, 10)}`;
    expect(imageTagFrom('r', 'FROM x', args)).toBe(old);
  });

  it('a different source gives a different tag', () => {
    expect(imageTagFrom('r', 'FROM x', args, 'aa')).not.toBe(imageTagFrom('r', 'FROM x', args, 'bb'));
    expect(imageTagFrom('r', 'FROM x', args, 'aa')).not.toBe(imageTagFrom('r', 'FROM x', args));
  });

  it('keeps the repo:devnet-<10 hex> shape', () => {
    expect(imageTagFrom('node-manager/dvpnd', 'FROM x', args, 'aa')).toMatch(/^node-manager\/dvpnd:devnet-[0-9a-f]{10}$/);
  });
});
