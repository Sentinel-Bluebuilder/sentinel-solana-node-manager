import { app } from 'electron';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Client } from 'ssh2';
import { PREBUILT_IMAGE_RELEASE_URL, PREBUILT_IMAGE_SOURCE, PREBUILT_IMAGE_TAG, remoteLoadScript } from './prebuilt-image';

/** Download + load of the prebuilt image on a server (slow links included). */
const PREBUILT_REMOTE_TIMEOUT_MS = 30 * 60_000;
import {
  buildRecipe,
  imageBuildArgs,
  LEGACY_IMAGE_TAG,
  NODE_HOME,
  NODE_ENV,
  NODE_SECURITY_OPT,
  NODE_SYSCTLS,
  NODE_LOG_OPTS,
  containerLogs,
  containerName,
  ensureImage,
  execInside,
  getClient,
  hasImage,
  isRunning,
  nodeCommand,
  removeContainer,
  restartContainer,
  runNode,
  runOnce,
  stopContainer,
  withDockerTimeout,
  type RunOnceExtra,
} from './docker';
import { getSettings } from './settings';
import { cliLayoutOf } from './cli-probe';
import { connectClient, runRemote, shellQuote, uploadBuffer, uploadFile } from './ssh';
import { log } from './logger';
import { removePath, sudoRead, sudoWrite, withRootFallback } from './local-privileged';
import { BUILD_IDLE_LIMIT_MS, IMAGE_BUILD_NETWORK, buildFailureSummary, buildStalledError, buildxMissingError, idleWatchdog } from './validate';
import type { DeployedNode, SSHCredentials } from '../../shared/types';

/**
 * One interface over "a place a node runs": this machine's Docker, or a VPS
 * reached over SSH running Docker. Deploy and management code is written
 * once against it, so local and remote nodes behave identically.
 *
 * The node home lives on the host and is mounted at NODE_HOME in every
 * container (daemon, one-shot `dvpnd init` / `dvpnctl` runs, test client).
 */

export interface ExecResult {
  exitCode: number;
  output: string;
}

export interface OnceOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  extra?: RunOnceExtra;
}

export interface NodeRuntime {
  readonly kind: 'local' | 'remote';
  /** Host (SSH) or 'This device'. */
  readonly label: string;
  /** Node home path on the host. */
  readonly homeOnHost: string;
  /**
   * Image this node runs: set from the node record (or resolveImageTag() during a
   * deploy) so one-shots and restarts use the image the node was deployed with.
   */
  imageTag: string;
  prepare(): Promise<void>;
  imageReady(): Promise<boolean>;
  buildImage(onLog: (line: string) => void, signal?: AbortSignal): Promise<void>;
  /** Write a file under the node home (relative path), mode 0600 by default. */
  writeFile(rel: string, content: string, mode?: number): Promise<void>;
  readFile(rel: string): Promise<string>;
  removeFile(rel: string): Promise<void>;
  removeHome(): Promise<void>;
  /**
   * Node-id directories this host holds under the node-home base, whichever node
   * they belong to. Removal used to abandon a home whose cleanup could not run,
   * and nothing afterwards could find it; this is how the app enumerates its own
   * leftovers. Returns UUID directory names only.
   */
  listHomes(): Promise<string[]>;
  /** Delete one node-id directory under the node-home base (not this node's own). */
  removeHomeById(nodeId: string): Promise<void>;
  /** One-shot container with the node home mounted. */
  runOnce(entrypoint: string[], cmd: string[], opts?: OnceOptions): Promise<ExecResult>;
  /** Run inside the node's running container. */
  exec(cmd: string[], timeoutMs?: number): Promise<ExecResult>;
  startContainer(ports: number[]): Promise<string>;
  stopContainer(): Promise<void>;
  restartContainer(): Promise<void>;
  removeContainer(): Promise<void>;
  isRunning(): Promise<boolean>;
  /** Bridge IP of the node container (for same-host test clients). */
  containerIp(): Promise<string | undefined>;
  logs(tail: number): Promise<string[]>;
  /** Ports from `ports` already in use on the host. */
  busyPorts(ports: number[]): Promise<number[]>;
  /**
   * Open the node's ports (tcp+udp) in the host firewall when the host runs one
   * the app knows (ufw). Returns a one-line description; `opened` says whether a
   * rule was added (so removal can take it away again).
   */
  openPorts(ports: number[]): Promise<{ opened: boolean; detail: string }>;
  closePorts(ports: number[]): Promise<void>;
  close(): Promise<void>;
}

const NODE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertNodeId(id: string): void {
  if (!NODE_ID_RE.test(id)) throw new Error(`refusing to operate on non-UUID node id "${id}"`);
}

function assertRel(rel: string): void {
  if (rel.startsWith('/') || rel.includes('..') || !/^[A-Za-z0-9_./-]+$/.test(rel)) {
    throw new Error(`refusing unsafe node-home path "${rel}"`);
  }
}

export function localNodeDir(nodeId: string): string {
  return path.join(app.getPath('userData'), 'nodes', nodeId);
}

// ─── Local (Docker Desktop / local engine) ───

class LocalRuntime implements NodeRuntime {
  readonly kind = 'local' as const;
  readonly label = 'This device';
  readonly homeOnHost: string;
  private containerId: string | undefined;
  imageTag: string;

  constructor(private readonly nodeId: string, containerId?: string, imageTag = LEGACY_IMAGE_TAG) {
    assertNodeId(nodeId);
    this.imageTag = imageTag;
    this.homeOnHost = localNodeDir(nodeId);
    this.containerId = containerId;
  }

  private get ref(): string {
    return this.containerId ?? containerName(this.nodeId);
  }

  async prepare(): Promise<void> {
    await fs.mkdir(this.homeOnHost, { recursive: true });
  }

  imageReady(): Promise<boolean> {
    return hasImage(this.imageTag);
  }

  buildImage(onLog: (line: string) => void, signal?: AbortSignal): Promise<void> {
    return ensureImage(this.imageTag, onLog, signal);
  }

  // File access falls back to sudo when the node container (root) owns the files: rootful
  // Docker on a Linux host with the app running as a normal user (local-privileged.ts).
  async writeFile(rel: string, content: string, mode = 0o600): Promise<void> {
    assertRel(rel);
    const p = path.join(this.homeOnHost, rel);
    await withRootFallback(
      `write ${rel}`,
      async () => {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, { mode });
      },
      () => sudoWrite(p, content, mode),
    );
  }

  async readFile(rel: string): Promise<string> {
    assertRel(rel);
    const p = path.join(this.homeOnHost, rel);
    return withRootFallback(`read ${rel}`, () => fs.readFile(p, 'utf8'), () => sudoRead(p));
  }

  async removeFile(rel: string): Promise<void> {
    assertRel(rel);
    await removePath(path.join(this.homeOnHost, rel), false);
  }

  async removeHome(): Promise<void> {
    await removePath(this.homeOnHost, true);
  }

  async listHomes(): Promise<string[]> {
    const base = path.dirname(this.homeOnHost);
    const entries = await fs.readdir(base, { withFileTypes: true }).catch((err: unknown) => {
      log.debug('listHomes: node home base unreadable', { base, err: (err as Error).message });
      return [] as import('node:fs').Dirent[];
    });
    return entries.filter((e) => e.isDirectory() && NODE_ID_RE.test(e.name)).map((e) => e.name);
  }

  async removeHomeById(nodeId: string): Promise<void> {
    assertNodeId(nodeId);
    await removePath(path.join(path.dirname(this.homeOnHost), nodeId), true);
  }

  runOnce(entrypoint: string[], cmd: string[], opts: OnceOptions = {}): Promise<ExecResult> {
    return runOnce({
      hostDataDir: this.homeOnHost,
      imageTag: this.imageTag,
      entrypoint,
      cmd,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onLog: opts.onLog,
      extra: opts.extra,
    });
  }

  exec(cmd: string[], timeoutMs = 60_000): Promise<ExecResult> {
    return withDockerTimeout(() => execInside(this.ref, cmd), timeoutMs, `exec ${cmd.slice(0, 3).join(' ')}`);
  }

  async startContainer(ports: number[]): Promise<string> {
    const cmd = nodeCommand(await cliLayoutOf(this));
    this.containerId = await runNode({ nodeId: this.nodeId, hostDataDir: this.homeOnHost, ports, imageTag: this.imageTag, cmd });
    return this.containerId;
  }

  stopContainer(): Promise<void> {
    return withDockerTimeout(() => stopContainer(this.ref), 45_000, 'stopContainer');
  }

  restartContainer(): Promise<void> {
    return withDockerTimeout(() => restartContainer(this.ref), 60_000, 'restartContainer');
  }

  removeContainer(): Promise<void> {
    return withDockerTimeout(() => removeContainer(this.ref), 45_000, 'removeContainer');
  }

  isRunning(): Promise<boolean> {
    return withDockerTimeout(() => isRunning(this.ref), 10_000, 'isRunning');
  }

  logs(tail: number): Promise<string[]> {
    return withDockerTimeout(() => containerLogs(this.ref, tail), 10_000, 'containerLogs');
  }

  async containerIp(): Promise<string | undefined> {
    const c = await getClient();
    const info = await withDockerTimeout(() => c.getContainer(this.ref).inspect(), 10_000, 'inspect');
    const nets = Object.values(info.NetworkSettings?.Networks ?? {});
    return nets.map((n) => n.IPAddress).find(Boolean);
  }

  async busyPorts(ports: number[]): Promise<number[]> {
    const busy: number[] = [];
    for (const p of ports) {
      if (!(await tcpFree(p)) || !(await udpFree(p))) busy.push(p);
    }
    return busy;
  }

  async openPorts(): Promise<{ opened: boolean; detail: string }> {
    // Docker Desktop publishes to the host; the OS firewall / router are the user's.
    return { opened: false, detail: 'local host: forward the ports in your router / OS firewall if clients should reach this node from the internet' };
  }

  async closePorts(): Promise<void> {
    // Nothing to undo locally.
  }

  async close(): Promise<void> {
    // Nothing held open locally.
  }
}

function tcpFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function udpFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      sock.close();
      resolve(false);
    });
    sock.bind(port, '0.0.0.0', () => sock.close(() => resolve(true)));
  });
}

// ─── Remote (SSH + docker CLI) ───

class RemoteRuntime implements NodeRuntime {
  readonly kind = 'remote' as const;
  readonly label: string;
  homeOnHost = '';
  private sudo = '';
  private homeBase = '';
  imageTag: string;

  constructor(
    private readonly nodeId: string,
    private readonly client: Client,
    host: string,
    imageTag = LEGACY_IMAGE_TAG,
  ) {
    assertNodeId(nodeId);
    this.label = host;
    this.imageTag = imageTag;
  }

  /** Resolve uid/sudo and the absolute node home. Called once by openRuntime. */
  async init(): Promise<void> {
    const id = await this.sh('id -u', 15_000);
    const isRoot = id.output.trim() === '0';
    if (!isRoot) {
      const probe = await this.sh('sudo -n true 2>&1', 15_000);
      if (probe.exitCode !== 0) {
        throw new Error(
          'Passwordless sudo is required for non-root SSH deploys. Configure NOPASSWD sudo for this user or connect as root.',
        );
      }
    }
    this.sudo = isRoot ? '' : 'sudo -n ';
    const home = (await this.sh('printf %s "$HOME"', 15_000)).output.trim();
    if (!/^\/[A-Za-z0-9_./-]+$/.test(home) || home.includes('..')) throw new Error(`unsafe remote $HOME "${home}"`);
    this.homeBase = `${home}/.dvpnd-nodes`;
    this.homeOnHost = `${this.homeBase}/${this.nodeId}`;
  }

  private async sh(
    command: string,
    timeoutMs = 120_000,
    opts: { signal?: AbortSignal; stdin?: string; onLog?: (l: string) => void } = {},
  ): Promise<ExecResult & { stdout: string; stderr: string }> {
    const r = await runRemote(this.client, command, opts.onLog, { timeoutMs, signal: opts.signal, stdin: opts.stdin });
    if (r.code === 124) throw new Error(`remote command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 80)}`);
    if (r.code === -1) throw new Error('remote command cancelled');
    return { exitCode: r.code, output: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
  }

  private docker(args: string[]): string {
    return this.sudo + shellQuote(['docker', ...args]);
  }

  async prepare(): Promise<void> {
    const r = await this.sh(`${this.sudo}mkdir -p ${shellQuote([this.homeOnHost])}`, 15_000);
    if (r.exitCode !== 0) throw new Error(`could not create ${this.homeOnHost}: ${r.output.trim()}`);
  }

  /** Install Docker if missing (get.docker.com), as the Cosmos app did. */
  async ensureDocker(onLog: (l: string) => void): Promise<void> {
    const probe = await this.sh('docker --version 2>/dev/null || true', 15_000);
    if (/Docker version/i.test(probe.output)) return;
    onLog('[remote] Docker not found — installing from get.docker.com');
    const r = await this.sh(
      `curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && ${this.sudo}sh /tmp/get-docker.sh`,
      900_000,
      { onLog },
    );
    if (r.exitCode !== 0) throw new Error(`Docker install failed: ${r.output.trim().slice(-400)}`);
  }

  async imageReady(): Promise<boolean> {
    const r = await this.sh(`${this.docker(['image', 'inspect', this.imageTag])} >/dev/null 2>&1 && echo yes || echo no`, 30_000);
    return r.output.trim().endsWith('yes');
  }

  async buildImage(onLog: (line: string) => void, signal?: AbortSignal): Promise<void> {
    await this.ensureDocker(onLog);
    if (this.imageTag === PREBUILT_IMAGE_TAG) {
      // Prebuilt image: the server downloads its CPU's image file, checks the pinned SHA-256
      // and loads it. No build context upload, no buildx.
      onLog(`[remote] downloading the node image on ${this.label} (one time) and checking its checksum`);
      const r = await this.sh('bash -s', PREBUILT_REMOTE_TIMEOUT_MS, {
        stdin: remoteLoadScript(`${this.sudo}docker`),
        signal,
        onLog: (l: string) => {
          if (l.trim()) onLog(`[remote] ${l.trim()}`);
        },
      });
      if (r.exitCode !== 0 || !r.output.includes('PREBUILT_OK')) {
        // NM-C9: a 404 means the release does not carry this image (not published yet), not a
        // network or server fault. Say that first; keep the raw output for support.
        if (/returned error: 404|404.*Not Found/i.test(r.output)) {
          throw new Error(
            `Node image ${PREBUILT_IMAGE_TAG.replace(/^.*prebuilt-/, '')} is not published yet: its download returned 404 (${PREBUILT_IMAGE_RELEASE_URL}). ` +
              `Load the image on ${this.label} by hand, or use an app version whose node image is published.`,
          );
        }
        throw new Error(`Loading the node image on ${this.label} failed (exit ${r.exitCode}): ${r.output.trim().slice(-600)}`);
      }
      onLog(`[remote] ${PREBUILT_IMAGE_TAG} ready on ${this.label} (${PREBUILT_IMAGE_SOURCE})`);
      return;
    }
    // Fail before the upload when BuildKit's buildx plugin is missing (stock docker.io, Q0394).
    const bx = await this.sh(this.docker(['buildx', 'version']), 30_000);
    if (bx.exitCode !== 0) throw buildxMissingError(this.label, bx.output);
    const tarball = await packBuildContext();
    const ctx = `/tmp/dvpnd-ctx-${this.nodeId.slice(0, 8)}`;
    onLog(`[remote] uploading build context (${(tarball.length / 1e6).toFixed(1)} MB)`);
    await this.sh(`rm -rf ${ctx} && mkdir -p ${ctx}`, 30_000);
    await uploadBuffer(this.client, `${ctx}/context.tgz`, tarball);
    const recipe = await buildRecipe();
    await uploadFile(this.client, `${ctx}/dvpnd.Dockerfile`, recipe.dockerfile);
    await uploadFile(this.client, `${ctx}/dvpnd.Dockerfile.dockerignore`, recipe.dockerignore);
    const extract = await this.sh(`mkdir -p ${ctx}/src && tar -xzf ${ctx}/context.tgz -C ${ctx}/src`, 120_000);
    if (extract.exitCode !== 0) throw new Error(`extracting build context failed: ${extract.output.trim().slice(-300)}`);
    const buildArgs = Object.entries(await imageBuildArgs()).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]);
    let r: ExecResult;
    // A stalled download (e.g. MTU, Q0405) is cancelled after BUILD_IDLE_LIMIT_MS of silence, not at 45 min.
    const ac = new AbortController();
    const onUserAbort = () => ac.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });
    if (signal?.aborted) ac.abort();
    let stalled = false;
    let lastLine = '';
    const idle = idleWatchdog(BUILD_IDLE_LIMIT_MS, () => {
      stalled = true;
      ac.abort();
    });
    try {
      // The Dockerfile needs BuildKit (cache mounts, heredocs); older docker.io packages default it off.
      // Host network: the build uses the NIC's MTU, not the 1500 bridge (Q0405).
      r = await this.sh(
        `DOCKER_BUILDKIT=1 ${this.docker(['build', ...IMAGE_BUILD_NETWORK, '-f', `${ctx}/dvpnd.Dockerfile`, '-t', this.imageTag, '--progress=plain', ...buildArgs, `${ctx}/src`])}`,
        45 * 60_000,
        {
          onLog: (l: string) => {
            idle.poke();
            if (l.trim()) lastLine = l;
            onLog(l);
          },
          signal: ac.signal,
        },
      );
    } catch (err) {
      if (stalled) throw buildStalledError(this.label, BUILD_IDLE_LIMIT_MS, lastLine);
      throw err;
    } finally {
      idle.stop();
      signal?.removeEventListener('abort', onUserAbort);
      await this.sh(`rm -rf ${ctx}`, 30_000).catch((err: unknown) => log.warn('remote ctx cleanup failed', { err: String(err) }));
    }
    if (stalled) throw buildStalledError(this.label, BUILD_IDLE_LIMIT_MS, lastLine);
    if (r.exitCode !== 0) throw new Error(`docker build failed on ${this.label}: ${buildFailureSummary(r.output)}`);
  }

  async writeFile(rel: string, content: string, mode = 0o600): Promise<void> {
    assertRel(rel);
    const tmp = `/tmp/.snm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await uploadFile(this.client, tmp, content, 0o600);
    const dest = `${this.homeOnHost}/${rel}`;
    const r = await this.sh(
      `${this.sudo}mkdir -p ${shellQuote([path.posix.dirname(dest)])} && ${this.sudo}install -m ${mode.toString(8)} ${shellQuote([tmp, dest])}; rc=$?; rm -f ${shellQuote([tmp])}; exit $rc`,
      30_000,
    );
    if (r.exitCode !== 0) throw new Error(`writing ${rel} on ${this.label} failed: ${r.output.trim()}`);
  }

  async readFile(rel: string): Promise<string> {
    assertRel(rel);
    const r = await this.sh(`${this.sudo}cat ${shellQuote([`${this.homeOnHost}/${rel}`])}`, 30_000);
    if (r.exitCode !== 0) throw new Error(`reading ${rel} on ${this.label} failed: ${r.output.trim()}`);
    // stdout only: sudo / shell noise on stderr must never be written back into a TOML file.
    return r.stdout;
  }

  async removeFile(rel: string): Promise<void> {
    assertRel(rel);
    await this.sh(`${this.sudo}rm -f ${shellQuote([`${this.homeOnHost}/${rel}`])}`, 30_000);
  }

  async removeHome(): Promise<void> {
    if (!this.homeOnHost.startsWith(`${this.homeBase}/`)) throw new Error('refusing to remove an unexpected remote path');
    await this.sh(`${this.sudo}rm -rf ${shellQuote([this.homeOnHost])}`, 60_000);
  }

  async listHomes(): Promise<string[]> {
    // -1 and a trailing check keep this quiet on a host that never hosted a node.
    const r = await this.sh(`${this.sudo}ls -1 ${shellQuote([this.homeBase])} 2>/dev/null || true`, 30_000);
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => NODE_ID_RE.test(l));
  }

  async removeHomeById(nodeId: string): Promise<void> {
    assertNodeId(nodeId);
    // Built from the validated base + a UUID, never from caller-supplied text, so
    // this can only ever address a node directory the app itself created.
    const target = `${this.homeBase}/${nodeId}`;
    if (!target.startsWith(`${this.homeBase}/`)) throw new Error('refusing to remove an unexpected remote path');
    await this.sh(`${this.sudo}rm -rf ${shellQuote([target])}`, 60_000);
  }

  async runOnce(entrypoint: string[], cmd: string[], opts: OnceOptions = {}): Promise<ExecResult> {
    const extra = opts.extra ?? {};
    const name = `snm-once-${this.nodeId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
    const args = ['run', '--rm', '--name', name, '-v', `${this.homeOnHost}:${NODE_HOME}`];
    for (const c of extra.capAdd ?? []) args.push('--cap-add', c);
    if (extra.tun) args.push('--device', '/dev/net/tun:/dev/net/tun');
    if (extra.unmaskSysPaths) for (const o of NODE_SECURITY_OPT) args.push('--security-opt', o);
    for (const [k, v] of Object.entries(extra.sysctls ?? {})) args.push('--sysctl', `${k}=${v}`);
    for (const h of extra.extraHosts ?? []) args.push('--add-host', h);
    // Environment goes through a 0600 file, not argv: with sudo every argv line
    // (RPC URL with its API key included) would be written to auth.log.
    const envRel = extra.env?.length ? `.env-${name}` : undefined;
    if (envRel) {
      await this.writeFile(envRel, extra.env!.join('\n') + '\n', 0o600);
      args.push('--env-file', `${this.homeOnHost}/${envRel}`);
    }
    for (const b of extra.binds ?? []) args.push('-v', b);
    args.push('--entrypoint', entrypoint[0], this.imageTag, ...entrypoint.slice(1), ...cmd);
    try {
      return await this.sh(this.docker(args), opts.timeoutMs ?? 180_000, { signal: opts.signal, onLog: opts.onLog });
    } catch (err) {
      // Timeout / cancel closed only the SSH channel; the container itself keeps
      // running (and could still send a transaction). Kill it over a fresh channel.
      await this.sh(`${this.docker(['rm', '-f', name])} >/dev/null 2>&1 || true`, 30_000).catch((killErr: unknown) =>
        log.warn('remote one-shot container kill failed', { name, err: (killErr as Error).message }),
      );
      throw err;
    } finally {
      if (envRel) await this.removeFile(envRel).catch((err: unknown) => log.warn('remote env file cleanup failed', { err: (err as Error).message }));
    }
  }

  exec(cmd: string[], timeoutMs = 60_000): Promise<ExecResult> {
    return this.sh(this.docker(['exec', containerName(this.nodeId), ...cmd]), timeoutMs);
  }

  async startContainer(ports: number[]): Promise<string> {
    const name = containerName(this.nodeId);
    await this.sh(`${this.docker(['rm', '-f', name])} >/dev/null 2>&1 || true`, 60_000);
    const args = [
      'run', '-d', '--name', name, '--restart', 'unless-stopped',
      '--label', `sentinel-sol.node-id=${this.nodeId}`,
      '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW',
      ...NODE_SECURITY_OPT.flatMap((o) => ['--security-opt', o]),
      '--device', '/dev/net/tun:/dev/net/tun',
      '-v', `${this.homeOnHost}:${NODE_HOME}`,
      ...NODE_ENV.flatMap((e) => ['-e', e]),
    ];
    for (const [k, v] of Object.entries(NODE_SYSCTLS)) args.push('--sysctl', `${k}=${v}`);
    args.push('--log-driver', 'json-file');
    for (const [k, v] of Object.entries(NODE_LOG_OPTS)) args.push('--log-opt', `${k}=${v}`);
    for (const p of ports) args.push('-p', `${p}:${p}/tcp`, '-p', `${p}:${p}/udp`);
    args.push(this.imageTag, ...nodeCommand(await cliLayoutOf(this)));
    const r = await this.sh(this.docker(args), 120_000);
    if (r.exitCode !== 0) throw new Error(`docker run failed on ${this.label}: ${r.output.trim().slice(-400)}`);
    return name;
  }

  async stopContainer(): Promise<void> {
    const name = containerName(this.nodeId);
    const r = await this.sh(`${this.docker(['update', '--restart', 'no', name])} >/dev/null 2>&1; ${this.docker(['stop', '-t', '10', name])}`, 60_000);
    if (r.exitCode !== 0 && !/no such container/i.test(r.output)) throw new Error(`docker stop failed on ${this.label}: ${r.output.trim().slice(-300)}`);
  }

  async restartContainer(): Promise<void> {
    const r = await this.sh(this.docker(['restart', '-t', '10', containerName(this.nodeId)]), 90_000);
    if (r.exitCode !== 0) throw new Error(`docker restart failed: ${r.output.trim()}`);
  }

  async removeContainer(): Promise<void> {
    await this.sh(`${this.docker(['rm', '-f', containerName(this.nodeId)])} || true`, 60_000);
  }

  async isRunning(): Promise<boolean> {
    const r = await this.sh(`${this.docker(['inspect', '-f', '{{.State.Running}}', containerName(this.nodeId)])} 2>/dev/null || echo false`, 30_000);
    return r.output.trim().endsWith('true');
  }

  async containerIp(): Promise<string | undefined> {
    const r = await this.sh(this.docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', containerName(this.nodeId)]), 30_000);
    return r.output.trim().split(/\s+/).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  }

  async logs(tail: number): Promise<string[]> {
    const r = await this.sh(`${this.docker(['logs', '--tail', String(tail), containerName(this.nodeId)])} 2>&1`, 30_000);
    return r.output.split(/\r?\n/).filter(Boolean);
  }

  async busyPorts(ports: number[]): Promise<number[]> {
    const r = await this.sh('ss -lntuH 2>/dev/null || netstat -lntu 2>/dev/null', 15_000);
    const used = new Set<number>();
    for (const m of r.output.matchAll(/[:\]](\d{2,5})\s/g)) used.add(Number(m[1]));
    return ports.filter((p) => used.has(p));
  }

  private async ufwActive(): Promise<boolean> {
    const r = await this.sh(`${this.sudo}ufw status 2>/dev/null | head -1 || true`, 15_000);
    return /Status:\s*active/i.test(r.stdout);
  }

  private static range(ports: number[]): string {
    const sorted = [...ports].sort((a, b) => a - b);
    return sorted.length > 1 && sorted[sorted.length - 1] - sorted[0] === sorted.length - 1 ? `${sorted[0]}:${sorted[sorted.length - 1]}` : sorted.join(',');
  }

  /**
   * A node is only useful if clients can reach it. When the host runs ufw (the
   * default Ubuntu firewall, INPUT policy drop), allow the node's block for
   * tcp+udp, tagged with the node id so removal can delete exactly these rules.
   */
  async openPorts(ports: number[]): Promise<{ opened: boolean; detail: string }> {
    if (!(await this.ufwActive())) return { opened: false, detail: 'ufw is not active on this host (no host firewall rule needed)' };
    const range = RemoteRuntime.range(ports);
    for (const proto of ['tcp', 'udp']) {
      const r = await this.sh(`${this.sudo}ufw allow ${range}/${proto} comment ${shellQuote([`sentinel-node ${this.nodeId.slice(0, 8)}`])}`, 30_000);
      if (r.exitCode !== 0) throw new Error(`could not open ${range}/${proto} in ufw: ${r.output.trim().slice(-200)}`);
    }
    return { opened: true, detail: `ufw: allowed ${range}/tcp and ${range}/udp` };
  }

  async closePorts(ports: number[]): Promise<void> {
    if (!ports.length || !(await this.ufwActive())) return;
    const range = RemoteRuntime.range(ports);
    for (const proto of ['tcp', 'udp']) {
      const r = await this.sh(`${this.sudo}ufw --force delete allow ${range}/${proto} 2>&1 || true`, 30_000);
      if (!/Rule deleted|Could not delete non-existent rule/i.test(r.output)) log.warn('ufw rule removal: unexpected output', { range, proto, out: r.output.trim().slice(-200) });
    }
  }

  async close(): Promise<void> {
    try {
      this.client.end();
    } catch (err) {
      log.debug('ssh client end failed', { err: (err as Error).message });
    }
  }
}

/**
 * Tar the patched upstream tree's four build modules (no bin/, .git, tests)
 * with the system `tar` (bsdtar on Windows 10+, GNU tar elsewhere).
 */
export async function packBuildContext(): Promise<Buffer> {
  const { upstreamDir } = await getSettings();
  const outName = `dvpnd-ctx-${Date.now()}.tgz`;
  const out = path.join(os.tmpdir(), outName);
  const args = [
    '-czf', outName,
    '--exclude=bin', '--exclude=.git', '--exclude=node_modules', '--exclude=*_test.go',
    '-C', upstreamDir,
    ...(await buildRecipe()).modules,
    // Pre-fetched, hash-pinned downloads (GitHub outage / offline host): the Dockerfile uses them.
    ...(await fs.stat(path.join(upstreamDir, '.snm-vendor')).then(() => ['.snm-vendor'], () => [])),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, { windowsHide: true, cwd: os.tmpdir() });
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('error', (e) => reject(new Error(`tar not available: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.slice(-400)}`))));
  });
  try {
    return await fs.readFile(out);
  } finally {
    await fs.rm(out, { force: true });
  }
}

// ─── Factory ───

async function connectSSH(creds: SSHCredentials): Promise<Client> {
  return connectClient(creds); // retries a stalled handshake (Q0341), explains a dead address
}

/**
 * Open a runtime for a node. Remote nodes need SSH credentials (held in
 * memory only; see node-manager rememberSSH). Always `close()` when done.
 */
export async function openRuntime(
  node: Pick<DeployedNode, 'id' | 'target' | 'host' | 'runtimeId' | 'imageTag'>,
  creds?: SSHCredentials,
): Promise<NodeRuntime> {
  const tag = node.imageTag ?? LEGACY_IMAGE_TAG;
  if (node.target === 'local') return new LocalRuntime(node.id, node.runtimeId, tag);
  if (!creds) {
    throw new Error(
      `This node runs on ${node.host ?? 'a remote host'}. Reconnect over SSH (Nodes → node → Reconnect) so the app can manage it.`,
    );
  }
  const client = await connectSSH(creds);
  const rt = new RemoteRuntime(node.id, client, creds.host, tag);
  try {
    await rt.init();
  } catch (err) {
    await rt.close();
    throw err;
  }
  return rt;
}

/** Run `fn` with an open runtime and always close it. */
export async function withRuntime<T>(
  node: Pick<DeployedNode, 'id' | 'target' | 'host' | 'runtimeId' | 'imageTag'>,
  creds: SSHCredentials | undefined,
  fn: (rt: NodeRuntime) => Promise<T>,
): Promise<T> {
  const rt = await openRuntime(node, creds);
  try {
    return await fn(rt);
  } finally {
    await rt.close();
  }
}

export function isRemoteRuntime(rt: NodeRuntime): rt is NodeRuntime & { ensureDocker(onLog: (l: string) => void): Promise<void> } {
  return rt.kind === 'remote';
}
