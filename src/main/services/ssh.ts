import { Client, type ConnectConfig } from 'ssh2';
import crypto from 'node:crypto';
import type { SSHCredentials, SSHTestResult } from '../../shared/types';
import { log } from './logger';
import { rememberHostKey, knownHostKey } from './host-keys';
import { SSH_CONNECT_ATTEMPTS, sshConnectError, sshConnectRetryable } from './validate';

/**
 * SSH helpers used by the remote deploy pipeline and remote node control.
 *
 *   • testSSHConnection — opens a handshake and runs `uname`.
 *   • runRemote — executes a command, streaming chunks back through onData.
 *   • uploadFile — transfers a string via SFTP instead of shell here-doc, so
 *     config payloads with special chars can't be reinterpreted by the shell.
 *   • shellQuote — safe assembler for commands that mix fixed words + user
 *     values; we strictly use this instead of string interpolation.
 */

export async function testSSHConnection(creds: SSHCredentials): Promise<SSHTestResult> {
  const start = Date.now();
  const expected = await knownHostKey(creds.host, creds.port || 22);
  const config = buildConnectConfig(creds, expected);

  return new Promise<SSHTestResult>((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (result: SSHTestResult) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch (err) {
        log.debug('ssh test client end failed', { err: (err as Error).message });
      }
      resolve(result);
    };

    client.on('ready', () => {
      client.exec('uname -a || ver', (err, stream) => {
        if (err) {
          finish({ ok: false, message: `Connected, but exec failed: ${err.message}` });
          return;
        }
        let buf = '';
        stream
          .on('close', () =>
            finish({
              ok: true,
              message: 'Connection successful',
              osInfo: buf.trim() || 'unknown',
              latencyMs: Date.now() - start,
            }),
          )
          .on('data', (c: Buffer) => (buf += c.toString('utf8')))
          .stderr.on('data', (c: Buffer) => (buf += c.toString('utf8')));
      });
    });

    client.on('error', (err) => finish({ ok: false, message: sshConnectError(creds.host, creds.port || 22, err).message }));

    try {
      client.connect(config);
    } catch (err) {
      finish({ ok: false, message: (err as Error).message });
    }
  });
}

/**
 * Modern algorithm allowlist. ssh2's defaults still include legacy KEX
 * (e.g. `diffie-hellman-group1-sha1`) and ciphers (`3des-cbc`); we forbid
 * those so a malicious or misconfigured server can't downgrade us. These
 * sets cover every server OpenSSH ≥ 7.x supports.
 *
 * `chacha20-poly1305@openssh.com` is intentionally omitted: Electron's
 * BoringSSL does not expose the `chacha20` cipher under the name
 * `crypto.getCiphers()` returns, so ssh2 filters it out of its supported
 * list. Asking for it explicitly throws "Unsupported algorithm" before
 * the handshake even starts. The remaining AES-GCM / AES-CTR ciphers
 * are mandatory for any RFC-compliant SSH server.
 */
const SSH_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group16-sha512',
  ],
  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
  ],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'],
  serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'rsa-sha2-512', 'rsa-sha2-256'],
} as const;

export function buildConnectConfig(
  creds: SSHCredentials,
  expectedSha256: string | null,
): ConnectConfig {
  const port = creds.port || 22;
  const base: ConnectConfig = {
    host: creds.host,
    port,
    username: creds.username,
    readyTimeout: 12_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    algorithms: SSH_ALGORITHMS as unknown as ConnectConfig['algorithms'],
    // TOFU host-key check.
    //   • First contact (expectedSha256=null): record fingerprint, allow.
    //   • Subsequent connect with matching key: allow.
    //   • Subsequent connect with DIFFERENT key: BLOCK (return false).
    // The verifier is sync — the caller pre-loads expectedSha256 before
    // we get here. Returning false aborts the SSH handshake; the user
    // recovers by calling forgetHostKey() after manual verification.
    hostVerifier: (key: Buffer | string) => {
      let sha256 = '';
      try {
        const buf = typeof key === 'string' ? Buffer.from(key, 'base64') : key;
        sha256 = crypto.createHash('sha256').update(buf).digest('base64');
      } catch (err) {
        log.warn('SSH hostVerifier hash failed — refusing connection', { err: String(err) });
        return false;
      }
      if (expectedSha256 && expectedSha256 !== sha256) {
        log.warn('SSH host key mismatch — connection refused', {
          host: creds.host,
          port,
          expected: expectedSha256,
          got: sha256,
        });
        return false;
      }
      // First contact OR matched: persist the fingerprint and allow.
      // rememberHostKey is fire-and-forget (we already trust the key for
      // this connection because we just verified it).
      void rememberHostKey(creds.host, port, sha256).catch((err) =>
        log.debug('rememberHostKey failed', { err: String(err) }),
      );
      return true;
    },
  };
  if (creds.privateKey && creds.privateKey.trim()) {
    base.privateKey = creds.privateKey;
    if (creds.passphrase) base.passphrase = creds.passphrase;
  } else if (creds.password) {
    base.password = creds.password;
  }
  return base;
}

export interface RunRemoteOptions {
  /**
   * Hard timeout in ms. When exceeded, the SSH stream is closed; the call
   * resolves with code=124 ("timeout"). Without this, a hung remote
   * command (eg. dockerd not responding to a `docker build`) leaves the
   * deploy spinning forever. Default: undefined (no timeout — preserves
   * legacy callers that pass a raw 4-arg signature).
   */
  timeoutMs?: number;
  /**
   * Abort signal — when fired we close the stream and resolve with
   * code=-1. Used by `cancelDeploy` to actually unblock a running
   * remote step.
   */
  signal?: AbortSignal;
  stdin?: string;
}

export function runRemote(
  client: Client,
  command: string,
  onData?: (chunk: string) => void,
  stdinOrOpts?: string | RunRemoteOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const opts: RunRemoteOptions =
    typeof stdinOrOpts === 'string'
      ? { stdin: stdinOrOpts }
      : stdinOrOpts ?? {};
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr });
      };
      const tryClose = () => {
        try {
          stream.close();
        } catch (err) {
          log.debug('ssh stream close failed', { err: (err as Error).message });
        }
      };
      if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          tryClose();
          finish(124);
        }, opts.timeoutMs);
      }
      const onAbort = () => {
        tryClose();
        finish(-1);
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      stream
        .on('close', (code: number) => finish(code ?? 0))
        .on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stdout += text;
          onData?.(text);
        })
        .stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stderr += text;
          onData?.(text);
        });
      if (opts.stdin !== undefined) {
        // Used to pipe secrets (e.g. mnemonic) into a remote command
        // without putting them on the shell argv. The remote process sees
        // them on its stdin, never in `ps` / `/proc/<pid>/cmdline`.
        stream.stdin.write(opts.stdin);
        stream.stdin.end();
      }
    });
  });
}

/**
 * SFTP upload. Each call opens its own SFTP session (an SSH channel) and MUST
 * end it: sshd caps channels per connection (MaxSessions, default 10), and a
 * deploy writes a dozen files over one connection — leaked sessions surface as
 * "Channel open failure: open failed".
 */
async function uploadBytes(client: Client, remotePath: string, content: Buffer, mode: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      const done = (e?: Error) => {
        try {
          sftp.end();
        } catch (endErr) {
          log.debug('sftp end failed', { err: (endErr as Error).message });
        }
        if (e) reject(e);
        else resolve();
      };
      const stream = sftp.createWriteStream(remotePath, { mode });
      stream.once('close', () => done());
      stream.once('error', (e: Error) => done(e));
      stream.end(content);
    });
  });
}

export async function uploadFile(
  client: Client,
  remotePath: string,
  content: string,
  mode: number = 0o644,
): Promise<void> {
  await uploadBytes(client, remotePath, Buffer.from(content, 'utf8'), mode);
}

/** Binary-safe SFTP upload (build-context tarballs). */
export async function uploadBuffer(
  client: Client,
  remotePath: string,
  content: Buffer,
  mode: number = 0o644,
): Promise<void> {
  await uploadBytes(client, remotePath, content, mode);
}

export async function mkdirRemote(client: Client, dir: string): Promise<void> {
  const cmd = shellQuote(['mkdir', '-p', dir]);
  const { code, stderr } = await runRemote(client, cmd);
  if (code !== 0) throw new Error(`mkdir -p ${dir} failed: ${stderr.trim()}`);
}

/**
 * POSIX single-quote each argument for a remote bash/sh command line.
 *
 * NOT shell-quote's `quote()`: for an argument containing both ' and " it
 * switches to double quotes and escapes `!` as `\!`, and bash keeps that
 * backslash inside double quotes — so `! grep -q …` in a script became the
 * command `\!` and every remote multi-line script silently misbehaved.
 * Single quotes pass every byte through; a literal ' is written as '\''.
 */
export function shellQuote(parts: string[]): string {
  return parts
    .map((p) => (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/**
 * Open an SSH connection. A handshake that stalls or is reset is retried (Q0341);
 * every other failure is returned at once, explained by sshConnectError.
 */
export async function connectClient(creds: SSHCredentials): Promise<Client> {
  const port = creds.port || 22;
  for (let attempt = 1; ; attempt++) {
    const client = new Client();
    const expected = await knownHostKey(creds.host, port);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => resolve());
        client.once('error', reject);
        client.connect(buildConnectConfig(creds, expected));
      });
    } catch (err) {
      try {
        client.end();
      } catch (endErr) {
        log.debug('ssh client end after failed connect', { err: (endErr as Error).message });
      }
      const e = err as Error;
      if (attempt < SSH_CONNECT_ATTEMPTS && sshConnectRetryable(e.message)) {
        log.warn('ssh handshake failed; retrying', { host: creds.host, port, attempt, err: e.message });
        await new Promise((r) => setTimeout(r, 1_000 * attempt * attempt));
        continue;
      }
      throw sshConnectError(creds.host, port, e);
    }
    // After 'ready' the one-shot rejecter is gone; a dropped connection must not
    // surface as an unhandled 'error' event.
    client.on('error', (err) => log.warn('ssh connection error', { host: creds.host, err: err.message }));
    return client;
  }
}

/** Connect + run + disconnect with a callback. */
export async function withSSH<T>(
  creds: SSHCredentials,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectClient(creds);
  try {
    return await fn(client);
  } finally {
    try {
      client.end();
    } catch (err) {
      log.debug('ssh client end failed', { err: (err as Error).message });
    }
  }
}
