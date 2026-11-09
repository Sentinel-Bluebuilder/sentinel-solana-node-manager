import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/snm-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { stripToHost } = await import('../../src/main/services/deploy');

describe('stripToHost', () => {
  it('passes through bare IPv4', () => {
    expect(stripToHost('203.0.113.20')).toBe('203.0.113.20');
  });
  it('strips scheme', () => {
    expect(stripToHost('http://203.0.113.20')).toBe('203.0.113.20');
    expect(stripToHost('https://example.com')).toBe('example.com');
  });
  it('strips scheme + port + trailing slash', () => {
    expect(stripToHost('http://203.0.113.20:7777/')).toBe('203.0.113.20');
  });
  it('strips plain host:port', () => {
    expect(stripToHost('node.example.com:7777')).toBe('node.example.com');
  });
  it('unwraps bracketed IPv6 with port', () => {
    expect(stripToHost('[2001:db8::1]:7777')).toBe('2001:db8::1');
  });
  it('tolerates leading/trailing whitespace', () => {
    expect(stripToHost('  example.com:7777 ')).toBe('example.com');
  });
  it('returns empty for empty input', () => {
    expect(stripToHost('')).toBe('');
  });
});

describe('shellQuote (remote command lines)', () => {
  it('round-trips through a real POSIX shell byte for byte', async () => {
    const { shellQuote } = await import('../../src/main/services/ssh');
    const { execFileSync } = await import('node:child_process');
    const script = `while ! grep -q '"message":"ready"' f; do x=$1; echo \`a\` "b" \n; done`;
    const line = shellQuote(['printf', '%s', script]);
    expect(line).not.toContain('\\!'); // the shell-quote bug: `!` escaped as `\!`
    const out = execFileSync('sh', ['-c', line]).toString();
    expect(out).toBe(script);
  });
});
