import { describe, expect, it } from 'vitest';
import {
  READ_CTL_HOME_ID,
  RESERVED_RUNTIME_HOME_IDS,
  chainCtlPlace,
  chainWaitTimeoutMessage,
  isReservedRuntimeHome,
  remoteFallbackError,
} from '../../src/main/services/validate';

// ─── Q0409: after an app restart (no SSH creds) say "reconnect", not only "buildx" ───
describe('remoteFallbackError', () => {
  it('leads with reconnect, names the server and why, keeps the local error', () => {
    const m = remoteFallbackError('203.0.113.10', 'the app has no SSH connection to it (it is lost at every app restart)', "Building the node image needs Docker's buildx plugin");
    expect(m).toContain('Reconnect to it (Nodes → node → Reconnect), then try again');
    expect(m.indexOf('Reconnect to it')).toBeLessThan(m.indexOf('buildx'));
    expect(m).toContain('its server 203.0.113.10');
    expect(m).toContain('no SSH connection');
    expect(m).toContain('buildx plugin');
  });
  it('NM-C9-3: no SSH session at all -> Reconnect only, no Docker install hint (no Start Docker buttons)', () => {
    const m = remoteFallbackError('198.51.100.20', 'the app has no SSH connection to it', 'Docker Desktop is not installed. Install it from https://www.docker.com/', true);
    expect(m).toContain('Reconnect to 198.51.100.20');
    expect(m).not.toMatch(/Docker/i);
  });
});

// ─── Q0407: a protocol/price change whose confirming read FAILED says why ───
describe('chainWaitTimeoutMessage', () => {
  it('names the read error when the chain could not be read', () => {
    const m = chainWaitTimeoutMessage('protocol amneziawg', 180_000, "Building the node image needs Docker's buildx plugin, which is missing on this computer.");
    expect(m).toContain('could not be read for 180s to confirm protocol amneziawg');
    expect(m).toContain('buildx plugin');
    expect(m).not.toContain('does not show');
  });
  it('keeps "does not show" when reads worked but the value never changed', () => {
    const m = chainWaitTimeoutMessage('protocol amneziawg', 180_000);
    expect(m).toContain('the chain does not show protocol amneziawg after 180s');
  });
});

// Same rule the runtimes enforce (node-runtime.ts NODE_ID_RE): every node home is a UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Q0169 regression: the by-address read home must be a UUID ───
// It was "chain-read"; LocalRuntime/RemoteRuntime refuse non-UUID homes, so every read of
// a node this app did not deploy threw before it reached the chain.
describe('READ_CTL_HOME_ID', () => {
  it('is a UUID the runtimes accept', () => {
    expect(READ_CTL_HOME_ID).toMatch(UUID);
  });
  it('is reserved, so the leftover-home reaper never deletes it', () => {
    expect(isReservedRuntimeHome(READ_CTL_HOME_ID)).toBe(true);
  });
  it('every reserved home is a distinct UUID', () => {
    for (const id of RESERVED_RUNTIME_HOME_IDS) expect(id).toMatch(UUID);
    expect(new Set(RESERVED_RUNTIME_HOME_IDS).size).toBe(RESERVED_RUNTIME_HOME_IDS.length);
  });
});

// ─── Q0407: a remote node's chain commands run on its own host ───
describe('chainCtlPlace', () => {
  it('remote node, host answers with its image → on the node host (no local Docker needed)', () => {
    expect(chainCtlPlace({ target: 'remote', hasCreds: true, remoteImage: 'ready' })).toBe('node-host');
  });
  it('remote node, host unreachable (IP changed) → this computer', () => {
    expect(chainCtlPlace({ target: 'remote', hasCreds: true, remoteImage: 'unreachable' })).toBe('this-computer');
  });
  it('remote node, host lost the image → this computer', () => {
    expect(chainCtlPlace({ target: 'remote', hasCreds: true, remoteImage: 'missing' })).toBe('this-computer');
  });
  it('remote node without SSH credentials (after an app restart) → this computer', () => {
    expect(chainCtlPlace({ target: 'remote', hasCreds: false, remoteImage: 'ready' })).toBe('this-computer');
  });
  it('local node → this computer', () => {
    expect(chainCtlPlace({ target: 'local', hasCreds: false, remoteImage: 'unreachable' })).toBe('this-computer');
    expect(chainCtlPlace({ target: 'local', hasCreds: true, remoteImage: 'ready' })).toBe('this-computer');
  });
});
