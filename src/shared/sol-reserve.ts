// ─── SOL the app wallet must keep when it sends (fix C, 0.3.1) ───
//
// A send that leaves less than this fails on chain or leaves the wallet unable to pay:
//  - the transaction fee (5000 lamports per signature; 10 000 kept for a priority fee),
//  - the wallet's own rent-exempt minimum (a system account with no data: 890 880 lamports;
//    a balance between 0 and that minimum is rejected by the runtime),
//  - when tDVPN is sent: the recipient's token account may not exist yet, and creating
//    it costs 2 039 280 lamports of rent, paid by the sender.

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const FEE_RESERVE_LAMPORTS = 10_000;
export const ACCOUNT_RENT_LAMPORTS = 890_880;
export const ATA_RENT_LAMPORTS = 2_039_280;

/** Lamports the wallet must still hold after the transfer. */
export function solReserveLamports(sendingToken: boolean): number {
  return FEE_RESERVE_LAMPORTS + ACCOUNT_RENT_LAMPORTS + (sendingToken ? ATA_RENT_LAMPORTS : 0);
}

/** Largest SOL amount the "Max" button may fill in (never negative), rounded down to 6 decimals. */
export function maxSendableSol(balanceSol: number, sendingToken: boolean): number {
  const lamports = Math.floor(balanceSol * LAMPORTS_PER_SOL) - solReserveLamports(sendingToken);
  return lamports <= 0 ? 0 : Math.floor(lamports / 1_000) / 1_000_000;
}
