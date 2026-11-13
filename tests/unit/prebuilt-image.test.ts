import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  PREBUILT_IMAGE_RELEASE_URL,
  PREBUILT_IMAGE_TAG,
  checkImageHash,
  imageArchOf,
  isSha256Hex,
  prebuiltAssetFor,
  prebuiltPinned,
  remoteLoadScript,
  sizeText,
} from '../../src/main/services/prebuilt-image';

describe('prebuilt image: CPU names', () => {
  it.each([
    ['x86_64', 'amd64'],
    ['amd64', 'amd64'],
    ['x64', 'amd64'],
    [' X86_64\n', 'amd64'],
    ['aarch64', 'arm64'],
    ['arm64', 'arm64'],
    ['armv8', 'arm64'],
  ])('%j -> %s', (m, want) => {
    expect(imageArchOf(m)).toBe(want);
  });

  it.each(['armv7l', 'i686', 'riscv64', 's390x', ''])('%j has no prebuilt image', (m) => {
    expect(imageArchOf(m)).toBeNull();
    expect(() => prebuiltAssetFor(m)).toThrow(/no prebuilt node image for this CPU.*Build from source/s);
  });
});

describe('prebuilt image: assets', () => {
  it('each CPU gets its own file from the image release', () => {
    const a = prebuiltAssetFor('x86_64');
    const b = prebuiltAssetFor('aarch64');
    expect(a.arch).toBe('amd64');
    expect(b.arch).toBe('arm64');
    expect(a.file).toBe('sentinel-dvpnd-image-0.3.7-linux-amd64.tar.gz');
    expect(b.file).toBe('sentinel-dvpnd-image-0.3.7-linux-arm64.tar.gz');
    expect(a.url).toBe(`${PREBUILT_IMAGE_RELEASE_URL}/${a.file}`);
    expect(PREBUILT_IMAGE_RELEASE_URL).toMatch(/^https:\/\/github\.com\/Sentinel-Bluebuilder\/sentinel-solana-node-manager\/releases\/download\/node-image-0.3.7$/);
    expect(PREBUILT_IMAGE_TAG).toBe('node-manager/dvpnd:prebuilt-0.3.7');
  });

  it('release builds have both hashes pinned as 64-char lowercase hex', () => {
    expect(prebuiltPinned()).toBe(true);
    expect(isSha256Hex(prebuiltAssetFor('x86_64').sha256)).toBe(true);
    expect(isSha256Hex(prebuiltAssetFor('arm64').sha256)).toBe(true);
    expect(prebuiltAssetFor('x86_64').sha256).not.toBe(prebuiltAssetFor('arm64').sha256);
    expect(prebuiltAssetFor('x86_64').bytes).toBeGreaterThan(10e6);
    expect(prebuiltAssetFor('arm64').bytes).toBeGreaterThan(10e6);
  });
});

describe('prebuilt image: checksum', () => {
  const asset = { ...prebuiltAssetFor('x86_64'), sha256: 'a'.repeat(64) };

  it('accepts the pinned hash in any case', () => {
    expect(() => checkImageHash(asset, 'a'.repeat(64))).not.toThrow();
    expect(() => checkImageHash(asset, 'A'.repeat(64))).not.toThrow();
  });

  it('refuses one changed character with a plain-words error', () => {
    expect(() => checkImageHash(asset, `${'a'.repeat(63)}b`)).toThrow(/does not match its published checksum.*deleted and not loaded/s);
  });

  it('isSha256Hex', () => {
    expect(isSha256Hex('0'.repeat(64))).toBe(true);
    expect(isSha256Hex('0'.repeat(63))).toBe(false);
    expect(isSha256Hex('G'.repeat(64))).toBe(false);
    expect(isSha256Hex('__AMD64_SHA256__')).toBe(false);
  });

  it('sizeText', () => {
    expect(sizeText(0)).toBe('size unknown');
    expect(sizeText(152_400_000)).toBe('152 MB');
  });
});

describe('prebuilt image: server script', () => {
  const plain = remoteLoadScript('docker');
  const sudo = remoteLoadScript('sudo docker');

  it('is valid shell (bash -n)', () => {
    expect(() => execFileSync('bash', ['-n'], { input: plain })).not.toThrow();
    expect(() => execFileSync('bash', ['-n'], { input: sudo })).not.toThrow();
  });

  it('pins both files and hashes, checks before loading, cleans up', () => {
    for (const m of ['x86_64', 'arm64']) {
      const a = prebuiltAssetFor(m);
      expect(plain).toContain(`f='${a.file}'; h='${a.sha256}'`);
    }
    const iHash = plain.indexOf('sha256sum');
    const iLoad = plain.indexOf('docker load');
    expect(iHash).toBeGreaterThan(0);
    expect(iLoad).toBeGreaterThan(iHash);
    expect(plain).toContain('checksum mismatch');
    expect(plain).toContain(`trap 'rm -rf "$d"' EXIT`);
    expect(plain).toContain(`image inspect '${PREBUILT_IMAGE_TAG}'`);
    expect(plain.trim().endsWith('echo PREBUILT_OK')).toBe(true);
    expect(sudo).toContain('sudo docker load -i');
  });

  it('refuses an unknown CPU', () => {
    expect(plain).toMatch(/\*\) echo "no prebuilt node image for CPU \$m/);
  });
});
