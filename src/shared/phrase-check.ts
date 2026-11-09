// ─── Recovery-phrase backup check (Q0297, same design as #31 devnet-dvpn 7e10067) ───
// Browser-safe: the wallet-setup reveal card imports this. After "I have stored it" + Continue the
// person types a few words back by position; a wrong or missing word keeps them on the card, so an
// unsaved or mis-copied phrase is caught while the phrase can still be shown.

export const PHRASE_CHECK_COUNT = 3;

/** `count` distinct 0-based word positions out of `words`, in ascending order. `rand` returns [0, 1). */
export function pickCheckPositions(words: number, count = PHRASE_CHECK_COUNT, rand: () => number = Math.random): number[] {
  const n = Math.max(0, Math.min(count, words));
  const pool = Array.from({ length: words }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).sort((a, b) => a - b);
}

/** Positions (0-based) whose typed word does not match the phrase. Case and surrounding spaces are ignored. */
export function wrongPhraseWords(phrase: string, positions: number[], answers: string[]): number[] {
  const words = phrase.trim().split(/\s+/);
  return positions.filter((p, i) => {
    const typed = (answers[i] ?? '').trim().toLowerCase();
    return !typed || typed !== (words[p] ?? '').toLowerCase();
  });
}
