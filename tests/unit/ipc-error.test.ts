import { describe, expect, it } from 'vitest';
import { cleanIpcError } from '../../src/shared/ipc-error';

// ─── v0.3.3: errors shown to the user carry no Electron IPC prefix ───
describe('cleanIpcError', () => {
  it('strips the channel prefix and the inner Error: label', () => {
    const e = cleanIpcError(new Error("Error invoking remote method 'nodes:adopt-host': Error: Passwordless sudo is required."));
    expect((e as Error).message).toBe('Passwordless sudo is required.');
  });

  it('strips a typed inner error label too', () => {
    const e = cleanIpcError(new Error("Error invoking remote method 'wallet:create': TypeError: bad input"));
    expect((e as Error).message).toBe('bad input');
  });

  it('control: an ordinary message is returned untouched (same object)', () => {
    const orig = new Error('Wrong login');
    expect(cleanIpcError(orig)).toBe(orig);
    expect(cleanIpcError('text')).toBe('text');
  });
});
