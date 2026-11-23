import { describe, expect, it } from 'vitest';
import { classifySshFailure, wrongLoginMessage } from '../../src/main/services/ssh-failure';

// ─── v0.3.3: a refused login reads as plain words, not the SSH library's text ───
describe('wrongLoginMessage', () => {
  it('a refused password or key says so in plain words', () => {
    const raw = 'All configured authentication methods failed';
    expect(classifySshFailure(raw)).toBe('wrong-login');
    expect(wrongLoginMessage(raw)).toMatch(/did not accept this username/);
    expect(wrongLoginMessage(raw)).not.toMatch(/configured authentication/);
  });

  it('a wrong passphrase and an unreadable key file get their own wording', () => {
    expect(wrongLoginMessage('Encrypted private OpenSSH key detected, but bad passphrase')).toMatch(/passphrase/);
    expect(wrongLoginMessage('Cannot parse privateKey: Unsupported key format')).toMatch(/not the \.pub file/);
  });
});
