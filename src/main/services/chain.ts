/**
 * Sentinel dVPN on Solana — devnet constants + small helpers.
 *
 * The dvpn program and the tDVPN mint (Token-2022, 6 decimals) are fixed for
 * the devnet build of the node image (`docker/dvpnd.Dockerfile` link-time
 * ldflags). The app never re-implements the program: instructions go through
 * `dvpnctl` inside the image (see dvpnctl.ts). These constants exist for the
 * parts the app does natively — balances, transfers, PDAs, explorer links.
 */

export const CLUSTER = 'devnet' as const;
export const PROGRAM_ID = 'J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs';
export const MINT = 'Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** Solana devnet genesis hash — the chain-identity check (replaces Cosmos chain-id). */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export const DISPLAY = 'tDVPN';
export const DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Bond the program requires per node (`minNodeBond` = 1 tDVPN). */
export const NODE_BOND_BASE = 1_000_000;

export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 0;

/**
 * Public devnet RPC. Every sentinel-solana devnet suite passed on it; it 429s
 * under bursts, so every call site retries with backoff (solana-client.ts).
 * Settings can add dedicated endpoints in front of it.
 */
export const DEFAULT_RPC_POOL: readonly string[] = ['https://api.devnet.solana.com'];

// ─── Protocols ───

export type ServiceType = 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'openvpn' | 'hysteria2';

export interface ProtocolInfo {
  type: ServiceType;
  label: string;
  /**
   * On-chain protocol bit: each driver's `protocolBit` in sentinel-go-sdk (cb33 / public
   * 26de5240: wireguard 1<<0, v2ray 1<<1, openvpn 1<<2, amneziawg 1<<3, xray 1<<4,
   * hysteria2 1<<5). The daemon writes its own value at start-up, and protocol switches
   * wait for it, so this must match the daemon's build.
   */
  bit: number;
  /** One-line description for the picker. */
  blurb: string;
  /**
   * How the public listener(s) are declared in `<home>/node/<type>/config.toml`:
   * `listen_port` → a single top-level key; `inbounds` → each `[[inbounds]] port`.
   */
  portLayout: 'listen_port' | 'inbounds';
}

export const PROTOCOLS: readonly ProtocolInfo[] = [
  { type: 'wireguard', label: 'WireGuard', bit: 1, portLayout: 'listen_port', blurb: 'Fast kernel VPN over UDP. The default choice.' },
  { type: 'amneziawg', label: 'AmneziaWG', bit: 8, portLayout: 'listen_port', blurb: 'WireGuard with obfuscated handshakes, harder for censors to fingerprint.' },
  { type: 'v2ray', label: 'V2Ray', bit: 2, portLayout: 'inbounds', blurb: 'Proxy over TCP / WebSocket / gRPC. Looks like ordinary web traffic.' },
  { type: 'xray', label: 'Xray', bit: 16, portLayout: 'inbounds', blurb: 'Faster V2Ray fork (VLESS / VMess / Trojan over TCP, WS, gRPC).' },
  { type: 'openvpn', label: 'OpenVPN', bit: 4, portLayout: 'listen_port', blurb: 'The classic VPN, supported by almost every device.' },
  { type: 'hysteria2', label: 'Hysteria2', bit: 32, portLayout: 'listen_port', blurb: 'QUIC-based, built for lossy and long-distance links.' },
];

export function protocolInfo(type: string): ProtocolInfo {
  const p = PROTOCOLS.find((x) => x.type === type);
  if (!p) throw new Error(`Unknown protocol "${type}". Expected one of: ${PROTOCOLS.map((x) => x.type).join(', ')}.`);
  return p;
}

export function protocolFromBits(bits: number): ProtocolInfo | undefined {
  return PROTOCOLS.find((p) => (bits & p.bit) !== 0);
}

/** Ports per node: api + up to 3 public service listeners (Xray renders 3 inbounds) + spare. */
export const PORT_BLOCK_SIZE = 5;

// ─── Units ───

export const baseToDisplay = (u: string | number | bigint): number => Number(u) / 10 ** DECIMALS;

export const displayToBase = (d: number): bigint => BigInt(Math.round(d * 10 ** DECIMALS));

export const lamportsToSol = (l: number | bigint): number => Number(l) / LAMPORTS_PER_SOL;

export const solToLamports = (s: number): number => Math.round(s * LAMPORTS_PER_SOL);

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}

export function explorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=${CLUSTER}`;
}
