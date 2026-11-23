// ─── SSH failure classes ───
// Shared by Reconnect (adopt.ts, per-server outcome) and the status poll (node-manager.ts, Q0598).
// Its own module so node-manager can use it without importing adopt.ts, which imports node-manager.
import type { RecoveryHostOutcome } from '../../shared/types';

export function classifySshFailure(message: string): RecoveryHostOutcome {
  if (/All configured authentication methods failed|authentication|permission denied|bad passphrase|Cannot parse privateKey/i.test(message)) return 'wrong-login';
  if (/Host denied|host key|verification failed|fingerprint/i.test(message)) return 'host-key-changed';
  if (/does not answer over SSH|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Timed out|ECONNRESET/i.test(message)) return 'not-answering';
  return 'error';
}

/**
 * Q0598: whether a failed host probe proves the node cannot be serving. Only a server node whose
 * server does not answer at all: a wrong login, a changed host key or a missing login say nothing
 * about the node, which may well be running.
 */
export function hostProbeMeansDown(target: 'local' | 'remote', message: string): boolean {
  return target === 'remote' && classifySshFailure(message) === 'not-answering';
}
