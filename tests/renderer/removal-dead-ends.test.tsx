import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { SolanaNodePanel } from '../../src/renderer/src/components/SolanaNodePanel';
import type { DeployedNode, RemovalStage } from '../../src/shared/types';

/**
 * T1 (0.3.1 plan): every removal state the app can persist must either (a) offer an
 * enabled action, or (b) be an honest wait that says what is happening. A failure the
 * user can see (removalError, pendingHostCleanup) must ALWAYS come with an enabled
 * button. v0.3.0 shipped a state that showed "Working…" while every retry failed
 * (Docker Desktop off), and one where host cleanup failed with SSH connected and the
 * card showed neither the reason nor a way out.
 */

afterEach(cleanup);

let sshConnected = true;
beforeEach(() => {
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    nodes: {
      sshConnected: vi.fn(() => Promise.resolve(sshConnected)),
      withdrawBond: vi.fn(),
      retryRemoval: vi.fn(),
      forgetServer: vi.fn(),
      reconnect: vi.fn(),
    },
    docker: { start: vi.fn() },
  };
});

const STAGES: RemovalStage[] = ['redeem', 'stop', 'delist', 'close', 'unbonding', 'withdraw-bond', 'sweep'];
const ERRORS = [
  undefined,
  'Chain commands for this node need Docker on this computer or a server the app is connected to. Start Docker Desktop, or connect a server under Settings → Chain-call server.',
  'RPC 429 Too Many Requests',
];

interface Case {
  stage: RemovalStage;
  target: 'local' | 'remote';
  ssh: boolean;
  error?: string;
  hostCleanup: boolean;
  unlocked: boolean;
}

const cases: Case[] = [];
for (const stage of STAGES)
  for (const target of ['local', 'remote'] as const)
    for (const ssh of target === 'remote' ? [true, false] : [true])
      for (const error of ERRORS)
        for (const hostCleanup of stage === 'sweep' && target === 'remote' ? [false, true] : [false])
          for (const unlocked of stage === 'unbonding' ? [false, true] : [true])
            cases.push({ stage, target, ssh, error, hostCleanup, unlocked });

function nodeFor(c: Case): DeployedNode {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    moniker: 'dvpn-test',
    target: c.target,
    host: c.target === 'remote' ? '203.0.113.7' : undefined,
    port: 7777,
    serviceType: 'wireguard',
    status: 'loading',
    operatorAddress: 'Node11111111111111111111111111111111111111',
    registeredOnChain: true,
    removalStage: c.stage,
    unbondsAt: new Date(Date.now() + (c.unlocked ? -60_000 : 30 * 60_000)).toISOString(),
    removalError: c.error ? { stage: c.stage, message: c.error, at: Date.now() } : undefined,
    pendingHostCleanup: c.hostCleanup ? { reason: 'ufw: command failed', at: Date.now() } : undefined,
  } as unknown as DeployedNode;
}

const label = (c: Case) =>
  `${c.stage} · ${c.target}${c.target === 'remote' ? (c.ssh ? ' ssh-up' : ' ssh-down') : ''} · ${c.error ? c.error.slice(0, 20) : 'no-error'}${c.hostCleanup ? ' · host-cleanup' : ''}${c.stage === 'unbonding' ? (c.unlocked ? ' · unlocked' : ' · locked') : ''}`;

describe('T1 removal card has no dead ends', () => {
  it.each(cases.map((c) => [label(c), c] as const))('%s', async (_name, c) => {
    sshConnected = c.ssh;
    const { container } = render(<SolanaNodePanel node={nodeFor(c)} status={null} />);
    if (c.target === 'remote') await waitFor(() => expect(window.api.nodes.sshConnected).toHaveBeenCalled());
    await waitFor(() => {
      const enabled = [...container.querySelectorAll('button')].filter((b) => !b.disabled);
      const text = container.textContent ?? '';
      const visibleFailure = Boolean(c.error || c.hostCleanup);
      if (visibleFailure) {
        // The reason is on screen, and there is something to press.
        expect(text).toContain(c.error ? c.error.slice(0, 30) : 'ufw: command failed');
        expect(enabled.length).toBeGreaterThan(0);
      } else {
        // An honest wait: either an action, a countdown, or the in-progress line.
        const honestWait = /unlocks|Working through the removal steps/.test(text);
        expect(enabled.length > 0 || honestWait).toBe(true);
      }
      // "Working…" must never be the only thing on screen next to a known failure.
      if (visibleFailure) expect(text).not.toMatch(/^\s*Working through the removal steps[^]*$/);
    });
  });

  it('covers the whole state space (positive control on the generator)', () => {
    expect(cases.length).toBeGreaterThan(60);
    expect(cases.some((c) => c.hostCleanup && c.ssh)).toBe(true);
  });
});
