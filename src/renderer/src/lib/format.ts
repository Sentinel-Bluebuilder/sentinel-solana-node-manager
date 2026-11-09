/**
 * UI-side formatters. tDVPN is the Token-2022 mint on Solana devnet (6 decimals):
 * chain amounts are base units, the UI shows display units. `fmtDVPN` renders the
 * number only; call sites add the "tDVPN" label.
 */

export const fmtAmount = (n: number, digits = 2): string =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export const fmtDVPN = fmtAmount;

/**
 * An amount the user is about to send: below 0.01 it shows all 6 decimals, so 115 base
 * units reads "0.000115", not "0.00" on an enabled Withdraw button (FLX2, Q0410).
 */
export const fmtDVPNSend = (n: number): string => fmtAmount(n, n > 0 && n < 0.01 ? 6 : 2);

export const fmtBytes = (bytes: number, digits = 1): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / Math.pow(1024, i);
  return `${fmtAmount(n, i === 0 ? 0 : digits)} ${units[i]}`;
};

export const shortAddr = (addr: string | null | undefined, head = 8, tail = 6): string => {
  if (!addr) return '—';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
};

export const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};
