import { safeStorage } from 'electron';
import type { Keypair } from '@solana/web3.js';
import { keypairFromJson } from './keys';
import { signerFromMnemonic } from './wallet';

/**
 * The encrypted node-key backup in `store.nodeBackups[nodeId]` comes in two forms:
 *  - a recovery phrase (every node deployed by this app): base64 safeStorage blob of the phrase;
 *  - a key file (NM032: a node recovered from its server, where only `ctl/keys/owner.json`
 *    exists): `kp1:` + base64 safeStorage blob of that 64-byte JSON key.
 * Both sign the same way; only the phrase can be shown or exported as words.
 */

export const KEYPAIR_BACKUP_PREFIX = 'kp1:';

export type DecodedBackup = { kind: 'mnemonic'; mnemonic: string } | { kind: 'keypair'; keyJson: string };

export function encodeKeypairBackup(keyJson: string): string {
  return KEYPAIR_BACKUP_PREFIX + safeStorage.encryptString(keyJson).toString('base64');
}

export function isKeypairBackup(blob: string): boolean {
  return blob.startsWith(KEYPAIR_BACKUP_PREFIX);
}

export function decodeBackup(blob: string): DecodedBackup {
  if (isKeypairBackup(blob)) {
    return { kind: 'keypair', keyJson: safeStorage.decryptString(Buffer.from(blob.slice(KEYPAIR_BACKUP_PREFIX.length), 'base64')) };
  }
  return { kind: 'mnemonic', mnemonic: safeStorage.decryptString(Buffer.from(blob, 'base64')) };
}

export function keypairFromBackup(blob: string): Keypair {
  const d = decodeBackup(blob);
  return d.kind === 'keypair' ? keypairFromJson(d.keyJson) : signerFromMnemonic(d.mnemonic);
}

/** What to tell a user who asks for the words of a node recovered from its server. */
export function noPhraseMessage(nodeId: string): string {
  return (
    'This node was recovered from its server, so the app holds its key file, not a recovery phrase. ' +
    `The same key is on the server at ~/.dvpnd-nodes/${nodeId}/ctl/keys/owner.json.`
  );
}
