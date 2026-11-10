import { describe, expect, it } from 'vitest';
import { buildFailureSummary, httpRpcHostAllowed, isPublicIPv4, localSudoMissingError, privilegedFallbackApplies, rpcHostOf, rpcIsLocalOnly } from '../../src/main/services/validate';

/**
 * FINAL check 2026-11-08 on a Linux test host: a local deploy failed with "EACCES: permission denied,
 * scandir …/nodes/<id>/amneziawg". The node container runs as root, so with rootful Docker on
 * Linux the node home fills with root-owned files, and plain fs calls from a non-root app fail.
 * Local mode now retries exactly those failures through `sudo -n`, as remote mode does.
 */
describe('local node home: when to retry through sudo', () => {
  it('retries a permission error on Linux when the app is not root', () => {
    expect(privilegedFallbackApplies({ code: 'EACCES' }, 'linux', 1000)).toBe(true);
    expect(privilegedFallbackApplies({ code: 'EPERM' }, 'linux', 1000)).toBe(true);
  });

  it('never retries as root, off Linux, or for other errors', () => {
    expect(privilegedFallbackApplies({ code: 'EACCES' }, 'linux', 0)).toBe(false);
    expect(privilegedFallbackApplies({ code: 'EACCES' }, 'win32', undefined)).toBe(false);
    expect(privilegedFallbackApplies({ code: 'EACCES' }, 'darwin', 501)).toBe(false);
    expect(privilegedFallbackApplies({ code: 'ENOENT' }, 'linux', 1000)).toBe(false);
    expect(privilegedFallbackApplies(undefined, 'linux', 1000)).toBe(false);
  });

  it('tells the user in one line how to fix a missing sudo', () => {
    const msg = localSudoMissingError('alice');
    expect(msg).not.toContain('\n');
    expect(msg).toContain('NOPASSWD: /usr/bin/cat, /usr/bin/install, /usr/bin/rm');
    expect(msg).toContain('rootless Docker');
  });
});

/** The fleet's RPC gate lives on a VPC address (10.0.0.5); plain http stays banned for public hosts. */
describe('plain http RPC hosts', () => {
  it('allows loopback and private IPv4 ranges', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.10']) {
      expect(httpRpcHostAllowed(h)).toBe(true);
    }
  });

  it('refuses public addresses, edge ranges and hostnames', () => {
    for (const h of ['9.9.9.9', '172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8', 'devnet.helius-rpc.com', 'gate.internal', '10.0.0.256']) {
      expect(httpRpcHostAllowed(h)).toBe(false);
    }
  });
});

/** The final client refuses non-public node addresses, so a local deploy publishes the public IP. */
describe('public IPv4', () => {
  it('accepts internet-routable addresses', () => {
    for (const ip of ['9.9.9.9', '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1']) expect(isPublicIPv4(ip)).toBe(true);
  });

  it('refuses private, shared, link-local, test and reserved ranges', () => {
    for (const ip of ['10.0.0.5', '192.168.1.5', '172.20.0.1', '127.0.0.1', '100.64.1.1', '169.254.1.1', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1', '0.0.0.0', '224.0.0.1', '300.1.1.1', 'node.example.com']) {
      expect(isPublicIPv4(ip)).toBe(false);
    }
  });
});

/** A node or client on a VPS cannot reach this machine's loopback or VPC gateway (FINAL check 2026-11-08). */
describe('RPC reachable from a remote host', () => {
  it('flags loopback and private-network RPC URLs as local-only', () => {
    for (const u of ['http://127.0.0.1:8899/c/tok', 'http://10.0.0.5:8899/c/tok', 'https://192.168.1.2', 'http://localhost:8899']) expect(rpcIsLocalOnly(u)).toBe(true);
    for (const u of ['https://api.devnet.solana.com', 'https://devnet.helius-rpc.com/?api-key=x', 'https://9.9.9.9:8899']) expect(rpcIsLocalOnly(u)).toBe(false);
  });

  it('messages show the host only, never a token or key', () => {
    expect(rpcHostOf('http://10.0.0.5:8899/c/secret-token')).toBe('10.0.0.5:8899');
    expect(rpcHostOf('https://devnet.helius-rpc.com/?api-key=secret')).toBe('devnet.helius-rpc.com');
  });
});

/** A failed remote build must show the failing step's output, not the Dockerfile echo. */
describe('docker build failure summary', () => {
  it('keeps the failing step output and the solve error', () => {
    const log = ['#11 [5/9] RUN set -eux; curl ...', '#11 0.31 + curl -fsSL -o /tmp/xray.zip https://github.com/x', '#11 1.02 curl: (22) The requested URL returned error: 403', '#11 ERROR: process "/bin/sh -c set -eux" did not complete successfully: exit code: 22', '------', ' > [5/9] RUN set -eux; ...', '  63 |     chmod +x /usr/local/bin/xray;','  64 | >>>     rm /tmp/xray.zip', 'ERROR: failed to build: failed to solve: process "/bin/sh -c set -eux" did not complete'].join('\n');
    const s = buildFailureSummary(log);
    expect(s).toContain('curl: (22) The requested URL returned error: 403');
    expect(s).toContain('ERROR: failed to build');
    expect(s).not.toContain('>>>     rm /tmp/xray.zip');
  });

  it('falls back to the tail when there is no step error', () => {
    expect(buildFailureSummary('a\nb\nno space left on device')).toBe('a\nb\nno space left on device');
  });
});
