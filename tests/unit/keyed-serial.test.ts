import { describe, expect, it } from 'vitest';
import { keyedSerial } from '../../src/main/services/validate';

// ─── Q0410: one chain call per node at a time ───
// A node's chain calls share one ctl home and its key file; a status poll that finished during
// a withdraw deleted the key under it. keyedSerial queues jobs per key.

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A job that records when it enters/leaves the shared "key file" section. */
function job(log: string[], name: string, ms: number, fail = false) {
  return async () => {
    log.push(`${name}:in`);
    await tick(ms);
    log.push(`${name}:out`);
    if (fail) throw new Error(`${name} failed`);
    return name;
  };
}

describe('keyedSerial', () => {
  it('jobs on the SAME key never overlap (withdraw + poll on one node)', async () => {
    const run = keyedSerial();
    const log: string[] = [];
    const r = await Promise.all([run('node-a', job(log, 'withdraw', 30)), run('node-a', job(log, 'poll', 5))]);
    expect(r).toEqual(['withdraw', 'poll']);
    expect(log).toEqual(['withdraw:in', 'withdraw:out', 'poll:in', 'poll:out']);
  });
  it('jobs on DIFFERENT keys run side by side', async () => {
    const run = keyedSerial();
    const log: string[] = [];
    await Promise.all([run('node-a', job(log, 'a', 30)), run('node-b', job(log, 'b', 5))]);
    expect(log.slice(0, 2).sort()).toEqual(['a:in', 'b:in']);
  });
  it('a failed job reaches its caller and does not block the next one', async () => {
    const run = keyedSerial();
    const log: string[] = [];
    const bad = run('node-a', job(log, 'bad', 5, true));
    const next = run('node-a', job(log, 'next', 5));
    await expect(bad).rejects.toThrow('bad failed');
    await expect(next).resolves.toBe('next');
    expect(log).toEqual(['bad:in', 'bad:out', 'next:in', 'next:out']);
  });
});
