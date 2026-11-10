// ─── Prebuilt node image ───
// The default way a host gets the node image: the release's image file for the host's CPU
// (`docker save | gzip` of the image built once from the tagged daemon source) is downloaded,
// its SHA-256 is checked against the hash pinned here, and it is loaded into Docker. No source
// tree, no Go build, no buildx. Pure helpers only (no Electron, no Docker) so unit tests cover them.

/** Local tag every prebuilt image file loads as (same tag on every CPU). */
export const PREBUILT_IMAGE_TAG = 'node-manager/dvpnd:prebuilt-0.3.0';

/** Release that carries the image files. */
export const PREBUILT_IMAGE_RELEASE_URL =
  'https://github.com/Sentinel-Bluebuilder/sentinel-solana-node-manager/releases/download/node-image-0.3.0';

/** Daemon source the image was built from (shown in the deploy log). */
export const PREBUILT_IMAGE_SOURCE = 'sentinel-dvpnd final6.5 (90014b2)';

export type ImageArch = 'amd64' | 'arm64';

export interface PrebuiltAsset {
  arch: ImageArch;
  file: string;
  url: string;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
  /** Size in bytes, for the progress text. */
  bytes: number;
}

const ASSETS: Record<ImageArch, { file: string; sha256: string; bytes: number }> = {
  amd64: {
    file: 'sentinel-dvpnd-image-0.3.0-linux-amd64.tar.gz',
    sha256: 'bb90712682bf43add0c86af4ed1ee153372b4b53ca3e0da1eca2901dd7737422',
    bytes: 96_233_966,
  },
  arm64: {
    file: 'sentinel-dvpnd-image-0.3.0-linux-arm64.tar.gz',
    sha256: 'a8be220f059db17e7672b3947fab2d9b736ad84feed561f3ef193cf8641f25c9',
    bytes: 89_141_331,
  },
};

/**
 * CPU name from Docker (`Architecture` in `docker info`: x86_64 / aarch64) or `uname -m`
 * (x86_64 / aarch64 / arm64 / amd64) → image arch. Anything else has no prebuilt image.
 */
export function imageArchOf(machine: string): ImageArch | null {
  const m = machine.trim().toLowerCase();
  if (m === 'x86_64' || m === 'amd64' || m === 'x64') return 'amd64';
  if (m === 'aarch64' || m === 'arm64' || m === 'armv8' || m === 'arm64v8') return 'arm64';
  return null;
}

export function prebuiltAssetFor(machine: string): PrebuiltAsset {
  const arch = imageArchOf(machine);
  if (!arch) {
    throw new Error(
      `There is no prebuilt node image for this CPU ("${machine.trim() || 'unknown'}"). Prebuilt images exist for ` +
        'x86_64 and arm64. Use Settings → Node image → Build from source on this host instead.',
    );
  }
  const a = ASSETS[arch];
  return { arch, file: a.file, url: `${PREBUILT_IMAGE_RELEASE_URL}/${a.file}`, sha256: a.sha256, bytes: a.bytes };
}

export function isSha256Hex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** A downloaded file's hash against the pinned one; throws a plain-words error on mismatch. */
export function checkImageHash(asset: PrebuiltAsset, actual: string): void {
  if (actual.toLowerCase() !== asset.sha256) {
    throw new Error(
      `The downloaded node image (${asset.file}) does not match its published checksum ` +
        `(expected ${asset.sha256.slice(0, 12)}…, got ${actual.toLowerCase().slice(0, 12)}…). It was deleted and not ` +
        'loaded. Check the connection (a proxy may be changing downloads) and deploy again.',
    );
  }
}

export function sizeText(bytes: number): string {
  return bytes > 0 ? `${Math.round(bytes / 1e6)} MB` : 'size unknown';
}

/**
 * Shell script for an SSH host: download the image file for its CPU, check the pinned SHA-256,
 * load it, delete the file. `docker` is the command prefix the runtime uses (may be `sudo docker`).
 * Prints `PREBUILT_OK` on success; exits non-zero with the reason otherwise.
 */
export function remoteLoadScript(docker: string): string {
  const cases = (Object.keys(ASSETS) as ImageArch[])
    .map((arch) => {
      const a = ASSETS[arch];
      const pats = arch === 'amd64' ? 'x86_64|amd64' : 'aarch64|arm64';
      return `  ${pats}) f='${a.file}'; h='${a.sha256}' ;;`;
    })
    .join('\n');
  return [
    'set -eu',
    'm=$(uname -m)',
    'case "$m" in',
    cases,
    '  *) echo "no prebuilt node image for CPU $m (x86_64 and arm64 only)"; exit 3 ;;',
    'esac',
    'd=$(mktemp -d)',
    'trap \'rm -rf "$d"\' EXIT',
    `u='${PREBUILT_IMAGE_RELEASE_URL}'/"$f"`,
    'if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 --connect-timeout 20 -o "$d/img" "$u";',
    'elif command -v wget >/dev/null 2>&1; then wget -q -O "$d/img" "$u";',
    'else echo "neither curl nor wget is installed on this server"; exit 4; fi',
    'a=$(sha256sum "$d/img" | cut -d" " -f1)',
    'if [ "$a" != "$h" ]; then echo "checksum mismatch for $f: expected $h got $a"; exit 5; fi',
    `${docker} load -i "$d/img"`,
    `${docker} image inspect '${PREBUILT_IMAGE_TAG}' >/dev/null`,
    'echo PREBUILT_OK',
  ].join('\n');
}

/** True once the pinned hashes have been filled in (release build check). */
export function prebuiltPinned(): boolean {
  return (Object.values(ASSETS) as { sha256: string }[]).every((a) => isSha256Hex(a.sha256));
}
