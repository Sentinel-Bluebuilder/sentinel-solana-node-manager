import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0.0.0' } }));
const { liveSessions } = await import('../../src/main/services/dvpnctl');

// ─── NM-C9 T9 (f): the daemon keeps ended sessions with status "closed" ───
// The paid self-test's session closed 7 s after it opened but stayed under Live sessions for an
// hour, and counted in the node's session total.

describe('liveSessions', () => {
  it('drops sessions the daemon reports as closed, any case', () => {
    const all = [
      { id: 'a', status: 'active' },
      { id: 'b', status: 'closed' },
      { id: 'c', status: 'CLOSED' },
      { id: 'd' },
    ];
    expect(liveSessions(all).map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('the real self-test record from NM-C9 is not live', () => {
    const rec = {
      id: 'c8d4c9e4-208b-43ef-bd5a-9a91bb085f4c',
      credential: 'channel',
      usage: { rx_bytes: 22228, tx_bytes: 1094316, seconds: 5 },
      status: 'closed',
      created_at: 1794483417,
      updated_at: 1794483424,
    };
    expect(liveSessions([rec])).toEqual([]);
  });
});
