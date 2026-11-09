import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Q0394: the node image needs BuildKit, which needs the buildx plugin ───
// Stock Ubuntu docker.io (29.1.3) ships without buildx, and every build died mid-way with
// "BuildKit is enabled but the buildx component is missing". The app now checks
// `docker buildx version` first and stops with the install command.

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/snm-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
}));

type Plan = { code?: number; out?: string; error?: string };
let plan: Plan = {};
const calls: string[][] = [];

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      setTimeout(() => {
        if (plan.error) {
          child.emit('error', new Error(plan.error));
          return;
        }
        if (plan.out) child.stderr.emit('data', Buffer.from(plan.out));
        child.emit('close', plan.code ?? 0);
      }, 0);
      return child;
    },
  };
});

const { localBuildxVersion } = await import('../../src/main/services/docker');
const { buildxMissingError } = await import('../../src/main/services/validate');

beforeEach(() => {
  plan = {};
  calls.length = 0;
});

describe('localBuildxVersion', () => {
  it('runs exactly `docker buildx version`', async () => {
    plan = { code: 0, out: 'github.com/docker/buildx 0.17.1' };
    await localBuildxVersion();
    expect(calls).toEqual([['docker', 'buildx', 'version']]);
  });
  it('ok when buildx answers (exit 0)', async () => {
    plan = { code: 0, out: 'github.com/docker/buildx 0.17.1' };
    expect((await localBuildxVersion()).ok).toBe(true);
  });
  it('NOT ok on stock docker.io (buildx is not a docker command, exit 1)', async () => {
    plan = { code: 1, out: "docker: 'buildx' is not a docker command." };
    const r = await localBuildxVersion();
    expect(r.ok).toBe(false);
    expect(r.output).toContain("'buildx' is not a docker command");
  });
  it('NOT ok when docker itself is missing (spawn error)', async () => {
    plan = { error: 'spawn docker ENOENT' };
    const r = await localBuildxVersion();
    expect(r.ok).toBe(false);
    expect(r.output).toContain('ENOENT');
  });
});

describe('buildxMissingError', () => {
  it('names where it is missing and both install commands', () => {
    const m = buildxMissingError('vps-1 (203.0.113.10)').message;
    expect(m).toContain('buildx plugin, which is missing on vps-1 (203.0.113.10)');
    expect(m).toContain('sudo apt install docker-buildx"');
    expect(m).toContain('sudo apt install docker-buildx-plugin');
    expect(m).toContain('deploy again');
  });
  it('carries only the first line of docker\'s own message', () => {
    const m = buildxMissingError('this computer', "docker: 'buildx' is not a docker command.\nSee 'docker --help'").message;
    expect(m).toContain("(docker: 'buildx' is not a docker command.)");
    expect(m).not.toContain('--help');
  });
});
