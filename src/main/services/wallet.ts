import { BrowserWindow, app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Keypair,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  DECIMALS,
  MEMO_PROGRAM,
  MINT,
  baseToDisplay,
  displayToBase,
  lamportsToSol,
  solToLamports,
} from './chain';
import { connection, sendTx, withRetry, withRpcTimeout, RPC_QUERY_TIMEOUT_MS } from './solana-client';
import {
  isValidMnemonic,
  isWalletAddress,
  keypairFromJson,
  keypairFromMnemonic,
  newMnemonic,
  normalizeMnemonic,
} from './keys';
import { readStore, writeStore } from './store';
import { addEvent } from './events';
import { log } from './logger';
import { IPC, type SendTxRequest, type SendTxResult, type WalletState } from '../../shared/types';

function broadcastWallet(w: WalletState | null): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.WALLET_CHANGED, w);
}

/**
 * App-level Solana wallet.
 *
 *   • Secret — a 24-word BIP-39 phrase (derived at m/44'/501'/0'/0', Phantom
 *     compatible) OR an imported solana-keygen key file (64-byte JSON). The
 *     funded devnet test key has no phrase, so import is first-class.
 *   • At rest — Electron safeStorage (OS keychain). No encryption → refuse.
 *   • Balances — SOL (fees, rent) + tDVPN (Token-2022 ATA).
 *   • Sends — one transaction carrying a tDVPN transferChecked and/or a SOL
 *     transfer, priority fee + 429 backoff via solana-client.sendTx.
 */

const SECRET_FILE = 'wallet.secret';

type StoredSecret = { kind: 'mnemonic'; mnemonic: string } | { kind: 'keyfile'; secretKey: number[] };

function secretPath(): string {
  return path.join(app.getPath('userData'), SECRET_FILE);
}

async function requireEncryption(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'This computer cannot safely save your wallet key. ' +
        'On Linux, turn on a system keyring (such as gnome-keyring or kwallet) and try again. ' +
        'On Windows and macOS this normally works automatically — please make sure you are signed in to your user account.',
    );
  }
}

async function saveSecret(secret: StoredSecret): Promise<void> {
  await requireEncryption();
  const enc = safeStorage.encryptString(JSON.stringify(secret));
  await fs.mkdir(path.dirname(secretPath()), { recursive: true });
  await fs.writeFile(secretPath(), enc);
}

async function loadSecret(): Promise<StoredSecret> {
  // No wallet is the likelier cause: say so before any keyring message.
  if (!(await hasSecretFile())) throw new Error('No wallet yet. Create or import a wallet first.');
  await requireEncryption();
  const raw = safeStorage.decryptString(await fs.readFile(secretPath()));
  return JSON.parse(raw) as StoredSecret;
}

async function hasSecretFile(): Promise<boolean> {
  try {
    await fs.access(secretPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function keypairFromSecret(secret: StoredSecret): Keypair {
  return secret.kind === 'mnemonic'
    ? keypairFromMnemonic(secret.mnemonic)
    : keypairFromJson(JSON.stringify(secret.secretKey));
}

/** The app wallet's keypair (signs funding, sends, test-session channels). */
export async function appKeypair(): Promise<Keypair> {
  return keypairFromSecret(await loadSecret());
}

/** Fresh 24-word phrase + derived keypair for a new node (the node's owner key). */
export async function generateNodeKey(): Promise<{ mnemonic: string; address: string; keypair: Keypair }> {
  const mnemonic = newMnemonic();
  const keypair = keypairFromMnemonic(mnemonic);
  return { mnemonic, address: keypair.publicKey.toBase58(), keypair };
}

/** Rebuild a node's keypair from its backed-up phrase. */
export function signerFromMnemonic(mnemonic: string): Keypair {
  return keypairFromMnemonic(mnemonic);
}

export function tokenAccount(owner: PublicKey | string): PublicKey {
  const o = typeof owner === 'string' ? new PublicKey(owner) : owner;
  return getAssociatedTokenAddressSync(new PublicKey(MINT), o, false, TOKEN_2022_PROGRAM_ID);
}

// ─── Public API ───

export async function getWallet(): Promise<WalletState> {
  const store = await readStore();
  const hasKey = await hasSecretFile();
  if (store.wallet && hasKey) {
    return { ...store.wallet, hasMnemonic: true };
  }
  return { address: null, balanceDVPN: 0, balanceSOL: 0, createdAt: null, hasMnemonic: false };
}

export interface CreateWalletResult {
  wallet: WalletState;
  mnemonic: string;
}

export async function createWallet(): Promise<CreateWalletResult> {
  await requireEncryption();
  const mnemonic = newMnemonic();
  const wallet = await persist({ kind: 'mnemonic', mnemonic }, 'wallet-created');
  return { wallet, mnemonic };
}

export async function restoreWallet(phrase: string): Promise<WalletState> {
  const normalized = normalizeMnemonic(phrase);
  if (!isValidMnemonic(normalized)) {
    throw new Error(
      "That recovery phrase doesn't look right. Please enter the 12, 15, 18, 21, or 24 English words from your wallet backup, separated by single spaces.",
    );
  }
  return persist({ kind: 'mnemonic', mnemonic: normalized }, 'wallet-restored');
}

/**
 * Import a solana-keygen key file (64-byte JSON array) — e.g. the funded
 * devnet test wallet. `body` is the file's text, never a path, so the
 * renderer reads the file and the secret is encrypted before it touches disk.
 */
export async function importKeyFile(body: string): Promise<WalletState> {
  const kp = keypairFromJson(body.trim());
  return persist({ kind: 'keyfile', secretKey: Array.from(kp.secretKey) }, 'wallet-restored');
}

async function persist(secret: StoredSecret, kind: 'wallet-created' | 'wallet-restored'): Promise<WalletState> {
  await saveSecret(secret);
  const address = keypairFromSecret(secret).publicKey.toBase58();
  const wallet: WalletState = {
    address,
    balanceDVPN: 0,
    balanceSOL: 0,
    createdAt: new Date().toISOString(),
    hasMnemonic: true,
    secretKind: secret.kind,
  };
  const store = await readStore();
  store.wallet = wallet;
  await writeStore(store);
  broadcastWallet(wallet);
  await addEvent({
    kind,
    title: kind === 'wallet-created' ? 'Wallet created' : secret.kind === 'keyfile' ? 'Wallet imported from key file' : 'Wallet restored',
    subtitle: `${address.slice(0, 6)}…${address.slice(-6)}`,
  });
  refreshWalletBalance().catch((err) => log.debug('initial balance refresh skipped', { err: String(err) }));
  return wallet;
}

/**
 * Wipe the app wallet. Per-node keys (encrypted in store.nodeBackups) are
 * not touched. Running nodes keep running.
 */
export async function logoutWallet(): Promise<void> {
  try {
    await fs.unlink(secretPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const store = await readStore();
  store.wallet = null;
  await writeStore(store);
  broadcastWallet(null);
  await addEvent({ kind: 'wallet-logout', title: 'Wallet logged out', subtitle: 'Encrypted vault cleared' });
}

/** Refresh SOL + tDVPN for the app wallet. Silent on RPC failure. */
export async function refreshWalletBalance(): Promise<WalletState> {
  const store = await readStore();
  if (!store.wallet?.address) return getWallet();
  try {
    const b = await fetchBalances(store.wallet.address);
    store.wallet.balanceDVPN = b.dvpn;
    store.wallet.balanceSOL = b.sol;
    await writeStore(store);
    broadcastWallet(store.wallet);
  } catch (err) {
    log.warn('wallet balance refresh failed', { err: (err as Error).message });
  }
  return store.wallet;
}

export interface Balances {
  /** SOL (display). */
  sol: number;
  lamports: number;
  /** tDVPN (display). */
  dvpn: number;
  /** tDVPN base units. */
  dvpnBase: bigint;
  /** Whether the Token-2022 ATA exists. */
  hasTokenAccount: boolean;
}

export async function fetchBalances(address: string): Promise<Balances> {
  const conn = await connection();
  const owner = new PublicKey(address);
  const lamports = await withRetry(
    () => withRpcTimeout(() => conn.getBalance(owner, 'confirmed'), RPC_QUERY_TIMEOUT_MS, 'getBalance'),
    'getBalance',
  );
  const ata = tokenAccount(owner);
  const info = await withRetry(
    () => withRpcTimeout(() => conn.getAccountInfo(ata, 'confirmed'), RPC_QUERY_TIMEOUT_MS, 'getAccountInfo(ata)'),
    'getAccountInfo(ata)',
  );
  let dvpnBase = 0n;
  if (info) {
    const bal = await withRetry(
      () => withRpcTimeout(() => conn.getTokenAccountBalance(ata, 'confirmed'), RPC_QUERY_TIMEOUT_MS, 'getTokenAccountBalance'),
      'getTokenAccountBalance',
    );
    dvpnBase = BigInt(bal.value.amount);
  }
  return {
    sol: lamportsToSol(lamports),
    lamports,
    dvpn: baseToDisplay(dvpnBase),
    dvpnBase,
    hasTokenAccount: !!info,
  };
}

/**
 * Instructions moving tDVPN and/or SOL from `from` to `to`. Creates the
 * recipient's ATA idempotently (payer = sender) when tDVPN is moved.
 */
export function transferInstructions(
  from: PublicKey,
  to: PublicKey,
  amountBase: bigint,
  lamports: number,
  memo?: string,
): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (lamports > 0) {
    ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
  }
  if (amountBase > 0n) {
    const mint = new PublicKey(MINT);
    const dest = tokenAccount(to);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, dest, to, mint, TOKEN_2022_PROGRAM_ID));
    ixs.push(
      createTransferCheckedInstruction(tokenAccount(from), mint, dest, from, amountBase, DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    );
  }
  if (memo) ixs.push(memoInstruction(memo, from));
  return ixs;
}

export function memoInstruction(text: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM),
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  });
}

/** Send tDVPN and/or SOL from the app wallet. */
export async function sendTokens(req: SendTxRequest): Promise<SendTxResult> {
  const to = req.to.trim();
  if (!isWalletAddress(to)) {
    return { ok: false, error: `Recipient "${req.to}" is not a valid Solana wallet address.`, errorCode: 'invalid-address' };
  }
  const amountSOL = req.amountSOL ?? 0;
  if (!(req.amountDVPN >= 0) || !(amountSOL >= 0) || (req.amountDVPN === 0 && amountSOL === 0)) {
    return { ok: false, error: 'Amount must be greater than 0.', errorCode: 'invalid-amount' };
  }
  try {
    const signer = await appKeypair();
    return await sendFrom(signer, to, req.amountDVPN, amountSOL, req.memo);
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error';
    log.error('sendTokens failed', { err: msg });
    await addEvent({ kind: 'withdraw-failed', title: 'Send failed', subtitle: sanitizeErr(msg), amountDVPN: -req.amountDVPN });
    return { ok: false, error: sanitizeErr(msg), errorCode: classifyErr(msg) };
  }
}

/** Shared send path for the app wallet and node keys (withdraw / sweep). */
export async function sendFrom(
  signer: Keypair,
  to: string,
  amountDVPN: number,
  amountSOL: number,
  memo?: string,
  event: { title: string; subtitle?: string; amountDVPN?: number; relatedNodeId?: string } = { title: 'Send confirmed' },
): Promise<SendTxResult> {
  const ixs = transferInstructions(
    signer.publicKey,
    new PublicKey(to),
    displayToBase(amountDVPN),
    solToLamports(amountSOL),
    memo,
  );
  const res = await sendTx(ixs, signer, [], 'transfer');
  await addEvent({
    kind: 'withdraw-sent',
    title: event.title,
    subtitle: event.subtitle ?? `to ${to.slice(0, 6)}…${to.slice(-6)}`,
    amountDVPN: event.amountDVPN ?? -amountDVPN,
    relatedNodeId: event.relatedNodeId,
    txHash: res.signature,
  });
  refreshWalletBalance().catch((err) => log.debug('post-send refresh skipped', { err: String(err) }));
  return { ok: true, txHash: res.signature, height: res.slot, gasUsed: res.feeLamports };
}

export function classifyErr(raw: string): SendTxResult['errorCode'] {
  if (/insufficient (funds|lamports)|0x1\b|custom program error: 0x1"?\b|Attempt to debit an account but found no record/i.test(raw)) return 'insufficient-funds';
  if (/invalid (address|public key)|Invalid public key|WrongSize/i.test(raw)) return 'invalid-address';
  if (/timed out|TransactionExpired|block height exceeded|Blockhash not found/i.test(raw)) return 'timeout';
  if (/429|ECONNREFUSED|ETIMEDOUT|fetch failed|Could not connect/i.test(raw)) return 'rpc-unavailable';
  if (/not devnet|genesis/i.test(raw)) return 'chain-mismatch';
  if (/custom program error|Error Number|AnchorError/i.test(raw)) return 'program-error';
  if (/simulat/i.test(raw)) return 'gas-estimation-failed';
  return 'unknown';
}

export function sanitizeErr(msg: string | undefined): string {
  if (!msg) return 'Unknown error';
  return msg.replace(/https?:\/\/\S+/g, '[rpc]').slice(0, 300);
}
