import { describe, expect, it } from 'vitest';
import { maxSendableSol, solReserveLamports } from '../../src/shared/sol-reserve';

// Fix C (0.3.1): "Max" must leave the fee, the wallet's rent-exempt minimum and,
// when tDVPN goes along, the recipient token account rent.

describe('solReserveLamports', () => {
  it('keeps fee + own rent for a SOL-only send', () => {
    expect(solReserveLamports(false)).toBe(10_000 + 890_880);
  });
  it('adds the recipient token account rent when tDVPN is sent', () => {
    expect(solReserveLamports(true)).toBe(10_000 + 890_880 + 2_039_280);
  });
});

describe('maxSendableSol', () => {
  it('leaves exactly the reserve (rounded down to 6 decimals)', () => {
    expect(maxSendableSol(1, false)).toBe(0.999099);
    expect(maxSendableSol(1, true)).toBe(0.997059);
  });
  it('is 0, never negative, when the balance is below the reserve', () => {
    expect(maxSendableSol(0.0005, false)).toBe(0);
    expect(maxSendableSol(0.002, true)).toBe(0);
  });
  it('never exceeds balance minus reserve', () => {
    for (const b of [0.0123456789, 0.5, 2.000000001, 13.37]) {
      const m = maxSendableSol(b, true);
      expect(Math.round(m * 1e9) + solReserveLamports(true)).toBeLessThanOrEqual(Math.floor(b * 1e9));
    }
  });
});
