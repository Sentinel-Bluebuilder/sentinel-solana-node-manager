import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/snm-test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { scrubSecrets } = await import('../../src/main/services/cli-server');
const { tokenize, requireFlag, parseArgs } = await import('../../src/main/services/cli-args');

describe('scrubSecrets (what watchers and the in-app stream may see)', () => {
  it('redacts quoted and unquoted secret flag values', () => {
    expect(scrubSecrets('wallet.restore --mnemonic "abandon abandon zoo"')).toBe('wallet.restore --mnemonic ***');
    expect(scrubSecrets('ssh.test --host h --password=pa55')).toBe('ssh.test --host h --password=***');
  });
  it('redacts flag-name variants (--ssh-password, --mnemonics, --Private_Key)', () => {
    expect(scrubSecrets('deploy.start --ssh-password "x y"')).toBe('deploy.start --ssh-password ***');
    expect(scrubSecrets('wallet.restore --mnemonics "w1 w2 w3"')).toBe('wallet.restore --mnemonics ***');
    expect(scrubSecrets('x --Private_Key abc')).toBe('x --Private_Key ***');
  });
  it('redacts JSON secret values including escaped quotes', () => {
    expect(scrubSecrets('--ssh \'{"host":"h","password":"pa\\"ss","privateKey":"-----BEGIN"}\'')).toBe(
      '--ssh \'{"host":"h","password":"***","privateKey":"***"}\'',
    );
  });
  it('drops RPC URL query strings (provider API keys)', () => {
    expect(scrubSecrets('settings.set --json \'{"rpcUrls":["https://devnet.helius-rpc.com/?api-key=SECRET","https://api.devnet.solana.com"]}\'')).toBe(
      'settings.set --json \'{"rpcUrls":["https://devnet.helius-rpc.com/?***","https://api.devnet.solana.com"]}\'',
    );
  });
  it('leaves ordinary text alone', () => {
    expect(scrubSecrets('nodes.list')).toBe('nodes.list');
    expect(scrubSecrets('{"address":"9enW","balanceDVPN":1}')).toBe('{"address":"9enW","balanceDVPN":1}');
  });
});

describe('tokenize keeps Windows paths intact inside double quotes', () => {
  it('only \\" and \\\\ are escapes', () => {
    expect(tokenize(String.raw`wallet.importKey --file "C:\path\me\key.json"`)).toEqual(['wallet.importKey', '--file', String.raw`C:\path\me\key.json`]);
    expect(tokenize(String.raw`--memo "say \"hi\" \\ done"`)).toEqual(['--memo', String.raw`say "hi" \ done`]);
  });
});

describe('requireFlag rejects empty values (--flag=)', () => {
  it('throws on an empty required value', () => {
    expect(() => requireFlag(parseArgs(['--moniker=']), 'moniker')).toThrow(/non-empty/);
  });
});
