import { describe, expect, it } from 'vitest';
import { hnsState } from '../../src/renderer/src/components/HnsResolverControl';
import type { DeployedNode, NodeLiveStatus } from '../../src/shared/types';

// H3 (0.3.1): the node page must say whether users' DNS really goes through the node.
const node = (p: Partial<DeployedNode>) => ({ handshakeDns: true, ...p }) as DeployedNode;
const st = (p: Partial<NodeLiveStatus>) => p as NodeLiveStatus;

describe('hnsState', () => {
  it('off when the switch is off, whatever the probe says', () => {
    expect(hnsState(node({ handshakeDns: false }), st({ hnsdRunning: true, hnsRouting: true })).label).toBe('Off');
  });
  it('routing users DNS only when hnsd AND the redirect are up (image 0.3.1)', () => {
    expect(hnsState(node({}), st({ hnsdRunning: true, hnsRouting: true }))).toEqual({ label: 'Routing users’ DNS', tone: 'ok' });
  });
  it('an older image runs hnsd but does not route users: a warning that says what to do', () => {
    const s = hnsState(node({}), st({ hnsdRunning: true, hnsRouting: false }));
    expect(s.tone).toBe('warn');
    expect(s.label).toMatch(/update the node image/);
  });
  it('hnsd down is an error even if routing rules exist', () => {
    expect(hnsState(node({}), st({ hnsdRunning: false, hnsRouting: true })).tone).toBe('err');
  });
  it('0.3.5: routing is only "ok" once the Handshake chain is synced', () => {
    const up = { hnsdRunning: true, hnsRouting: true };
    expect(hnsState(node({}), st({ ...up, hnsSync: { state: 'synced', percent: 99, height: 355483, ageSec: 60 } })).tone).toBe('ok');
    expect(hnsState(node({}), st({ ...up, hnsSync: { state: 'unknown' } })).tone).toBe('ok'); // older image, no file
    const syncing = hnsState(node({}), st({ ...up, hnsSync: { state: 'syncing', percent: 45, height: 163120, ageSec: 2 } }));
    expect(syncing).toEqual({ label: 'Syncing the Handshake chain · 45%', tone: 'warn' });
    expect(hnsState(node({}), st({ ...up, hnsSync: { state: 'starting', ageSec: 30 } })).tone).toBe('warn');
  });
  it('0.3.5: a stalled hnsd is an error that names the ports to open', () => {
    const up = { hnsdRunning: true, hnsRouting: true };
    const never = hnsState(node({}), st({ ...up, hnsSync: { state: 'stalled', ageSec: 3000 } }));
    expect(never.tone).toBe('err');
    expect(never.label).toMatch(/reached no Handshake peer.*outbound TCP from the node/);
    const stuck = hnsState(node({}), st({ ...up, hnsSync: { state: 'stalled', height: 355000, ageSec: 3600 } }));
    expect(stuck.label).toMatch(/no new block for 60 min/);
  });
  it('a restart or protocol switch in progress reads Restarting, not the stale Routing (NM-C9 0.3.5)', () => {
    expect(hnsState(node({}), st({ hnsdRunning: true, hnsRouting: true, configChange: 'A restart' }))).toEqual({ label: 'Restarting…', tone: 'warn' });
  });
  it('NM-C9-4: synced on an older image asks for a Restart to get the HNS fixes', () => {
    const s = hnsState(node({}), st({ hnsdRunning: true, hnsRouting: true, hnsImageOutdated: true, hnsSync: { state: 'synced' } }));
    expect(s).toEqual({ label: 'Routing users’ DNS · Restart to update the node image (HNS fixes)', tone: 'warn' });
  });
  it('a recorded hnsd error wins over an old probe', () => {
    expect(hnsState(node({ hnsdError: 'x' }), st({ hnsdRunning: true, hnsRouting: true })).label).toBe('Not running');
  });
});
