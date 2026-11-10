import Docker from 'dockerode';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from './logger';
import { PREBUILT_IMAGE_SOURCE, PREBUILT_IMAGE_TAG, checkImageHash, prebuiltAssetFor, sizeText } from './prebuilt-image';
import { getSettings } from './settings';
import { MINT, PROGRAM_ID } from './chain';
import { BUILD_MODULES, imageTagFrom, modulesFor, sourceFingerprint, sourceKind, sourceVersion, type SourceKind } from './image-source';
import { nodeCommandFor, type CliLayout } from './cli-layout';
import {
  BUILD_IDLE_LIMIT_MS,
  IMAGE_BUILD_NETWORK,
  buildStalledError,
  buildxMissingError,
  ctlImageChoice,
  idleWatchdog,
} from './validate';

import DVPND_DOCKERFILE_RAW from '../../../docker/dvpnd.Dockerfile?raw';
import DVPND_DOCKERIGNORE_RAW from '../../../docker/dvpnd.Dockerfile.dockerignore?raw';
import CB33_DOCKERFILE_RAW from '../../../docker/dvpnd-cb33.Dockerfile?raw';
import CB33_DOCKERIGNORE_RAW from '../../../docker/dvpnd-cb33.Dockerfile.dockerignore?raw';

/**
 * Node image for the Sentinel Solana program: dvpnd (node daemon) + dvpnctl
 * (program CLI) + every protocol binary (WireGuard, AmneziaWG, V2Ray, Xray,
 * OpenVPN, Hysteria2, userspace wireguard-go / amneziawg-go fallbacks).
 *
 * Built from the patched sentinel-solana `upstream/` tree (Settings →
 * upstreamDir) with the devnet identity linked in. The build uses BuildKit
 * features (cache mounts, TARGETARCH), so it runs through the docker CLI, not
 * dockerode (whose builds are pinned to the classic builder).
 */
export const DVPND_DOCKERFILE: string = DVPND_DOCKERFILE_RAW;
export const DVPND_DOCKERIGNORE: string = DVPND_DOCKERIGNORE_RAW;

/** What to build the node image with, for the tree in Settings.upstreamDir. */
export interface BuildRecipe {
  kind: SourceKind;
  modules: string[];
  dockerfile: string;
  dockerignore: string;
}

export function recipeFor(kind: SourceKind): BuildRecipe {
  return kind === 'cb33'
    ? { kind, modules: modulesFor(kind), dockerfile: CB33_DOCKERFILE_RAW, dockerignore: CB33_DOCKERIGNORE_RAW }
    : { kind, modules: modulesFor(kind), dockerfile: DVPND_DOCKERFILE_RAW, dockerignore: DVPND_DOCKERIGNORE_RAW };
}

export async function buildRecipe(): Promise<BuildRecipe> {
  const { upstreamDir } = await getSettings();
  return recipeFor(await sourceKind(upstreamDir));
}

export const IMAGE_REPO = 'node-manager/dvpnd';
/**
 * Tag carries a hash of the Dockerfile, the build args and the source tree
 * (resolveImageTag), so any change to them makes every host — local or SSH —
 * build the new image instead of reusing an old one under the same name.
 */
/** Link-time build identity (must match chain.ts). */
export const IMAGE_BUILD_ARGS: Record<string, string> = {
  SENTINEL_NETWORK: 'devnet',
  SENTINEL_PROGRAM_ID: PROGRAM_ID,
  SENTINEL_MINT: MINT,
};
// The identity is linked into the binaries, so it is part of the tag as well: a
// program/mint change must never reuse an image built for the old one.
/**
 * Tag of images built before the source was part of the tag. Only nodes deployed
 * then (no `imageTag` on their record) still use it; new deploys use
 * `resolveImageTag()`.
 */
export const LEGACY_IMAGE_TAG = imageTagFrom(IMAGE_REPO, DVPND_DOCKERFILE_RAW, IMAGE_BUILD_ARGS);
export { BUILD_MODULES };

/**
 * Build args for the source now in Settings.upstreamDir: the devnet identity plus
 * GIT_COMMIT / GIT_TAG (a VERSION file in the source, else its git), so
 * `dvpnd version` in the image names the source it was built from.
 */
export async function imageBuildArgs(): Promise<Record<string, string>> {
  const { upstreamDir } = await getSettings();
  return { ...IMAGE_BUILD_ARGS, ...(await sourceVersion(upstreamDir)) };
}

/**
 * Tag for the source now in Settings.upstreamDir. A host that already has an
 * image for an older source no longer matches, so the deploy builds the new one
 * instead of silently running the old dvpnd.
 */
export async function resolveImageTag(): Promise<string> {
  const { upstreamDir, nodeImageSource } = await getSettings();
  // Default: the checksum-pinned prebuilt image (no source folder needed).
  if (nodeImageSource !== 'source') return PREBUILT_IMAGE_TAG;
  let fp: string;
  try {
    fp = await sourceFingerprint(upstreamDir);
  } catch (err) {
    throw new Error(
      `The node image is built from the sentinel-solana source at "${upstreamDir}", but it could not be read ` +
        `(${(err as Error).message}). Set the folder in Settings → Node image source, then deploy again.`,
    );
  }
  return imageTagFrom(IMAGE_REPO, (await buildRecipe()).dockerfile, await imageBuildArgs(), fp);
}

/**
 * Image for dvpnctl calls that belong to no node (program reads, the wallet's test
 * channels): the one the app deploys with now, which matches the deployed program.
 * The legacy tag (Dockerfile + args only) can name an image built before the
 * program's redeploy, whose instructions the program refuses (Anchor 3002 / 3007).
 * Built here once when missing: a user who only deploys to a VPS has no local image,
 * and every program read / test channel / node read would otherwise fail (Q0328).
 */
export async function chainCtlImageTag(): Promise<string> {
  return localCtlImageTag(undefined);
}

/**
 * Local image for a node's own dvpnctl calls (they always run on LOCAL Docker). A
 * remote node's image lives on its VPS; then the current source's image is used and
 * fetched here once if missing: downloaded in prebuilt mode, built in source mode (see ctlImageChoice). Concurrent callers share one build.
 */
const ctlBuilds = new Map<string, Promise<void>>();
export async function localCtlImageTag(nodeTag: string | undefined): Promise<string> {
  const choice = ctlImageChoice({
    nodeTag,
    nodeTagLocal: nodeTag ? await hasImage(nodeTag) : false,
    currentTag: await resolveImageTag(),
  });
  if (choice.build && !(await hasImage(choice.tag))) {
    let p = ctlBuilds.get(choice.tag);
    if (!p) {
      log.info('getting the chain-call image on this machine (download or build, per Settings → Node image)', { nodeTag, tag: choice.tag });
      p = ensureImage(choice.tag, (line) => log.debug('ctl image', { line })).finally(() => ctlBuilds.delete(choice.tag));
      ctlBuilds.set(choice.tag, p);
    }
    await p;
  }
  return choice.tag;
}

/** Mount point of the node home inside every container. */
export const NODE_HOME = '/root/.dvpnd';
/** dvpnctl home (owner key + cli config) inside the node home. */
export const CTL_HOME = `${NODE_HOME}/ctl`;
export const DAEMON_SOCKET = `${NODE_HOME}/daemon.sock`;

/**
 * Docker daemon control.
 *
 * On macOS / Windows the app communicates with Docker Desktop via its
 * Unix socket (macOS) or named pipe (Windows). On Linux it's the system
 * socket at /var/run/docker.sock. The Settings `dockerSocket` lets the
 * user override (useful for Podman, colima, or rootless setups).
 *
 * The host mount for a local node is userData/nodes/<nodeId> → NODE_HOME.
 */

let client: Docker | null = null;

function candidateSockets(override: string): string[] {
  if (override) return [override];
  if (process.platform === 'win32') {
    // Docker Desktop on Windows exposes different named pipes depending on
    // which context is active. `desktop-linux` (the default since 4.x) uses
    // `dockerDesktopLinuxEngine`; the legacy `default` context uses
    // `docker_engine`; Windows-containers mode uses `dockerDesktopWindowsEngine`.
    // Probe all three so a freshly-installed Docker Desktop works out of the box.
    return [
      '//./pipe/dockerDesktopLinuxEngine',
      '//./pipe/docker_engine',
      '//./pipe/dockerDesktopWindowsEngine',
      '//./pipe/podman-machine-default',
    ];
  }
  return [
    '/var/run/docker.sock',
    `${os.homedir()}/.docker/run/docker.sock`,      // Docker Desktop on macOS (new)
    `${os.homedir()}/.docker/desktop/docker.sock`,  // Docker Desktop on macOS (older)
    `${os.homedir()}/.colima/default/docker.sock`,  // Colima
    `${os.homedir()}/.colima/docker.sock`,
    `${os.homedir()}/.rd/docker.sock`,              // Rancher Desktop
    `/run/user/${process.getuid?.() ?? 1000}/docker.sock`, // rootless Linux
    `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`, // rootless Podman
  ];
}

export async function getClient(): Promise<Docker> {
  if (client) return client;
  const settings = await getSettings();
  const candidates = candidateSockets(settings.dockerSocket);
  for (const sock of candidates) {
    try {
      const c = new Docker({ socketPath: sock });
      // ping forces a real handshake with the daemon
      await c.ping();
      client = c;
      log.info('docker connected', { socket: sock });
      return c;
    } catch (err) {
      log.debug('docker socket probe failed', { sock, err: (err as Error).message });
    }
  }
  // Build a user-actionable error that reflects what's actually missing:
  // Docker Desktop not installed, installed-but-not-running, or a Linux
  // daemon that isn't up. Renderer keys off `reason` to pick the right UI.
  const desktop = await detectDockerDesktop();
  const err = new Error(
    desktop.installed
      ? 'Docker Desktop is installed but not running. Start Docker Desktop and try again.'
      : process.platform === 'linux'
        ? 'Could not reach the Docker daemon. Start the Docker Engine (`sudo systemctl start docker`) and try again.'
        : 'Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ and try again.',
  ) as Error & { reason?: DockerUnreachableReason; desktop?: DockerDesktopStatus };
  err.reason = desktop.installed
    ? 'desktop-not-running'
    : process.platform === 'linux'
      ? 'engine-not-running'
      : 'desktop-not-installed';
  err.desktop = desktop;
  throw err;
}

/** Structured reason so the renderer can render the right recovery UI. */
export type DockerUnreachableReason =
  | 'desktop-not-installed'
  | 'desktop-not-running'
  | 'engine-not-running';

export interface DockerDesktopStatus {
  /** Docker Desktop is installed on disk (Windows/macOS). Always false on Linux. */
  installed: boolean;
  /** Absolute path to the launcher, if installed. */
  launchPath?: string;
  /** True if we can start it from the app (Windows/macOS only). */
  startable: boolean;
}

export interface DockerHealth {
  reachable: boolean;
  version?: string;
  error?: string;
  socket?: string;
  /** Why the daemon isn't reachable, if !reachable. */
  reason?: DockerUnreachableReason;
  /** Install/launch state for Docker Desktop (Windows/macOS). */
  desktop?: DockerDesktopStatus;
}

export async function dockerHealth(): Promise<DockerHealth> {
  try {
    const c = await getClient();
    const info = await withDockerTimeout(() => c.version(), 5_000, 'version');
    return { reachable: true, version: info.Version };
  } catch (err) {
    const e = err as Error & { reason?: DockerUnreachableReason; desktop?: DockerDesktopStatus };
    // If getClient() already attached reason+desktop, reuse them.
    // Otherwise (unexpected error), probe once so the UI still gets useful info.
    const desktop = e.desktop ?? (await detectDockerDesktop());
    const reason =
      e.reason ??
      (desktop.installed
        ? 'desktop-not-running'
        : process.platform === 'linux'
          ? 'engine-not-running'
          : 'desktop-not-installed');
    return { reachable: false, error: e.message, reason, desktop };
  }
}

/**
 * Where Docker Desktop's launcher lives on each host OS.
 *
 * On Windows it's normally installed system-wide, but users with
 * non-admin installs may have it under %LOCALAPPDATA%. On macOS it ships
 * as a single .app under /Applications. Linux has no "Docker Desktop" as
 * a separate launchable — the daemon is a systemd unit.
 */
function dockerDesktopCandidatePaths(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const localAppData =
      process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'),
      path.join(localAppData, 'Docker', 'Docker Desktop.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Docker.app/Contents/MacOS/Docker Desktop'];
  }
  return [];
}

/** Detect whether Docker Desktop is installed on disk (Windows/macOS). */
export async function detectDockerDesktop(): Promise<DockerDesktopStatus> {
  if (process.platform === 'linux') {
    return { installed: false, startable: false };
  }
  for (const candidate of dockerDesktopCandidatePaths()) {
    try {
      await fs.access(candidate);
      return { installed: true, launchPath: candidate, startable: true };
    } catch (err) {
      log.debug('docker desktop not at candidate path', { candidate, err: (err as Error).message });
    }
  }
  return { installed: false, startable: false };
}

/**
 * Try to start Docker Desktop. Returns `{ started: true }` if the
 * launcher was spawned; the caller still has to poll `dockerHealth()`
 * because Docker Desktop takes 10–30 s to bring its VM up. Never throws
 * on Linux or when Docker Desktop isn't installed — returns `started:false`.
 */
export async function startDockerDesktop(): Promise<{
  started: boolean;
  launchPath?: string;
  error?: string;
}> {
  const status = await detectDockerDesktop();
  if (!status.installed || !status.launchPath) {
    return {
      started: false,
      error:
        process.platform === 'linux'
          ? 'Docker Engine is a system service on Linux. Start it with `sudo systemctl start docker`.'
          : 'Docker Desktop is not installed',
    };
  }
  try {
    // `detached: true` + immediate `unref()` lets Docker Desktop survive
    // our app quitting, and avoids Electron waiting on the child handle.
    // `shell: false` + exact path is safe (no user input interpolated).
    const child = spawn(status.launchPath, [], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();
    log.info('docker desktop launch requested', { launchPath: status.launchPath });
    return { started: true, launchPath: status.launchPath };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn('docker desktop launch failed', { err: msg });
    return { started: false, launchPath: status.launchPath, error: msg };
  }
}

/**
 * Reset the cached Docker client so the next call re-probes sockets.
 * Call this after `startDockerDesktop()` so once the daemon comes up,
 * `dockerHealth()` picks up the new socket on the next poll.
 */
export function resetDockerClient(): void {
  client = null;
}

// ---------------------------------------------------------------------------
// Image lifecycle
// ---------------------------------------------------------------------------

/** `docker buildx version` on this computer: ok when it exits 0 within 20 s. */
export function localBuildxVersion(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker', ['buildx', 'version'], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, output: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output: 'docker buildx version timed out after 20 s' });
    }, 20_000);
    child.stdout?.on('data', (b: Buffer) => { output += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { output += b.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

export async function hasImage(tag: string): Promise<boolean> {
  const c = await getClient();
  try {
    const img = c.getImage(tag);
    await img.inspect();
    return true;
  } catch (err) {
    if (!/no such image|404/i.test((err as Error).message)) log.debug('image inspect failed', { tag, err: (err as Error).message });
    return false;
  }
}

/**
 * Build the node image if it is not in the local store. Streams build output
 * via `onLog`. Context = the patched `upstream/` tree (Settings.upstreamDir);
 * the Dockerfile + its `.dockerignore` are written to a temp dir and passed
 * with `-f`, so nothing is written into the upstream tree.
 */
export async function ensureImage(
  tag: string,
  onLog: (line: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (await hasImage(tag)) return;
  if (signal?.aborted) throw new Error('Image build aborted before start');
  if (tag === PREBUILT_IMAGE_TAG) return loadPrebuiltImage(onLog, signal);
  const { upstreamDir } = await getSettings();
  try {
    await fs.access(path.join(upstreamDir, 'sentinel-dvpnd', 'go.mod'));
  } catch (err) {
    throw new Error(
      `The node image is built from the patched sentinel-solana source at "${upstreamDir}", but it was not found there ` +
        `(${(err as Error).message}). Set the folder in Settings → Node image source, then deploy again.`,
    );
  }

  // BuildKit builds go through the buildx plugin; stock docker.io ships without it (Q0394).
  const bx = await localBuildxVersion();
  if (!bx.ok) throw buildxMissingError('this computer', bx.output);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dvpnd-build-'));
  const dockerfilePath = path.join(tmpDir, 'dvpnd.Dockerfile');
  const recipe = await buildRecipe();
  await fs.writeFile(dockerfilePath, recipe.dockerfile, 'utf8');
  await fs.writeFile(`${dockerfilePath}.dockerignore`, recipe.dockerignore, 'utf8');
  onLog(`[docker] building ${tag} from ${upstreamDir} (${recipe.kind} tree)`);

  const args = ['build', ...IMAGE_BUILD_NETWORK, '-f', dockerfilePath, '-t', tag, '--progress=plain'];
  for (const [k, v] of Object.entries(await imageBuildArgs())) args.push('--build-arg', `${k}=${v}`);
  args.push(upstreamDir);

  const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', args, { windowsHide: true, env: { ...process.env, DOCKER_BUILDKIT: '1' } });
      let tail = '';
      let lastLine = '';
      // A stalled download (e.g. MTU, Q0405) fails after BUILD_IDLE_LIMIT_MS of silence, not at 45 min.
      const idle = idleWatchdog(BUILD_IDLE_LIMIT_MS, () => {
        child.kill();
        reject(buildStalledError('this computer', BUILD_IDLE_LIMIT_MS, lastLine));
      });
      const onChunk = (b: Buffer) => {
        idle.poke();
        const text = b.toString('utf8');
        tail = (tail + text).slice(-4000);
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          lastLine = line;
          onLog(`[docker] ${line.trim()}`);
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      const timer = setTimeout(() => {
        idle.stop();
        child.kill();
        reject(new Error(`Image build of ${tag} timed out after ${BUILD_TIMEOUT_MS / 60_000} minutes.`));
      }, BUILD_TIMEOUT_MS);
      const onAbort = () => {
        child.kill();
        reject(new Error('Image build aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => {
        clearTimeout(timer);
        idle.stop();
        reject(new Error(`Could not run the docker CLI: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        idle.stop();
        signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`docker build exited with code ${code}. Last output:\n${tail.slice(-1500)}`));
      });
    });
    if (!(await hasImage(tag))) {
      throw new Error(`Build of ${tag} reported success but the image is not in the local store.`);
    }
    onLog(`[docker] image ${tag} built`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      log.warn('docker build temp cleanup failed', { tmpDir, err: String(err) });
    });
  }
}

// ─── Prebuilt image: download, verify, load ───

const PREBUILT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Download this computer's prebuilt image file, check its pinned SHA-256 while it streams to
 * a temp file, then load it into Docker. A wrong hash deletes the file and fails the deploy.
 */
export async function loadPrebuiltImage(onLog: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const c = await getClient();
  const info = (await c.info()) as { Architecture?: string };
  const asset = prebuiltAssetFor(info.Architecture ?? os.arch());
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dvpnd-image-'));
  const file = path.join(tmpDir, asset.file);
  onLog(`[image] downloading the node image for ${asset.arch} (${sizeText(asset.bytes)}, one time): ${asset.url}`);
  try {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), PREBUILT_DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(asset.url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${asset.url}`);
      const hash = createHash('sha256');
      const out = createWriteStream(file);
      let got = 0;
      let lastPct = -10;
      const total = Number(res.headers.get('content-length')) || asset.bytes;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (total && pct >= lastPct + 10) {
          lastPct = pct;
          onLog(`[image] ${pct}% (${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB)`);
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      checkImageHash(asset, hash.digest('hex'));
      onLog(`[image] checksum OK (${asset.sha256.slice(0, 12)}…)`);
    } catch (err) {
      if (signal?.aborted) throw new Error('Image download aborted');
      if (ac.signal.aborted) throw new Error(`Image download timed out after ${PREBUILT_DOWNLOAD_TIMEOUT_MS / 60_000} minutes.`);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    onLog('[image] loading into Docker');
    const stream = await c.loadImage(createReadStream(file));
    await new Promise<void>((resolve, reject) => {
      c.modem.followProgress(
        stream,
        (err: Error | null, events: { error?: string; stream?: string }[]) => {
          const failed = err?.message ?? events?.find((e) => e.error)?.error;
          if (failed) reject(new Error(`docker load failed: ${failed}`));
          else resolve();
        },
        (e: { stream?: string }) => {
          if (e.stream?.trim()) onLog(`[image] ${e.stream.trim()}`);
        },
      );
    });
    if (!(await hasImage(PREBUILT_IMAGE_TAG))) {
      throw new Error(`The image file loaded but ${PREBUILT_IMAGE_TAG} is not in Docker. Deploy again; if it repeats, report it.`);
    }
    onLog(`[image] ${PREBUILT_IMAGE_TAG} ready (${PREBUILT_IMAGE_SOURCE})`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      log.warn('prebuilt image temp cleanup failed', { tmpDir, err: String(err) });
    });
  }
}

// ---------------------------------------------------------------------------
// Container lifecycle for dvpnd nodes
// ---------------------------------------------------------------------------

/**
 * Race a promise against a hard timeout. On Windows + Docker Desktop the
 * named-pipe transport occasionally wedges mid-call (a half-open response
 * after a Desktop background restart, OS update, or WSL2 hiccup). Without
 * an outer ceiling, dockerode just sits on the hung pipe forever and the
 * deploy stalls at "Starting node container" or "Preparing node image".
 * Every long-running primitive (start/stop/remove/create) goes through
 * here so the deploy fails with a specific, actionable message instead.
 */
export async function withDockerTimeout<T>(
  op: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Docker operation '${label}' timed out after ${Math.round(ms / 1000)}s. ` +
            `The daemon may be wedged — restart Docker Desktop and try again.`,
        ),
      );
    }, ms);
    op().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface RunNodeOptions {
  nodeId: string;
  /** Host dir mounted at NODE_HOME. */
  hostDataDir: string;
  /** Every port to publish, each as both tcp and udp (api + service listeners). */
  ports: number[];
  imageTag: string;
  /** Arguments passed to the image entrypoint (nodeCommand(layout)). */
  cmd: string[];
}

/** Container name prefix — distinct from the Cosmos app's `sentinel-dvpn-`. */
export const CONTAINER_PREFIX = 'sentinel-sol-';

export function containerName(nodeId: string): string {
  return `${CONTAINER_PREFIX}${nodeId.slice(0, 12)}`;
}

/**
 * Kernel + capability settings every node container needs: tunnel devices,
 * NAT for client traffic (ip_forward), wg-quick's src_valid_mark.
 */
export const NODE_SYSCTLS: Record<string, string> = {
  'net.ipv4.ip_forward': '1',
  'net.ipv4.conf.all.src_valid_mark': '1',
  'net.ipv6.conf.all.disable_ipv6': '0',
};

/**
 * docker CLI form (remote runtime). The Engine API equivalent of systempaths is
 * MaskedPaths/ReadonlyPaths = []; apparmor=unconfined is accepted by both.
 * AppArmor (Ubuntu's docker-default profile) denies writes under /proc/sys even
 * when the paths are unmasked — found on a live Ubuntu 24.04 host.
 */
export const NODE_SECURITY_OPT = ['systempaths=unconfined', 'apparmor=unconfined'];
export const NODE_API_SECURITY_OPT = ['apparmor=unconfined'];

/**
 * Userspace WireGuard / AmneziaWG (wireguard-go, amneziawg-go) exit on Linux unless
 * told the kernel module is unavailable on purpose. Docker Desktop has the wireguard
 * module but NOT amneziawg, so AmneziaWG always runs userspace there.
 */
export const NODE_ENV = ['WG_I_PREFER_BUGGY_USERSPACE_TO_POLISHED_KMOD=1', 'AWG_FORCE_USERSPACE=1'];

export function nodeCommand(layout: CliLayout): string[] {
  return nodeCommandFor(layout, NODE_HOME);
}

export async function runNode(opts: RunNodeOptions): Promise<string> {
  const c = await getClient();
  const name = containerName(opts.nodeId);

  // Remove any previous container with the same name (stale from a prior
  // run). A missing container is the normal case.
  try {
    const existing = c.getContainer(name);
    await withDockerTimeout(() => existing.remove({ force: true }), 30_000, 'remove previous container');
  } catch (err) {
    if (!/no such container|404/i.test((err as Error).message)) {
      log.warn('removing previous container failed', { name, err: (err as Error).message });
    }
  }

  await fs.mkdir(opts.hostDataDir, { recursive: true });

  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  const exposed: Record<string, Record<string, never>> = {};
  for (const p of opts.ports) {
    for (const proto of ['tcp', 'udp']) {
      portBindings[`${p}/${proto}`] = [{ HostPort: String(p) }];
      exposed[`${p}/${proto}`] = {};
    }
  }

  const container = await withDockerTimeout(
    () =>
      c.createContainer({
        name,
        Image: opts.imageTag,
        Cmd: opts.cmd,
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        Labels: { 'sentinel-sol.node-id': opts.nodeId },
        Env: NODE_ENV,
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          Binds: [`${opts.hostDataDir}:${NODE_HOME}`],
          CapAdd: ['NET_ADMIN', 'NET_RAW'],
          // dvpnd's SetupEgress writes /proc/sys/net/ipv4/ip_forward itself; /proc/sys is
          // read-only in a default container. Unmasking system paths makes it writable;
          // net.* sysctls are per network namespace, so this stays inside the container.
          // Engine-API form of the CLI's --security-opt systempaths=unconfined.
          MaskedPaths: [],
          ReadonlyPaths: [],
          SecurityOpt: NODE_API_SECURITY_OPT,
          Sysctls: NODE_SYSCTLS,
          Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
          PortBindings: portBindings,
        },
        ExposedPorts: exposed,
      }),
    30_000,
    'createContainer',
  );
  await withDockerTimeout(() => container.start(), 60_000, 'container.start');
  return container.id;
}

/** Extra container settings for one-shot runs (the test-session client). */
export interface RunOnceExtra {
  capAdd?: string[];
  tun?: boolean;
  sysctls?: Record<string, string>;
  extraHosts?: string[];
  env?: string[];
  /** Make /proc/sys writable (daemon writes ip_forward / src_valid_mark itself). */
  unmaskSysPaths?: boolean;
  /** Extra bind mounts `host:container[:ro]`. */
  binds?: string[];
}

/**
 * Run a short-lived container (dvpnd init, dvpnctl tx, test client) and
 * return captured stdout+stderr once it exits. The node home is mounted at
 * NODE_HOME so generated state persists for the long-running node.
 */
export async function runOnce(opts: {
  hostDataDir: string;
  imageTag: string;
  cmd: string[];
  /** Override the image ENTRYPOINT (`dvpnd`), e.g. ['dvpnctl'] or ['/bin/sh', '-c']. */
  entrypoint?: string[];
  onLog?: (line: string) => void;
  /** Hard timeout (ms); the container is killed and exit code 124 returned. Default 180 s. */
  timeoutMs?: number;
  /** Abort → container killed, exit code -1. */
  signal?: AbortSignal;
  extra?: RunOnceExtra;
}): Promise<{ exitCode: number; output: string }> {
  const c = await getClient();
  await fs.mkdir(opts.hostDataDir, { recursive: true });
  const extra = opts.extra ?? {};

  // 120 s, not 30 s: on a busy Linux host (a Linux test host, 2026-11-08) a create stalled past 30 s twice
  // while dockerd was otherwise healthy, failing the channel sweep. Slow creates are logged.
  const createStarted = Date.now();
  const container = await withDockerTimeout(
    () =>
      c.createContainer({
        Image: opts.imageTag,
        Cmd: opts.cmd,
        ...(opts.entrypoint ? { Entrypoint: opts.entrypoint } : {}),
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        Env: extra.env,
        HostConfig: {
          Binds: [`${opts.hostDataDir}:${NODE_HOME}`, ...(extra.binds ?? [])],
          AutoRemove: false, // kept so we can `wait` for the exit code
          CapAdd: extra.capAdd,
          ...(extra.unmaskSysPaths ? { MaskedPaths: [], ReadonlyPaths: [], SecurityOpt: NODE_API_SECURITY_OPT } : {}),
          Sysctls: extra.sysctls,
          ExtraHosts: extra.extraHosts,
          Devices: extra.tun
            ? [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }]
            : undefined,
        },
      }),
    120_000,
    'runOnce createContainer',
  );
  const createMs = Date.now() - createStarted;
  if (createMs > 10_000) log.warn('runOnce createContainer was slow', { ms: createMs, image: opts.imageTag });

  const chunks: Buffer[] = [];
  try {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      opts.onLog?.(stripDockerFrames(chunk));
    });
    await withDockerTimeout(() => container.start(), 60_000, 'runOnce start');
  } catch (err) {
    // Created but never ran: remove it, or every failed attempt leaves an orphan.
    await container.remove({ force: true }).catch((rmErr: unknown) => log.debug('runOnce cleanup after start failure', { err: (rmErr as Error).message }));
    throw err;
  }

  const timeoutMs = opts.timeoutMs ?? 180_000;
  let timedOut = false;
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const killContainer = async () => {
    try {
      await container.kill();
    } catch (err) {
      log.debug('runOnce kill (already exited?)', { err: (err as Error).message });
    }
  };
  const timeoutPromise = new Promise<{ StatusCode: number }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      void killContainer();
      resolve({ StatusCode: 124 });
    }, timeoutMs);
  });
  const abortPromise = new Promise<{ StatusCode: number }>((resolve) => {
    if (!opts.signal) return;
    const onAbort = () => {
      aborted = true;
      void killContainer();
      resolve({ StatusCode: -1 });
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  });

  let exit: { StatusCode?: number };
  try {
    exit = (await Promise.race([container.wait(), timeoutPromise, abortPromise])) as { StatusCode?: number };
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    await container.remove({ force: true });
  } catch (err) {
    log.debug('runOnce remove (already gone?)', { err: (err as Error).message });
  }

  const code = Number(exit?.StatusCode ?? 0);
  let output = stripDockerFrames(Buffer.concat(chunks));
  if (timedOut) output += `\n[runOnce] timed out after ${Math.round(timeoutMs / 1000)}s — container killed`;
  else if (aborted) output += '\n[runOnce] aborted — container killed';
  return { exitCode: code, output };
}

/** Fetch the last N lines of a container's combined stdout/stderr. */
export async function containerLogs(containerId: string, tail = 200): Promise<string[]> {
  const c = await getClient();
  try {
    const container = c.getContainer(containerId);
    // follow:false resolves to a Buffer-ish payload; cast via unknown.
    const raw: unknown = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      follow: false,
      timestamps: false,
    } as never);
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    return stripDockerFrames(buf).split(/\r?\n/).filter(Boolean);
  } catch (err) {
    log.debug('containerLogs failed', { id: containerId.slice(0, 12), err: (err as Error).message });
    return [];
  }
}

export async function setRestartPolicy(
  containerId: string,
  policy: 'no' | 'unless-stopped',
): Promise<void> {
  const c = await getClient();
  try {
    const container = c.getContainer(containerId);
    await (container as unknown as {
      update: (opts: { RestartPolicy: { Name: string } }) => Promise<unknown>;
    }).update({ RestartPolicy: { Name: policy } });
  } catch (err) {
    log.debug('setRestartPolicy failed', { policy, err: (err as Error).message });
  }
}

const GONE_OR_STOPPED = /no such container|404|304|already stopped|is not running/i;

/** Stops the container. Resolves when it is stopped or does not exist; throws on a real failure. */
export async function stopContainer(containerId: string): Promise<void> {
  const c = await getClient();
  try {
    await setRestartPolicy(containerId, 'no');
    const container = c.getContainer(containerId);
    await container.stop({ t: 5 });
  } catch (err) {
    if (GONE_OR_STOPPED.test((err as Error).message)) {
      log.debug('stopContainer: already stopped or gone', { err: (err as Error).message });
      return;
    }
    throw err;
  }
}

export async function restartContainer(containerId: string): Promise<void> {
  const c = await getClient();
  const container = c.getContainer(containerId);
  await container.restart({ t: 5 });
}

/** Removes the container. Resolves when it is gone; throws on a real failure. */
export async function removeContainer(containerId: string): Promise<void> {
  const c = await getClient();
  try {
    const container = c.getContainer(containerId);
    try {
      await container.stop({ t: 5 });
    } catch (err) {
      log.debug('stop before remove (not running?)', { err: (err as Error).message });
    }
    await container.remove({ force: true });
  } catch (err) {
    if (/no such container|404/i.test((err as Error).message)) {
      log.debug('removeContainer: already gone', { err: (err as Error).message });
      return;
    }
    throw err;
  }
}

export async function isRunning(containerId: string): Promise<boolean> {
  const c = await getClient();
  try {
    const info = await c.getContainer(containerId).inspect();
    return Boolean(info.State.Running);
  } catch (err) {
    if (!/no such container|404/i.test((err as Error).message)) log.debug('isRunning inspect failed', { err: (err as Error).message });
    return false;
  }
}

/** Docker refuses exec into a container that is restarting (HTTP 409 "... is restarting"). */
export function isRestartingError(err: unknown): boolean {
  return /is restarting/i.test((err as Error | undefined)?.message ?? '');
}

/**
 * exec into a container, waiting up to ~45 s while Docker restarts it: the node daemon exits
 * when its RPC refuses it (e.g. a gateway's websocket cap) and its restart policy brings it
 * back, so a command sent in that window should wait rather than fail (FINAL check 2026-11-08).
 */
async function createExecWhenRunning(container: Docker.Container, cmd: string[]): Promise<Docker.Exec> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    } catch (err) {
      if (!isRestartingError(err) || attempt >= 15) throw err;
      log.info('container is restarting; waiting before exec', { attempt, cmd: cmd.slice(0, 3).join(' ') });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Run a command inside an already-running container and capture output. */
export async function execInside(
  containerId: string,
  cmd: string[],
): Promise<{ exitCode: number; output: string }> {
  const c = await getClient();
  const exec = await createExecWhenRunning(c.getContainer(containerId), cmd);
  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode ?? -1,
    output: stripDockerFrames(Buffer.concat(chunks)),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Docker manager helpers (Manage Docker page)
// ---------------------------------------------------------------------------

const SENTINEL_CONTAINER_PREFIX = CONTAINER_PREFIX;
const SENTINEL_IMAGE_REPO = IMAGE_REPO;

export interface DockerOverview {
  reachable: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  kernel?: string;
  serverTime?: string;
  totalMemoryMb?: number;
  ncpu?: number;
  rootDir?: string;
  containers: { total: number; running: number; paused: number; stopped: number };
  images: { count: number; sizeBytes: number };
  sentinelContainers: SentinelContainerSummary[];
  sentinelImages: SentinelImageSummary[];
  desktop?: DockerDesktopStatus;
  error?: string;
  reason?: DockerUnreachableReason;
}

export interface SentinelContainerSummary {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
  createdUnix: number;
}

export interface SentinelImageSummary {
  id: string;
  tag: string;
  sizeBytes: number;
  createdUnix: number;
}

export async function dockerOverview(): Promise<DockerOverview> {
  const empty: DockerOverview = {
    reachable: false,
    containers: { total: 0, running: 0, paused: 0, stopped: 0 },
    images: { count: 0, sizeBytes: 0 },
    sentinelContainers: [],
    sentinelImages: [],
  };
  try {
    const c = await getClient();
    const [version, info, containers, images] = await Promise.all([
      c.version(),
      c.info(),
      c.listContainers({ all: true }),
      c.listImages({ all: false }),
    ]);

    const sentinelContainers: SentinelContainerSummary[] = containers
      .filter((co) =>
        (co.Names ?? []).some((n) => n.replace(/^\//, '').startsWith(SENTINEL_CONTAINER_PREFIX)),
      )
      .map((co) => ({
        id: co.Id,
        name: (co.Names?.[0] ?? '').replace(/^\//, ''),
        state: co.State,
        status: co.Status,
        image: co.Image,
        createdUnix: co.Created,
      }));

    const sentinelImages: SentinelImageSummary[] = images
      .filter((img) =>
        (img.RepoTags ?? []).some((t) => t.startsWith(SENTINEL_IMAGE_REPO)),
      )
      .map((img) => ({
        id: img.Id,
        tag: (img.RepoTags ?? []).find((t) => t.startsWith(SENTINEL_IMAGE_REPO)) ?? img.Id,
        sizeBytes: img.Size,
        createdUnix: img.Created,
      }));

    const totalImagesSize = images.reduce((sum, i) => sum + (i.Size ?? 0), 0);

    return {
      reachable: true,
      version: version.Version,
      apiVersion: version.ApiVersion,
      os: info.OperatingSystem,
      arch: info.Architecture,
      kernel: info.KernelVersion,
      serverTime: new Date().toISOString(),
      totalMemoryMb: info.MemTotal ? Math.round(info.MemTotal / (1024 * 1024)) : undefined,
      ncpu: info.NCPU,
      rootDir: info.DockerRootDir,
      containers: {
        total: containers.length,
        running: info.ContainersRunning ?? 0,
        paused: info.ContainersPaused ?? 0,
        stopped: info.ContainersStopped ?? 0,
      },
      images: { count: images.length, sizeBytes: totalImagesSize },
      sentinelContainers,
      sentinelImages,
      desktop: await detectDockerDesktop().catch(() => undefined),
    };
  } catch (err) {
    const e = err as Error & { reason?: DockerUnreachableReason; desktop?: DockerDesktopStatus };
    return {
      ...empty,
      error: e.message,
      reason: e.reason,
      desktop: e.desktop ?? (await detectDockerDesktop().catch(() => undefined)),
    };
  }
}

export async function stopAllSentinelContainers(): Promise<{ stopped: number; failed: number }> {
  let stopped = 0;
  let failed = 0;
  try {
    const c = await getClient();
    const containers = await c.listContainers({ all: false });
    const targets = containers.filter((co) =>
      (co.Names ?? []).some((n) => n.replace(/^\//, '').startsWith(SENTINEL_CONTAINER_PREFIX)),
    );
    for (const co of targets) {
      try {
        await c.getContainer(co.Id).stop({ t: 5 });
        stopped += 1;
      } catch (err) {
        log.warn('stopAllSentinelContainers: stop failed', {
          id: co.Id.slice(0, 12),
          err: (err as Error).message,
        });
        failed += 1;
      }
    }
  } catch (err) {
    log.warn('stopAllSentinelContainers: not reachable', { err: (err as Error).message });
    throw err;
  }
  return { stopped, failed };
}

/** Prune dangling images. Does NOT touch tagged sentinel-dvpnx images. */
export async function pruneDangling(): Promise<{ removed: number; reclaimedBytes: number }> {
  const c = await getClient();
  const res = (await c.pruneImages({ filters: { dangling: { true: true } } })) as {
    ImagesDeleted?: unknown[] | null;
    SpaceReclaimed?: number;
  };
  return {
    removed: Array.isArray(res.ImagesDeleted) ? res.ImagesDeleted.length : 0,
    reclaimedBytes: res.SpaceReclaimed ?? 0,
  };
}

/**
 * Quit Docker Desktop on Windows / macOS.
 *
 * macOS: AppleScript `quit app "Docker"` — Docker Desktop handles its own
 * graceful teardown of the linuxkit VM and the docker.sock.
 *
 * Windows: graceful close of the UI window via taskkill (NO `/F` flag) so
 * Docker Desktop's own shutdown handler runs. That handler:
 *   1. Tells `com.docker.backend` to flush state to the WSL2 vhdx.
 *   2. Stops the `com.docker.service` Windows service via the SCM.
 *   3. Issues `wsl --shutdown` on the docker-desktop / docker-desktop-data
 *      distros so the next start-up gets a clean VM.
 * Force-killing those processes (which an earlier version of this code
 * did) skips all three steps and routinely leaves the engine wedged on
 * "Starting the Docker Engine…" until the user runs `wsl --shutdown`
 * manually or reboots.
 *
 * Linux: returns `{ quit: false }` because Docker Engine is a system
 * service and we don't have permission to manage it from a desktop app.
 */
export async function quitDockerDesktop(): Promise<{
  quit: boolean;
  error?: string;
}> {
  if (process.platform === 'linux') {
    return { quit: false, error: 'Docker Engine is a system service on Linux. Use systemctl from a terminal.' };
  }
  try {
    if (process.platform === 'darwin') {
      const child = spawn('osascript', ['-e', 'quit app "Docker"'], {
        detached: false,
        stdio: 'ignore',
        shell: false,
      });
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    } else {
      // Graceful close — no `/F`. taskkill without /F sends WM_CLOSE to the
      // top-level window, which Docker Desktop catches and turns into the
      // same shutdown path as clicking "Quit Docker Desktop" in the tray.
      // That path stops `com.docker.backend` and `com.docker.service`
      // through the SCM in the right order, and runs `wsl --shutdown`
      // on the docker-desktop distros. Skipping it (with /F) corrupts
      // the WSL2 state and leaves the engine wedged on next start.
      await new Promise<void>((resolve) => {
        const child = spawn('taskkill', ['/IM', 'Docker Desktop.exe'], {
          detached: false,
          stdio: 'ignore',
          shell: false,
        });
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
      });
    }
    resetDockerClient();
    log.info('docker desktop quit requested');
    return { quit: true };
  } catch (err) {
    return { quit: false, error: (err as Error).message };
  }
}

/**
 * Last-resort recovery for a wedged Docker Desktop (Windows only).
 *
 * Use when the graceful `quitDockerDesktop()` did nothing — typical
 * symptom is the UI stuck on "Starting the Docker Engine…" with no
 * progress, often triggered by a prior force-kill that left WSL2 in
 * a dirty state.
 *
 * Sequence:
 *   1. Force-kill Docker UI + backend processes (best-effort, /F).
 *   2. `wsl --shutdown` — terminates the docker-desktop and
 *      docker-desktop-data distros so the next start gets a clean VM.
 *      This is the step the graceful path was supposed to run via
 *      Docker Desktop's shutdown handler; if that handler hung, we
 *      run it ourselves.
 *   3. Stop the `com.docker.service` Windows service via SCM
 *      (`sc stop`). If still running, escalate to taskkill /F.
 *   4. Reset the cached dockerode client.
 *
 * Returns a stepwise log so the UI can show the user exactly what
 * recovered and what didn't.
 */
export async function forceQuitDockerDesktop(): Promise<{
  quit: boolean;
  steps: { name: string; ok: boolean; detail?: string }[];
  error?: string;
}> {
  const steps: { name: string; ok: boolean; detail?: string }[] = [];

  if (process.platform === 'linux') {
    return {
      quit: false,
      steps,
      error: 'Force-quit is Windows/macOS only. On Linux use `sudo systemctl restart docker`.',
    };
  }

  const runProcess = (
    cmd: string,
    args: string[],
    timeoutMs = 10_000,
  ): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      let stderr = '';
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (err) {
          log.debug('kill after timeout failed', { cmd, err: (err as Error).message });
        }
        resolve({ code: null, stderr: 'timeout' });
      }, timeoutMs);
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        resolve({ code: null, stderr: err.message });
      });
    });

  if (process.platform === 'darwin') {
    // macOS: SIGKILL the whole Docker.app tree. AppleScript graceful
    // quit was already tried by the caller; if we're here, it didn't
    // work. `pkill -9 -f Docker` covers the UI helper and the linuxkit
    // hyperkit/vmnet processes.
    const killUI = await runProcess('pkill', ['-9', '-f', 'Docker.app']);
    steps.push({
      name: 'Kill Docker.app',
      ok: killUI.code === 0 || killUI.code === 1, // 1 = no matching processes, also fine
      detail: killUI.stderr || undefined,
    });
    const killVm = await runProcess('pkill', ['-9', '-f', 'com.docker']);
    steps.push({
      name: 'Kill com.docker.* helpers',
      ok: killVm.code === 0 || killVm.code === 1,
      detail: killVm.stderr || undefined,
    });
    resetDockerClient();
    return { quit: true, steps };
  }

  // Windows path.
  // 1. Force-kill UI + backend by image name. Exact names only — never
  //    touch `node.exe` (Claude Code / Electron run on it).
  for (const image of ['Docker Desktop.exe', 'com.docker.backend.exe']) {
    const r = await runProcess('taskkill', ['/F', '/T', '/IM', image]);
    // taskkill returns 128 / 1 when the image isn't running — that's fine.
    const ok = r.code === 0 || /not found|not running/i.test(r.stderr);
    steps.push({
      name: `Force-kill ${image}`,
      ok,
      detail: ok ? undefined : r.stderr.trim() || `exit ${r.code}`,
    });
  }

  // 2. Shut down WSL distros. This is the step that actually unwedges
  //    Docker Desktop on next start — without it, docker-desktop-data
  //    stays mounted with a dirty vhdx and the engine handshake hangs.
  //    `wsl --shutdown` is global; we don't single out distros so we
  //    don't accidentally miss a renamed one.
  const wsl = await runProcess('wsl.exe', ['--shutdown'], 30_000);
  steps.push({
    name: 'wsl --shutdown',
    ok: wsl.code === 0,
    detail: wsl.code === 0 ? undefined : wsl.stderr.trim() || `exit ${wsl.code}`,
  });

  // 3. Stop com.docker.service via the Service Control Manager. `sc
  //    stop` is graceful from the SCM's perspective but doesn't depend
  //    on the Docker Desktop UI being responsive. If it's already
  //    stopped (1062) or doesn't exist (1060), that's a pass.
  const sc = await runProcess('sc.exe', ['stop', 'com.docker.service'], 15_000);
  const scOk = sc.code === 0 || sc.code === 1062 || sc.code === 1060;
  steps.push({
    name: 'sc stop com.docker.service',
    ok: scOk,
    detail: scOk ? undefined : sc.stderr.trim() || `exit ${sc.code}`,
  });

  // 4. If the service refused to stop via SCM, escalate to taskkill.
  //    This should be rare — only happens if Docker's service host is
  //    truly hung, not just "engine not started yet".
  if (!scOk) {
    const r = await runProcess('taskkill', ['/F', '/IM', 'com.docker.service']);
    steps.push({
      name: 'Force-kill com.docker.service',
      ok: r.code === 0 || /not found|not running/i.test(r.stderr),
      detail: r.code === 0 ? undefined : r.stderr.trim() || `exit ${r.code}`,
    });
  }

  resetDockerClient();
  log.info('docker desktop force-quit completed', { steps });
  const allOk = steps.every((s) => s.ok);
  return { quit: allOk, steps, error: allOk ? undefined : 'One or more recovery steps failed.' };
}

/**
 * Docker's log stream multiplexes stdout + stderr with an 8-byte header
 * per frame. Strip headers and decode, then strip ANSI control sequences
 * the dvpnx logger emits (colours, bold) so the renderer's <pre> doesn't
 * print raw `[90m`/`[0m` literals.
 */
function stripDockerFrames(buf: Buffer): string {
  let out = '';
  let p = 0;
  while (p < buf.length) {
    // frame = [stream(1), _, _, _, sizeBE(4), payload]
    const size = buf.readUInt32BE(p + 4);
    if (Number.isNaN(size) || p + 8 + size > buf.length || size < 0 || size > 10 * 1024 * 1024) {
      // Not a framed payload — return raw.
      return stripAnsi(buf.toString('utf8'));
    }
    out += buf.slice(p + 8, p + 8 + size).toString('utf8');
    p += 8 + size;
  }
  return stripAnsi(out);
}

// Matches ECMA-48 CSI sequences (ESC [ ... final-byte) AND bare 7-bit CSI
// (`\x9b ... final-byte`). Covers SGR (colours), cursor moves, and the rest
// of the terminal-control alphabet — anything we don't want surfacing in the
// deploy log <pre>.
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]|\x9B[0-?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
