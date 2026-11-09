import { describe, expect, it } from 'vitest';
import {
  isValidMnemonic,
  isWalletAddress,
  keypairFromJson,
  keypairFromMnemonic,
  keypairToJson,
  newMnemonic,
  slip10Derive,
  slip10Master,
} from '../../src/main/services/keys';

describe('SLIP-0010 ed25519 (spec test vector 1)', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

  it('master key and chain code', () => {
    const m = slip10Master(seed);
    expect(m.key.toString('hex')).toBe('2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
    expect(m.chainCode.toString('hex')).toBe('90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
  });

  it("m/0'", () => {
    expect(slip10Derive(seed, "m/0'").toString('hex')).toBe('68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  });

  it('rejects non-hardened segments', () => {
    expect(() => slip10Derive(seed, 'm/0')).toThrow(/hardened/);
  });
});

describe('mnemonics and keypairs', () => {
  it('generates valid 24-word phrases', () => {
    const m = newMnemonic();
    expect(m.split(' ')).toHaveLength(24);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('derivation is deterministic and normalizes whitespace/case', () => {
    const m = newMnemonic();
    const a = keypairFromMnemonic(m).publicKey.toBase58();
    const b = keypairFromMnemonic(`  ${m.toUpperCase().replace(/ /g, '   ')} `).publicKey.toBase58();
    expect(a).toBe(b);
  });

  it('rejects an invalid phrase', () => {
    expect(isValidMnemonic('abandon abandon abandon')).toBe(false);
  });

  it('round-trips solana-keygen JSON', () => {
    const kp = keypairFromMnemonic(newMnemonic());
    const back = keypairFromJson(keypairToJson(kp));
    expect(back.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(JSON.parse(keypairToJson(kp))).toHaveLength(64);
  });

  it('rejects malformed key files', () => {
    expect(() => keypairFromJson('not json')).toThrow(/not valid JSON/);
    expect(() => keypairFromJson('[1,2,3]')).toThrow(/64 numbers/);
  });
});

describe('address validation', () => {
  it('accepts a wallet, rejects bech32 and PDAs', () => {
    expect(isWalletAddress('11111111111111111111111111111111')).toBe(true);
    expect(isWalletAddress('sent1lwzpjwcvaqmcre5hx63ez80uyzre49ukacc84u')).toBe(false);
    // User PDA of the wallet above — off-curve, not a wallet.
    expect(isWalletAddress('9ynMXMfC2CQgNCbG6bvkuB5MwrA73yYvUDDH1PfHt3Qn')).toBe(false);
  });
});
