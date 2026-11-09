import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boolFlag,
  checkArgs,
  numberFlag,
  optionalFlag,
  parseArgs,
  readArgFile,
  requireFlag,
  tokenize,
  type CliArgSpec,
} from '../../src/main/services/cli-args';

describe('tokenize', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenize(`a  b\t"c d" 'e f'`)).toEqual(['a', 'b', 'c d', 'e f']);
  });
  it('keeps an empty quoted string as a token', () => {
    expect(tokenize(`x "" y`)).toEqual(['x', '', 'y']);
  });
  it('backslash escapes inside double quotes only', () => {
    expect(tokenize(String.raw`"a\"b" 'c\d'`)).toEqual(['a"b', String.raw`c\d`]);
  });
  it('keeps JSON with = and spaces intact', () => {
    expect(tokenize(`settings.set --json '{"rpcUrls":["https://x/?api-key=1"]}'`)).toEqual([
      'settings.set',
      '--json',
      '{"rpcUrls":["https://x/?api-key=1"]}',
    ]);
  });
  it('rejects an unterminated quote', () => {
    expect(() => tokenize(`a "b`)).toThrow(/Unterminated/);
  });
  it('passes unicode through', () => {
    expect(tokenize('wallet.send --memo "héllo — 世界"')).toEqual(['wallet.send', '--memo', 'héllo — 世界']);
  });
});

describe('parseArgs', () => {
  it('separates flags and positionals', () => {
    // Without a bool declaration, `--force id2` reads id2 as the value (checkArgs/boolFlag then reject it).
    const p = parseArgs(['id1', '--window', '1h', '--force', 'id2']);
    expect(p).toEqual({ positional: ['id1'], flags: { window: '1h', force: 'id2' } });
  });
  it('bool flags never consume the next token', () => {
    const p = parseArgs(['--force', 'id', '--dry-run'], new Set(['force', 'dry-run']));
    expect(p).toEqual({ positional: ['id'], flags: { force: true, 'dry-run': true } });
  });
  it('--flag=value keeps = inside the value', () => {
    expect(parseArgs(['--url=https://h/?a=1&b=2']).flags.url).toBe('https://h/?a=1&b=2');
  });
  it('a value starting with -- is not consumed (and -- alone is positional)', () => {
    expect(parseArgs(['--memo', '--to', 'x'])).toEqual({ positional: [], flags: { memo: true, to: 'x' } });
    expect(parseArgs(['--memo=--literal']).flags.memo).toBe('--literal');
    expect(parseArgs(['--']).positional).toEqual(['--']);
  });
  it('negative numbers are values', () => {
    expect(parseArgs(['--amount', '-1']).flags.amount).toBe('-1');
  });
  it('empty-string values survive', () => {
    expect(parseArgs(['--memo', '']).flags.memo).toBe('');
  });
});

describe('checkArgs', () => {
  const args: CliArgSpec[] = [
    { name: 'nodeId', kind: 'positional', required: true, describe: '' },
    { name: 'format', kind: 'flag', required: true, describe: '' },
    { name: 'dry-run', kind: 'bool', describe: '' },
  ];
  it('rejects an undeclared flag naming the allowed ones', () => {
    expect(() => checkArgs('x.y', 'x.y <id>', args, parseArgs(['id', '--dryrun']))).toThrow(/Unknown flag --dryrun for x\.y\. Allowed: --format, --dry-run/);
  });
  it('rejects surplus positionals', () => {
    // The surplus values are never echoed (they could be the words of an unquoted mnemonic).
    expect(() => checkArgs('x.y', 'u', args, parseArgs(['a', 'b']))).toThrow(/Too many arguments for x\.y \(1 unexpected/);
    expect(() => checkArgs('x.y', 'u', args, parseArgs(['a', 'b']))).not.toThrow(/\bb\b.*Usage/);
  });
  it('accepts a well-formed line', () => {
    expect(() => checkArgs('x.y', 'u', args, parseArgs(['a', '--format', 'txt', '--dry-run'], new Set(['dry-run'])))).not.toThrow();
  });
});

describe('flag accessors', () => {
  it('requireFlag / optionalFlag reject a bare flag where a value is needed', () => {
    const p = parseArgs(['--to']);
    expect(() => requireFlag(p, 'to')).toThrow(/requires a non-empty value/);
    expect(() => optionalFlag(p, 'to')).toThrow(/requires a value/);
    expect(optionalFlag(parseArgs([]), 'to')).toBeUndefined();
  });
  it('numberFlag parses numbers and rejects junk', () => {
    expect(numberFlag(parseArgs(['--amount', '1.5']), 'amount')).toBe(1.5);
    expect(numberFlag(parseArgs(['--amount', '-1']), 'amount')).toBe(-1);
    expect(() => numberFlag(parseArgs(['--amount', 'x']), 'amount')).toThrow(/must be a number/);
    expect(() => numberFlag(parseArgs(['--amount']), 'amount')).toThrow(/numeric value/);
    expect(() => numberFlag(parseArgs([]), 'amount', true)).toThrow(/Missing required/);
  });
  it('boolFlag accepts bare, true/false words, rejects other values', () => {
    expect(boolFlag(parseArgs(['--force'], new Set(['force'])), 'force')).toBe(true);
    expect(boolFlag(parseArgs(['--force=false']), 'force')).toBe(false);
    expect(boolFlag(parseArgs([]), 'force')).toBe(false);
    expect(() => boolFlag(parseArgs(['--force=maybe']), 'force')).toThrow(/takes no value/);
  });
});

describe('readArgFile (NM12)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm12-'));
  const file = path.join(dir, 'key.pem');
  fs.writeFileSync(file, 'KEY-CONTENT');

  it('returns the file contents (control)', async () => {
    await expect(readArgFile('key-file', file)).resolves.toBe('KEY-CONTENT');
  });
  it('a missing file names the flag and path in plain words, not ENOENT', async () => {
    const missing = path.join(dir, 'nope');
    await expect(readArgFile('key-file', missing)).rejects.toThrow(`No file at "${missing}" (--key-file). Check the path.`);
    await expect(readArgFile('key-file', missing)).rejects.not.toThrow(/ENOENT|no such file/);
  });
  it('a folder is named as a folder', async () => {
    await expect(readArgFile('ssh-key-file', dir)).rejects.toThrow(`"${dir}" is a folder, not a file (--ssh-key-file).`);
  });
});
