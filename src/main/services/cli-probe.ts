import { binariesFor, isCb33InitHelp, layoutFromInitHelp, type CliLayout } from './cli-layout';
import { log } from './logger';
import type { NodeRuntime } from './node-runtime';

// ─── Which command-line layout the node's image speaks (see cli-layout.ts) ───

/** The parts of a runtime the probe needs (both runtimes and test fakes have them). */
export type ProbeTarget = Pick<NodeRuntime, 'kind' | 'label' | 'imageTag' | 'runOnce'>;

const layoutCache = new Map<string, CliLayout>();

/**
 * The image's layout, asked once per host + image and remembered. An image tag can
 * mean different builds on two hosts (the legacy tag hashes only the Dockerfile), so
 * the host is part of the key. A cb33 image is asked first: it has `sentinel-dvpnd`
 * and no `dvpnd`.
 */
export async function cliLayoutOf(rt: ProbeTarget, signal?: AbortSignal): Promise<CliLayout> {
  const key = `${rt.kind}|${rt.label}|${rt.imageTag}`;
  const known = layoutCache.get(key);
  if (known) return known;
  const cb33 = await rt.runOnce([binariesFor('cb33').daemon], ['init', '--help'], { timeoutMs: 60_000, signal });
  if (cb33.exitCode === -1) throw new Error('Cancelled while reading the node daemon version.');
  let layout: CliLayout;
  if (isCb33InitHelp(cb33.exitCode, cb33.output)) {
    layout = 'cb33';
  } else {
    const res = await rt.runOnce([binariesFor('older').daemon], ['init', '--help'], { timeoutMs: 60_000, signal });
    if (res.exitCode === -1) throw new Error('Cancelled while reading the node daemon version.');
    layout = layoutFromInitHelp(res.output);
  }
  layoutCache.set(key, layout);
  log.info('node daemon command layout', { image: rt.imageTag, host: rt.label, layout });
  return layout;
}

/** Test hook: forget every probed layout. */
export function clearLayoutCache(): void {
  layoutCache.clear();
}
