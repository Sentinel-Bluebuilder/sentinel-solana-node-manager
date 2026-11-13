#!/usr/bin/env node
/**
 * Sentinel Node Manager (Solana devnet) — end-to-end test, driven from the
 * user's side through the RUNNING APP's CLI server (the same surface as
 * `bin/sentinel-node-manager.js`). Every function the app offers is called
 * the way a user would call it; every chain effect is then re-verified
 * independently against devnet JSON-RPC (never trusting the app's own answer).
 *
 * Phases
 *   P0  server      reachability, help lists every command, RPC health = devnet
 *   P1  wallet      create → restore → logout lifecycle; import the funded test key, balances, QR, events
 *   P2  validation  bad inputs rejected cleanly (unknown flags, bad hosts, dry-run sweep; no tx)
 *   P3  send        wallet self-send tDVPN + SOL; signature verified on chain
 *   P4  deploy      local node (WireGuard) → listed; PDA verified on chain
 *   P4b recovery    a second deploy cancelled right after funding → key swept, node forgotten
 *   P5  inspect     get / status / chain / logs / exportLogs / history / leases / daemon / inspect /
 *                   revealMnemonic (derivation checked) / specs memo (+idempotent)
 *   P6  session     paid test session (client container) → revenue on chain
 *   P7  protocols   switch through the other 5 protocols; chain bit + paid session each
 *   P8  pricing     three prices on chain; survive a restart
 *   P9  withdraw    revenue → wallet; balance delta checked
 *   P10 lifecycle   stop / start (re-list) / restart / relist / redeem
 *   P11 channels    sweep test channels (start-close; close when grace has passed)
 *   P12 remove      redeem → stop → delist → close → unbonding (time-gated)
 *   P13 finish      (--finish run, after unbonding / grace) withdraw bond, sweep key,
 *                   close + refund test channels, final balances
 *   P14 report      diagnostics export + JSON/Markdown report
 *   P15 hns         (after P7) HNS on → routing → HNS + ICANN names resolve through real tunnels;
 *                   off → the same probe fails the HNS name (negative control)
 *
 * Rules: sequential only, ≥7 s between transactions, acts only on the node(s)
 * it deploys and the channels it opens.
 *
 * Run (app running with the CLI server on):
 *   node tests/e2e/cli-e2e.mjs                     # P0–P12 + report, local target
 *   node tests/e2e/cli-e2e.mjs --finish            # P13 for nodes/channels left by earlier runs
 *   node tests/e2e/cli-e2e.mjs --target remote --ssh-host H --ssh-user U --ssh-key PATH [--ssh-port 22]
 *   node tests/e2e/cli-e2e.mjs --protocols wireguard,xray   # subset for P7
 *   node tests/e2e/cli-e2e.mjs --keep              # skip P12 (leave the node running)
 *
 * Env: TEST_KEYFILE (path to a devnet keypair file)
 *      DEVNET_RPC   verification RPC (default HELIUS_RPC_URL when set, else https://api.devnet.solana.com)
 *      HELIUS_RPC_URL  the app's dedicated RPC (any keyed devnet RPC URL); overrides --rpc-env.
 *                   Only its host is ever printed.
 *      Verification calls stay ≤ 5/s, back off 1 s → 30 s on 429, then fall back to public
 *      devnet; the request and 429 counts go in the report.
 */

import { execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// ─── config ───

const argv = process.argv.slice(2);

// Declared surface. An undeclared flag must never be ignored: `--help` silently
// started a full chain run (spending devnet funds) because unknown flags were
// dropped, the same class of bug the app's own CLI was hardened against.
const BOOL_FLAGS = ['finish', 'keep', 'help', 'no-hns'];
const VALUE_FLAGS = ['target', 'port', 'protocols', 'rpc-env', 'ssh-host', 'ssh-user', 'ssh-key', 'ssh-port', 'hns-protocols'];
const USAGE = `Sentinel Node Manager (Solana devnet) — E2E harness

Usage: node tests/e2e/cli-e2e.mjs [options]

  --target local|remote   Where to deploy (default local).
  --port <n>              First port of the node's 5-port block.
  --protocols a,b,c       Subset of ${['wireguard', 'amneziawg', 'v2ray', 'xray', 'openvpn', 'hysteria2'].join('|')}.
  --keep                  Leave the node deployed at the end.
  --hns-protocols a,b     P15: protocols for the HNS probe (default all six; V2Ray/Xray are probed through the SOCKS proxy).
  --no-hns                Skip P15 (HNS resolver on/off through a real client).
  --finish                Only finish pending work (bonds, test channels), deploy nothing.
  --rpc-env <path>        .env holding the app's dedicated RPC url.
  --ssh-host/-user/-key/-port   Remote target credentials.
  --help                  Show this and exit without touching the chain.
`;

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const name = a.slice(2).split('=')[0];
  if (BOOL_FLAGS.includes(name)) continue;
  if (VALUE_FLAGS.includes(name)) {
    if (!a.includes('=')) i += 1; // its value
    continue;
  }
  process.stderr.write(`Unknown flag ${a}\n\n${USAGE}`);
  process.exit(2);
}

const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (flag('help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const FINISH = flag('finish');
const KEEP = flag('keep');
const TARGET = opt('target', 'local');
let PORT = Number(opt('port', TARGET === 'remote' ? '41000' : '20000'));
const ALL_PROTOCOLS = ['wireguard', 'amneziawg', 'v2ray', 'xray', 'openvpn', 'hysteria2'];
// cb33 / public 26de5240 protocol bits (sentinel-go-sdk <driver>/<driver>.go protocolBit).
// Independent of the app's chain.ts on purpose: the harness checks the app, not itself.
const BITS = { wireguard: 1 << 0, v2ray: 1 << 1, openvpn: 1 << 2, amneziawg: 1 << 3, xray: 1 << 4, hysteria2: 1 << 5 };
const MATRIX = opt('protocols', ALL_PROTOCOLS.join(',')).split(',').filter((p) => ALL_PROTOCOLS.includes(p));
const KEYFILE = process.env.TEST_KEYFILE ?? path.join(os.homedir(), 'Desktop', 'sentinel-solana', 'keys', 'devnet', 'client.json');
// The dedicated RPC (HELIUS_RPC_URL) when it is set, public devnet otherwise; only its host is ever printed.
const RPC = process.env.DEVNET_RPC ?? process.env.HELIUS_RPC_URL?.trim() ?? 'https://api.devnet.solana.com';
// Dedicated RPC for the APP (Helius), read from an env file; verification
// stays on the public endpoint above so app results are checked by a second provider.
const RPC_ENV = opt('rpc-env', path.join(os.homedir(), 'Desktop', 'plans-solana', '.env'));
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '<bad url>';
  }
};
const PROGRAM_ID = 'J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs';
const TX_GAP_MS = 7_000;
// P15: tunnel protocols only (V2Ray/Xray are SOCKS proxies: the client's own DNS never enters the node).
const SKIP_HNS = flag('no-hns');
const HNS_MATRIX = opt('hns-protocols', 'wireguard,amneziawg,openvpn,v2ray,xray,hysteria2').split(',').filter((p) => ['wireguard', 'amneziawg', 'openvpn', 'v2ray', 'xray', 'hysteria2'].includes(p));
// hnsd synced in 200-242 s in H1/H2.
const HNS_SYNC_MS = 240_000;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const STATE_FILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'e2e-state.json');
const REPORT_DIR = path.join(path.dirname(STATE_FILE), 'reports');

const results = [];
let currentPhase = '';

// ─── reporting ───

function record(status, check, detail = '', ms = 0) {
  results.push({ phase: currentPhase, check, status, detail: String(detail).slice(0, 400), ms });
  const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : status === 'SKIP' ? '\x1b[33mSKIP\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${check}${detail ? `  — ${String(detail).slice(0, 160)}` : ''}${ms ? `  (${(ms / 1000).toFixed(1)}s)` : ''}`);
}

function phase(name) {
  currentPhase = name;
  console.log(`\n\x1b[1m━━ ${name} ━━\x1b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── independent devnet RPC (verification only) ───

// RPC etiquette: ≤ 5 requests/s per process; on 429
// back off 1 s → 30 s, then move the call to public devnet; count both and report them.
const PUBLIC_RPC = 'https://api.devnet.solana.com';
const RPC_MIN_GAP_MS = 200;
const rpcStats = { requests: 0, rateLimited: 0, movedToPublic: 0 };
let lastRpcAt = 0;

async function rpcPost(url, method, params) {
  const wait = lastRpcAt + RPC_MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRpcAt = Date.now();
  rpcStats.requests++;
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function rpc(method, params) {
  let url = RPC;
  for (let delay = 1_000; ; delay *= 2) {
    const res = await rpcPost(url, method, params);
    if (res.status === 429) {
      rpcStats.rateLimited++;
      if (delay <= 30_000) {
        await sleep(delay);
        continue;
      }
      if (url === PUBLIC_RPC) throw new Error(`${method}: rate-limited by ${hostOf(url)} after backing off to 30 s`);
      rpcStats.movedToPublic++;
      url = PUBLIC_RPC;
      delay = 500; // doubles to 1 s on the next pass
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
}

async function sigConfirmed(sig) {
  for (let i = 0; i < 10; i++) {
    const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
    const st = r.value[0];
    if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    await sleep(3000);
  }
  throw new Error(`tx ${sig} not confirmed`);
}

async function accountInfo(addr) {
  const r = await rpc('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]);
  return r.value;
}

/** Independent re-derivation of a Solana address from a BIP-39 phrase (SLIP-0010, m/44'/501'/0'/0'). */
async function deriveSolanaAddress(mnemonic) {
  const { mnemonicToSeedSync } = await import('@scure/bip39');
  const { Keypair } = await import('@solana/web3.js');
  const crypto = await import('node:crypto');
  const seed = mnemonicToSeedSync(mnemonic.trim().toLowerCase().replace(/\s+/g, ' '), '');
  let I = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = I.subarray(0, 32);
  let chain = I.subarray(32);
  for (const idx of [44, 501, 0, 0]) {
    const data = Buffer.alloc(37);
    data[0] = 0;
    key.copy(data, 1);
    data.writeUInt32BE((idx + 0x80000000) >>> 0, 33);
    I = crypto.createHmac('sha512', chain).update(data).digest();
    key = I.subarray(0, 32);
    chain = I.subarray(32);
  }
  return Keypair.fromSeed(key).publicKey.toBase58();
}

// ─── CLI client (NDJSON over the app's named pipe / unix socket) ───

class AppCli {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.buf = '';
    this.pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.endpoint);
      this.socket.once('error', reject);
      this.socket.once('connect', () => {
        this.socket.removeListener('error', reject);
        this.socket.on('error', (err) => console.error('pipe error:', err.message));
        this.socket.on('data', (b) => this.onData(b));
        this.socket.on('close', () => {
          for (const p of this.pending) p.reject(new Error('pipe closed mid-request'));
          this.pending = [];
        });
        const t = setTimeout(() => reject(new Error('no welcome from the CLI server')), 8000);
        this.onWelcome = (msg) => {
          clearTimeout(t);
          if (msg.mode === 'watcher') reject(new Error(`CLI server busy (held by ${msg.holder}). Disconnect it and re-run.`));
          else resolve(msg);
        };
        this.socket.write(JSON.stringify({ type: 'hello', client: 'agent' }) + '\n');
      });
    });
  }

  onData(chunk) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        console.error('unparseable server line:', line.slice(0, 120), err.message);
        continue;
      }
      if (msg.type === 'welcome' && this.onWelcome) {
        this.onWelcome(msg);
        this.onWelcome = null;
      } else if (msg.type === 'result') {
        // Match by echoed id; a reply for a request that already timed out is dropped, so it
        // cannot answer the next command (2026-11-08: one late program.status shifted 6 answers).
        // A server too old to echo ids falls back to first-in, first-out.
        const i = msg.id === undefined ? 0 : this.pending.findIndex((p) => p.id === msg.id);
        if (i < 0) {
          console.log(`        · dropped a late reply (request ${msg.id} had timed out)`);
          continue;
        }
        const [p] = this.pending.splice(i, 1);
        if (p) {
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    }
  }

  run(line, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.timer !== timer);
        reject(new Error(`timed out after ${timeoutMs / 1000}s: ${line.slice(0, 80)}`));
      }, timeoutMs);
      const id = (this.nextId = (this.nextId ?? 0) + 1);
      this.pending.push({ id, resolve, reject, timer });
      this.socket.write(JSON.stringify({ type: 'run', line, id }) + '\n');
    });
  }

  close() {
    this.socket?.write(JSON.stringify({ type: 'bye' }) + '\n');
    this.socket?.end();
  }
}

let cli;

/** Run a command; returns parsed JSON (or text). Throws on ok=false. */
async function call(line, timeoutMs) {
  const r = await cli.run(line, timeoutMs);
  if (!r.ok) throw new Error(r.error || 'command failed');
  if (r.text === '(ok — no value)') return undefined;
  try {
    return JSON.parse(r.text);
  } catch {
    return r.text;
  }
}

/** Run a command expected to fail. Returns the error text. */
async function callFails(line) {
  const r = await cli.run(line, 60_000);
  if (r.ok) throw new Error(`expected failure but succeeded: ${r.text.slice(0, 120)}`);
  return r.error ?? '';
}

/** A check: run fn, record PASS with its returned detail, or FAIL. Never throws unless `fatal`. */
async function check(name, fn, { fatal = false } = {}) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record('PASS', name, detail ?? '', Date.now() - t0);
    return true;
  } catch (err) {
    record('FAIL', name, err.message, Date.now() - t0);
    if (fatal) throw new Error(`fatal: ${name}`);
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * The failure must be the daemon saying the session does not exist, not a command that
 * never reached it (FS36 S13 run 1: a missing --instance passed as "rejected").
 */
function assertNotFound(e) {
  assert(!/required flag|unknown flag|unknown command|cannot connect|no such file|connection refused/i.test(e), `the call never reached the daemon: ${e.slice(0, 160)}`);
  assert(/not ?found|no such session|does not exist/i.test(e), `expected a not-found error, got: ${e.slice(0, 160)}`);
}

// ─── Remote leftover state (built-in check) ───
// Read-only probes over the system ssh with the run's own credentials. Each probe is
// first shown to SEE the live node (positive control), so "nothing left" can never be
// a probe that could not look.

function sshRun(script) {
  return new Promise((resolve) => {
    // accept-new: the harness may run with the app's own HOME (no known_hosts yet); a CHANGED key still fails.
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new', '-p', opt('ssh-port', '22')];
    const key = opt('ssh-key');
    if (key) args.push('-i', path.resolve(key));
    args.push(`${opt('ssh-user', 'root')}@${opt('ssh-host')}`, script);
    execFile('ssh', args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

const AS_ROOT = 'if [ "$(id -u)" = 0 ]; then S=; else S="sudo -n"; fi;';

/** What of this node is still on the remote host. `full` adds the node folder and ufw rules. */
async function remoteLeftovers(nodeId, port, { full }) {
  assert(/^[A-Za-z0-9-]+$/.test(nodeId), `unexpected node id ${nodeId}`);
  assert(Number.isInteger(port), `unexpected node port ${port}`);
  const found = [];
  const c = await sshRun(`${AS_ROOT} $S docker ps -aq --filter label=sentinel-sol.node-id=${nodeId}`);
  assert(c.code === 0, `the probe could not run docker on the host: ${c.out.trim().slice(-200)}`);
  if (c.out.trim()) found.push(`container ${c.out.trim().split(/\s+/).join(',')}`);
  if (full) {
    const h = await sshRun(`if [ -e "$HOME/.dvpnd-nodes/${nodeId}" ]; then echo HOME-PRESENT; else echo HOME-ABSENT; fi`);
    assert(/HOME-(PRESENT|ABSENT)/.test(h.out), `the probe could not check the node folder: ${h.out.trim().slice(-200)}`);
    if (h.out.includes('HOME-PRESENT')) found.push(`node folder ~/.dvpnd-nodes/${nodeId}`);
    const f = await sshRun(`${AS_ROOT} $S ufw status 2>&1; echo UFW-DONE`);
    assert(f.out.includes('UFW-DONE'), `the probe could not read ufw: ${f.out.trim().slice(-200)}`);
    const rules = f.out.split('\n').map((l) => l.trim()).filter((l) => new RegExp(`^${port}(:|/)`).test(l));
    if (rules.length) found.push(`ufw rules ${rules.map((r) => r.split(/\s+/)[0]).join(', ')}`);
  }
  return found;
}

// ─── state carried between runs (for --finish) ───

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('state file unreadable:', err.message);
    return { nodes: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── endpoint discovery ───

async function discoverEndpoint() {
  if (process.env.SENTINEL_NODE_MANAGER_CLI_ENDPOINT) return process.env.SENTINEL_NODE_MANAGER_CLI_ENDPOINT;
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'sentinel-node-manager-solana')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'sentinel-node-manager-solana')
        : path.join(os.homedir(), '.config', 'sentinel-node-manager-solana');
  const d = JSON.parse(await fs.readFile(path.join(dir, 'cli-endpoint.json'), 'utf8'));
  return d.endpoint;
}

// ─── phases ───

async function waitDeploy(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const st = await call(`deploy.status ${jobId}`);
    if (st) {
      const line = `${st.phase} ${st.percent}% ${st.message}`;
      if (line !== last) console.log(`        · ${line}${st.log ? ` | ${st.log.slice(0, 110)}` : ''}`);
      last = line;
      if (st.phase === 'done') return st;
      if (st.phase === 'error' || st.phase === 'cancelled') throw new Error(`deploy ${st.phase}: ${st.log}`);
    }
    await sleep(5_000);
  }
  throw new Error('deploy did not finish in time');
}

async function chain(nodeId) {
  return call(`nodes.chain ${nodeId}`, 180_000);
}

async function main() {
  console.log(`Sentinel Node Manager (Solana devnet) — E2E ${RUN_ID}  target=${TARGET}${FINISH ? ' (finish)' : ''}`);
  const state = await loadState();
  const endpoint = await discoverEndpoint();
  cli = new AppCli(endpoint);

  // ── P0 ──
  phase('P0 server');
  await check('connect to the app CLI server', async () => `${endpoint}`, { fatal: true });
  await cli.connect();
  await check('help lists every Solana command', async () => {
    const r = await cli.run('help');
    const need = [
      'wallet.importKey', 'wallet.send', 'deploy.start', 'nodes.chain', 'nodes.test', 'nodes.setProtocol',
      'nodes.updatePricing', 'nodes.withdraw', 'nodes.redeem', 'nodes.relist', 'nodes.withdrawBond',
      'nodes.sweepTestChannels', 'nodes.publishSpecs', 'nodes.specs', 'nodes.remove',
      'nodes.sessions', 'nodes.session', 'nodes.closeSession', 'nodes.positions', 'nodes.redemptions',
      'nodes.inspect', 'nodes.daemon', 'program.status', 'nodes.reconnect', 'nodes.leases', 'nodes.exportLogs',
      'nodes.revealMnemonic', 'nodes.backupMnemonic', 'wallet.create', 'wallet.restore', 'wallet.logout', 'ssh.test',
      'nodes.cleanHostLeftovers',
    ];
    const missing = need.filter((c) => !r.text.includes(c));
    assert(missing.length === 0, `missing: ${missing.join(', ')}`);
    return `${need.length} required commands present`;
  });
  await check('help <command> and exit/quit are handled by the registry', async () => {
    const h = await cli.run('help nodes.test');
    assert(h.ok && /nodes\.test — /.test(h.text) && /Usage:/.test(h.text), String(h.text ?? h.error).slice(0, 120));
    const q = await cli.run('quit');
    assert(q.ok, q.error);
    return h.text.split('\n')[0];
  });
  await check('system.report', async () => {
    const r = await call('system.report');
    assert(r.dockerReachable, `docker not reachable: ${r.dockerError}`);
    return `${r.osLabel} · Docker ${r.dockerVersion}`;
  });
  await check('settings.set: dedicated RPC first, public devnet as fallback', async () => {
    // HELIUS_RPC_URL in the environment wins over the env file.
    let urls = process.env.HELIUS_RPC_URL ? [process.env.HELIUS_RPC_URL.trim()] : [];
    if (!urls.length) try {
      const env = await fs.readFile(RPC_ENV, 'utf8');
      const line = env.split(/\r?\n/).find((l) => /^SOLANA_RPC_URLS\s*=/.test(l));
      urls = (line ? line.split('=').slice(1).join('=') : '').replace(/["']/g, '').split(',').map((u) => u.trim()).filter(Boolean);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const dedicated = urls.filter((u) => !/api\.devnet\.solana\.com/.test(u));
    const next = [...dedicated, 'https://api.devnet.solana.com'];
    const s = await call(`settings.set --json '${JSON.stringify({ rpcUrls: next })}'`);
    assert(s.rpcUrls.length === next.length, 'rpc list not saved');
    return next.map(hostOf).join(' → ');
  });
  await check('program.status: devnet program, not paused, image identity matches', async () => {
    // First use after a Dockerfile/source change builds the image here (minutes), like a deploy.
    const r = await call('program.status', 45 * 60_000);
    assert(r.params.paused === 0, `paused mask ${r.params.paused}`);
    assert(r.image.network === 'devnet' && r.image.program_id === PROGRAM_ID, JSON.stringify(r.image));
    return `feeBps ${r.params.feeBps} · minNodeBond ${r.params.minNodeBond} · unbonding ${r.params.unbondingSeconds}s · image ${r.image.tag}`;
  });
  await check('settings.get (RPC API keys redacted for pipe clients)', async () => {
    const s = await call('settings.get');
    assert(Array.isArray(s.rpcUrls) && 'priorityFeeMicroLamports' in s && s.upstreamDir, 'unexpected settings shape');
    assert(!s.rpcUrls.some((u) => /api-key=|apikey=/i.test(u)), 'an RPC API key reached the CLI client');
    return `rpc ${s.rpcUrls.map(hostOf).join(', ')} · upstream ${s.upstreamDir}`;
  });
  await check('settings.chainHealth = devnet', async () => {
    const h = await call('settings.chainHealth', 60_000);
    // The app's job is an accurate report: the dedicated RPC (first) must be devnet and reachable;
    // every reachable one must be devnet; an unreachable fallback must say why. Public devnet
    // rate-limits shared cloud IPs (429), which is a true report, not an app failure.
    const line = h.map((x) => `${hostOf(x.rpcUrl)}: ${x.error ?? 'ok'}`).join('; ');
    assert(h.length > 0 && h[0].reachable && h[0].chainId === 'devnet', `dedicated RPC not healthy — ${line}`);
    assert(h.every((x) => (x.reachable ? x.chainId === 'devnet' : typeof x.error === 'string' && x.error.length > 0)), `inconsistent health report — ${line}`);
    return h.map((x) => (x.reachable ? `${hostOf(x.rpcUrl)} slot ${x.blockHeight} ${x.latencyMs} ms` : `${hostOf(x.rpcUrl)} reported down (${String(x.error).slice(0, 60)})`)).join(' · ');
  });

  // ── P1 ──
  phase('P1 wallet');
  const key = JSON.parse(await fs.readFile(KEYFILE, 'utf8'));
  assert(Array.isArray(key) && key.length === 64, 'test key file is not a solana-keygen key');
  let wallet = await call('wallet.get');
  if (!FINISH) {
    // Lifecycle of a throwaway wallet, nothing on chain: create → get → logout → restore (same phrase) → logout.
    await check('wallet.create → logout → wallet.restore (same phrase) → logout', async () => {
      const created = await call('wallet.create');
      const words = String(created.mnemonic ?? '').trim().split(/\s+/);
      assert(words.length === 24, `${words.length} words`);
      assert(created.wallet?.address && created.wallet.secretKind === 'mnemonic', 'bad wallet state after create');
      assert((await deriveSolanaAddress(created.mnemonic)) === created.wallet.address, 'address is not the m/44\'/501\'/0\'/0\' derivation of the phrase');
      const got = await call('wallet.get');
      assert(got.address === created.wallet.address && got.hasMnemonic === true, 'wallet.get differs from create');
      await call('wallet.logout');
      const gone = await call('wallet.get');
      assert(gone.address === null && gone.hasMnemonic === false, 'logout did not clear the wallet');
      const restored = await call(`wallet.restore --mnemonic "${created.mnemonic}"`);
      assert(restored.address === created.wallet.address, `restore gave ${restored.address}`);
      await call('wallet.logout');
      return `${created.wallet.address}: derivation verified, restore returns the same address`;
    });
    await check('wallet.restore rejects a bad phrase', async () => callFails('wallet.restore --mnemonic "abandon abandon abandon"'));
  }
  await check('wallet.importKey (funded devnet test key)', async () => {
    wallet = await call(`wallet.importKey --file "${KEYFILE.split(path.sep).join('/')}"`);
    assert(wallet.secretKind === 'keyfile', `secretKind ${wallet.secretKind}`);
    return wallet.address;
  }, { fatal: true });
  let before;
  await check('wallet.refreshBalance', async () => {
    // The wallet is shared with other projects' tests (#29, #30), so SOL can move
    // between reads. Bracket the app's read between two chain reads and allow the
    // value to sit anywhere in that window (plus a 0.001 SOL margin).
    const lo = (await rpc('getBalance', [wallet.address, { commitment: 'confirmed' }])).value;
    before = await call('wallet.refreshBalance', 60_000);
    const hi = (await rpc('getBalance', [wallet.address, { commitment: 'confirmed' }])).value;
    const app = before.balanceSOL * 1e9;
    const min = Math.min(lo, hi) - 1e6;
    const max = Math.max(lo, hi) + 1e6;
    assert(app >= min && app <= max, `app ${before.balanceSOL} SOL outside chain window [${lo / 1e9}, ${hi / 1e9}]`);
    return `${before.balanceSOL.toFixed(4)} SOL · ${before.balanceDVPN} tDVPN (SOL cross-checked on chain)`;
  });
  // --finish deploys nothing (it withdraws bonds and refunds channels), so it needs only fee SOL.
  await check(FINISH ? 'wallet has fee SOL for --finish' : 'wallet has funds for the full run', async () => {
    if (FINISH) {
      assert(before.balanceSOL >= 0.01, `need ≥ 0.01 SOL for fees, have ${before.balanceSOL}`);
      return `ok (${before.balanceSOL.toFixed(4)} SOL; no tDVPN needed to finish)`;
    }
    assert(before.balanceSOL >= 0.2, `need ≥ 0.2 SOL, have ${before.balanceSOL}`);
    assert(before.balanceDVPN >= 4, `need ≥ 4 tDVPN, have ${before.balanceDVPN}`);
    return 'ok';
  }, { fatal: true });
  await check('wallet.qrSvg', async () => {
    const svg = await call(`wallet.qrSvg --text ${wallet.address}`);
    assert(String(svg).startsWith('<svg'), 'not an svg');
    return `${String(svg).length} chars`;
  });
  await check('events.list', async () => {
    const ev = await call('events.list --limit 5');
    assert(Array.isArray(ev), 'not an array');
    return `${ev.length} events`;
  });

  if (FINISH) return finish(state, wallet);

  // ── P2 ──
  phase('P2 validation');
  await check('wallet.send rejects a non-Solana address', async () => {
    const r = await call('wallet.send --to sent1abcdefghij --amount 0.001');
    assert(r.ok === false && r.errorCode === 'invalid-address', JSON.stringify(r));
    return r.error;
  });
  await check('wallet.send rejects zero amount', async () => {
    const r = await call(`wallet.send --to ${wallet.address} --amount 0`);
    assert(r.ok === false, JSON.stringify(r));
    return r.error;
  });
  await check('deploy.start rejects an unknown protocol', async () => callFails('deploy.start --target local --moniker x --gb 1 --hr 1 --service ipsec --port 20000'));
  await check('deploy.start rejects a port block past 65535', async () => callFails('deploy.start --target local --moniker x --gb 1 --hr 1 --service wireguard --port 65533'));
  await check('nodes.get requires a node id', async () => callFails('nodes.get'));
  await check('unknown command is rejected', async () => callFails('nodes.teleport x'));
  await check('unknown flag is rejected (never a silent un-flagged run)', async () => {
    const e = await callFails('nodes.sweepTestChannels --dryrun');
    assert(/Unknown flag --dryrun/.test(e) && /--dry-run/.test(e), e);
    return e.slice(0, 120);
  });
  await check('surplus positional argument is rejected', async () => callFails('nodes.list extra'));
  // S13 settings validation: each bad value is refused in plain words and nothing is saved.
  {
    const before = JSON.stringify(await call('settings.get'));
    const bad = [
      ['an unknown setting', { teleportNodes: true }, /Unknown setting "teleportNodes"/],
      ['a non-boolean flag', { stopNodesOnQuit: 'yes' }, /must be true or false/],
      ['a plain-http RPC URL', { rpcUrls: ['http://rpc.example.com'] }, /RPC URL not accepted/],
      ['an upstreamDir with no node source', { upstreamDir: os.tmpdir() }, /is not a node source folder/],
    ];
    for (const [what, patch, want] of bad) {
      await check(`settings.set rejects ${what}`, async () => {
        const e = await callFails(`settings.set --json '${JSON.stringify(patch)}'`);
        assert(want.test(e), `unexpected message: ${e.slice(0, 160)}`);
        assert(!/\b(undefined|null|NaN|\[object Object\]|TypeError|ENOENT)\b/.test(e), `raw error text in message: ${e.slice(0, 160)}`);
        return e.slice(0, 120);
      });
    }
    await check('rejected settings left the saved settings unchanged', async () => {
      assert(JSON.stringify(await call('settings.get')) === before, 'settings changed after rejected patches');
      return 'unchanged';
    });
  }
  await check('bare value flag is rejected', async () => callFails('wallet.send --to --amount 1'));
  await check('nodes.sweepTestChannels --dry-run sends nothing', async () => {
    const r = await call('nodes.sweepTestChannels --dry-run', 300_000);
    assert(r.dryRun === true && r.errors.length === 0, JSON.stringify(r).slice(0, 200));
    return `would start-close ${r.startedClose.length} · would close ${r.closed.length} · waiting ${r.pending.length}`;
  });
  await check('ssh.test fails cleanly on an unreachable host', async () => {
    const r = await call('ssh.test --host 192.0.2.1 --port 22 --username root --password x', 60_000);
    assert(r.ok === false && r.message, JSON.stringify(r));
    return r.message.slice(0, 100);
  });
  await check('nodes.reconnect fails cleanly on an unreachable host', async () => {
    const r = await call('nodes.reconnect --ssh-host 192.0.2.1 --ssh-user root --ssh-password x', 60_000);
    assert(r.ok === false && r.nodes.length === 0, JSON.stringify(r));
    return String(r.error).slice(0, 100);
  });
  await check('deploy.cancel on an unknown job returns false', async () => {
    const r = await call('deploy.cancel 00000000-0000-4000-8000-000000000000');
    assert(r === false, `got ${JSON.stringify(r)}`);
    return 'false';
  });
  await check('updater is disabled (no release channel)', async () => {
    const r = await call('updater.status');
    assert(r.stage === 'idle' && /disabled/i.test(r.error ?? ''), JSON.stringify(r));
    const i = await call('updater.install');
    assert(i.ok === false, 'install must refuse');
    return r.error;
  });
  await check('docker.overview + docker.prune', async () => {
    const o = await call('docker.overview', 60_000);
    assert(o.reachable && Array.isArray(o.sentinelImages), 'docker overview not reachable');
    const pr = await call('docker.prune', 120_000);
    assert(typeof pr.removed === 'number', 'prune shape');
    return `${o.containers.running} running · ${o.sentinelImages.length} node image(s) · pruned ${pr.removed}`;
  });

  // ── P3 ──
  phase('P3 send');
  await check('wallet.send self-send 0.001 tDVPN + 0.0001 SOL (one tx)', async () => {
    const r = await call(`wallet.send --to ${wallet.address} --amount 0.001 --sol 0.0001 --memo e2e-${RUN_ID.slice(0, 19)}`, 120_000);
    assert(r.ok, r.error);
    const st = await sigConfirmed(r.txHash);
    return `${r.txHash} · slot ${st.slot} · fee ${r.gasUsed} lamports (confirmed via RPC)`;
  });
  await sleep(TX_GAP_MS);

  // ── P4 ──
  phase(`P4 deploy (${TARGET})`);
  let outsideBlocked = false;
  let nodeId;
  // Pick a free port block: never collide with nodes this harness did not create
  // (a user's node on the same host), and leave room for the P4b block at +10.
  {
    const existing = await call('nodes.list');
    const occupies = (n) => !n.removalStage || n.removalStage === 'redeem' || n.removalStage === 'stop';
    const sameHost = existing.filter((n) => occupies(n) && (TARGET === 'local' ? n.target === 'local' : n.target === 'remote' && n.host === opt('ssh-host')));
    const overlaps = (p) => sameHost.some((n) => Math.abs(n.port - p) < 5 || Math.abs(n.port - (p + 10)) < 5);
    let p = PORT;
    while (overlaps(p) && p < 65500) p += 20;
    if (p !== PORT) console.log(`        · port block ${PORT} is taken by another node on this host; using ${p}`);
    PORT = p;
    if (TARGET === 'local' && sameHost.length >= 2) {
      record('SKIP', 'deploy phases (P4–P12)', `this machine already hosts ${sameHost.length} nodes; the suite needs two free local slots (max 3) and will not remove nodes it did not create`);
      return report();
    }
  }
  const moniker = `e2e-${RUN_ID.slice(5, 16).replace(/[^0-9]/g, '')}`;
  let sshFlag = '';
  if (TARGET === 'remote') {
    const host = opt('ssh-host');
    assert(host, '--ssh-host required for --target remote');
    const keyPath = opt('ssh-key');
    sshFlag = ` --ssh-host ${host} --ssh-user ${opt('ssh-user', 'root')} --ssh-port ${opt('ssh-port', '22')}${keyPath ? ` --ssh-key-file "${path.resolve(keyPath).split(path.sep).join('/')}"` : ''}`;
  }
  const ok4 = await check(`deploy.start + poll to done (${moniker}, wireguard, ports ${PORT}–${PORT + 4})`, async () => {
    const started = await call(`deploy.start --target ${TARGET} --moniker ${moniker} --gb 0.002 --hr 0.001 --lease 0.001 --service wireguard --port ${PORT}${sshFlag}`, 120_000);
    nodeId = started.nodeId;
    // Record the node key now: a deploy that fails later must still be provable empty by --finish.
    const early = await call(`nodes.get ${nodeId}`).catch(() => null);
    state.nodes.push({ nodeId, moniker, target: TARGET, runId: RUN_ID, operatorAddress: early?.operatorAddress });
    await saveState(state);
    const done = await waitDeploy(started.jobId, 45 * 60_000);
    assert(!done.mnemonicForBackup || done.mnemonicForBackup.startsWith('[redacted'), 'mnemonic leaked over the CLI');
    return `node ${nodeId}`;
  });
  if (!ok4) return report();
  let node = await call(`nodes.get ${nodeId}`);
  {
    const st = state.nodes.find((x) => x.nodeId === nodeId);
    Object.assign(st, { operatorAddress: node.operatorAddress, nodePda: node.nodePda, port: node.port });
    await saveState(state);
  }
  // Proves both halves: ufw is active on the host AND the app's rule for this node's block is in
  // it. "ufw inactive" (this cell needs a ufw host) and "rule not added" (app bug) fail differently.
  if (TARGET === 'remote') {
    await check('host firewall opened for the node block (ufw active, app rule present)', async () => {
      const st = (await sshRun(`${AS_ROOT} $S ufw status 2>&1`)).out;
      assert(!/Status:\s*inactive/i.test(st), 'ufw is INACTIVE on the host — this cell needs a host with ufw active (no rule is needed or added without it)');
      assert(/Status:\s*active/i.test(st), `could not read ufw status: ${st.trim().slice(0, 120)}`);
      const range = `${PORT}:${PORT + 4}`;
      const missing = ['tcp', 'udp'].filter((p) => !new RegExp(`^${range}/${p}\\s+ALLOW`, 'm').test(st));
      assert(node.firewallOpened === true && !missing.length, `ufw is active but the app's rule was NOT added (firewallOpened=${node.firewallOpened}; missing ${missing.join('+') || 'none'} for ${range})`);
      return `ufw active · ${range}/tcp + ${range}/udp ALLOW present`;
    });
  }
  await check('node PDA exists on chain, owned by the dvpn program (independent RPC)', async () => {
    const acc = await accountInfo(node.nodePda);
    assert(acc && acc.owner === PROGRAM_ID, `owner ${acc?.owner}`);
    const size = Buffer.from(acc.data[0], 'base64').length;
    assert(size === 337, `size ${size}`);
    await sigConfirmed(node.openTx);
    return `${node.nodePda} · 337 B · open_node ${node.openTx.slice(0, 16)}… confirmed`;
  });

  // ── P4b: a deploy cancelled right after funding must reclaim the funds and leave no node ──
  phase('P4b failed-deploy recovery');
  await check('deploy.start → cancel after funding → key swept, node forgotten (independent RPC)', async () => {
    const started = await call(`deploy.start --target ${TARGET} --moniker ${moniker}-x --gb 0.002 --hr 0.001 --service wireguard --port ${PORT + 10}${sshFlag}`, 120_000);
    const n2 = await call(`nodes.get ${started.nodeId}`);
    assert(n2?.operatorAddress, 'node record missing right after deploy.start');
    const key = n2.operatorAddress;
    const deadline = Date.now() + 10 * 60_000;
    let funded = false;
    while (Date.now() < deadline) {
      const st = await call(`deploy.status ${started.jobId}`);
      if (st && ['done', 'error', 'cancelled'].includes(st.phase)) throw new Error(`deploy ended (${st.phase}: ${st.log}) before the cancel`);
      if (st && (st.txSig || st.percent >= 40)) {
        funded = true;
        break;
      }
      await sleep(2_000);
    }
    assert(funded, 'never saw the funding step');
    const cancelled = await call(`deploy.cancel ${started.jobId}`);
    assert(cancelled === true, 'cancel returned false');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(5_000);
      gone = !(await call(`nodes.get ${started.nodeId}`));
    }
    assert(gone, 'node record still present 200 s after cancel');
    const lam = (await rpc('getBalance', [key, { commitment: 'confirmed' }])).value;
    const tokens = await rpc('getTokenAccountsByOwner', [key, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }]);
    assert(lam <= 5_000 && tokens.value.length === 0, `key still holds ${lam} lamports / ${tokens.value.length} token account(s)`);
    return `node key ${key.slice(0, 8)}… funded, cancelled → ${lam} lamports, 0 token accounts, record gone`;
  });
  await sleep(TX_GAP_MS);

  // ── P5 ──
  phase('P5 inspect');
  await check('nodes.chain: listed, prices, uri, protocol bit', async () => {
    const c = await chain(nodeId);
    assert(c.status === 1, `status ${c.status}`);
    assert(c.prices.perGb === 2000 && c.prices.perHour === 1000 && c.prices.leasePerHour === 1000, JSON.stringify(c.prices));
    assert(c.protocols === BITS.wireguard, `protocols ${c.protocols}`);
    assert(c.owner === node.operatorAddress && c.bond === 1_000_000, `owner/bond ${c.owner} ${c.bond}`);
    return `${c.uri} · listedAt ${new Date(c.listedAt * 1000).toISOString()}`;
  });
  await check('nodes.status', async () => {
    const s = await call(`nodes.status ${nodeId}`, 180_000);
    assert(s.chainStatus === 'listed' && s.reachable, `${s.chainStatus} reachable=${s.reachable} ${s.error ?? ''}`);
    return `slot ${s.chainHeight} · expires ${s.listingExpiresAt} · ${s.logTail.length} log lines`;
  });
  await check('nodes.list contains the node', async () => {
    const l = await call('nodes.list');
    assert(l.some((n) => n.id === nodeId), 'missing');
    return `${l.length} node(s)`;
  });
  await check('nodes.logs', async () => {
    const l = await call(`nodes.logs ${nodeId}`, 60_000);
    assert(Array.isArray(l) && l.length > 0, 'no logs');
    return l[l.length - 1].slice(0, 100);
  });
  await check('nodes.history --window 1h', async () => {
    const h = await call(`nodes.history ${nodeId} --window 1h`);
    assert(Array.isArray(h), 'not an array');
    return `${h.length} samples`;
  });
  await check('nodes.daemon (control socket status + version)', async () => {
    const r = await call(`nodes.daemon ${nodeId}`, 120_000);
    assert(r.status && r.version, JSON.stringify(r).slice(0, 160));
    return JSON.stringify(r.version).slice(0, 120);
  });
  await check('nodes.exportLogs --format txt writes the recent container logs to a file', async () => {
    const r = await call(`nodes.exportLogs ${nodeId} --format txt`, 60_000);
    assert(r.ok && r.path, r.error);
    const st = await fs.stat(r.path);
    assert(st.size > 0, 'empty file');
    return `${r.path} (${st.size} B)`;
  });
  await check('nodes.leases (on-chain lease search; none expected on a fresh node)', async () => {
    const r = await call(`nodes.leases ${nodeId}`, 180_000);
    assert(Array.isArray(r), 'not an array');
    return `${r.length} lease(s)`;
  });
  await check("nodes.revealMnemonic → 24 words that derive the node key; backup round-trip", async () => {
    const r = await call(`nodes.revealMnemonic ${nodeId}`);
    assert(r.ok && r.mnemonic, r.error);
    const words = r.mnemonic.trim().split(/\s+/);
    assert(words.length === 24, `${words.length} words`);
    const addr = await deriveSolanaAddress(r.mnemonic);
    assert(addr === node.operatorAddress, `derived ${addr}, node key ${node.operatorAddress}`);
    const b = await call(`nodes.backupMnemonic ${nodeId} --mnemonic "${r.mnemonic}"`);
    assert(b.ok, b.error);
    const r2 = await call(`nodes.revealMnemonic ${nodeId}`);
    assert(r2.ok && r2.mnemonic === r.mnemonic, 'backup/reveal round-trip differs');
    return `derives ${addr} (matches the node key); backup round-trip ok`;
  });
  await check('nodes.session rejects an unknown session id', async () => {
    const e = await callFails(`nodes.session ${nodeId} --id 00000000-0000-0000-0000-000000000000`);
    assertNotFound(e);
    return e.slice(0, 120);
  });
  {
    const t0 = Date.now();
    const name = 'nodes.inspect: reachable from here, signed metadata + TLS pin, discoverable';
    try {
      const r = await call(`nodes.inspect ${nodeId}`, 180_000);
      assert(r.discoverable, 'node not returned by node search --status listed');
      if (!r.reachable && r.blockedUpstream) {
        outsideBlocked = true;
        record('SKIP', name, `environment: node answers on its host, host firewall handled, but filtered upstream — ${r.guidance}`, Date.now() - t0);
      } else if (!r.reachable && TARGET === 'remote' && !node.firewallOpened) {
        record('SKIP', name, `listed + discoverable, but this machine cannot reach it (no host firewall the app can manage): ${r.guidance}`, Date.now() - t0);
      } else {
        assert(r.reachable, r.guidance ?? r.error ?? 'unreachable');
        assert(r.tlsPinMatches !== false, 'TLS fingerprint differs from the one recorded at init');
        record('PASS', name, `reachable · discoverable · TLS pin ${r.tlsPinMatches ? 'matches' : 'not reported'}`, Date.now() - t0);
      }
    } catch (err) {
      record('FAIL', name, err.message, Date.now() - t0);
    }
  }
  await check('nodes.sessions / nodes.positions / nodes.redemptions (fresh node)', async () => {
    const ss = await call(`nodes.sessions ${nodeId}`, 120_000);
    const ps = await call(`nodes.positions ${nodeId}`, 120_000);
    const rd = await call(`nodes.redemptions ${nodeId}`, 120_000);
    assert(Array.isArray(ss) && Array.isArray(ps), 'sessions/positions not arrays');
    return `${ss.length} sessions · ${ps.length} positions · redemptions ${JSON.stringify(rd).slice(0, 60)}`;
  });
  let specsSig;
  await check('nodes.publishSpecs (memo signed by the node key)', async () => {
    await sleep(TX_GAP_MS);
    const r = await call(`nodes.publishSpecs ${nodeId} --force`, 120_000);
    assert(r.ok, r.error);
    specsSig = r.txHash;
    await sigConfirmed(specsSig);
    return specsSig;
  });
  await check('nodes.publishSpecs is idempotent (no second tx)', async () => {
    const r = await call(`nodes.publishSpecs ${nodeId}`, 60_000);
    assert(r.ok && r.txHash === specsSig, `got ${r.txHash}`);
    return 'same signature returned';
  });
  await check('nodes.specs reads the memo back from chain', async () => {
    const r = await call(`nodes.specs ${nodeId}`, 60_000);
    assert(r && r.memo.includes('specs:v1:') && r.signature === specsSig, JSON.stringify(r).slice(0, 160));
    return r.memo.slice(0, 120);
  });

  // ── P6 + P7 ──
  for (const proto of MATRIX) {
    phase(`P${proto === 'wireguard' ? 6 : 7} session · ${proto}`);
    if (proto !== 'wireguard') {
      const switched = await check(`nodes.setProtocol ${proto} → chain bit ${BITS[proto]}`, async () => {
        const r = await call(`nodes.setProtocol ${nodeId} --service ${proto}`, 420_000);
        assert(r.ok, r.error);
        const c = await chain(nodeId);
        assert(c.protocols === BITS[proto], `chain protocols ${c.protocols}`);
        return `on chain: ${c.protocols}`;
      });
      if (!switched) continue;
    }
    {
      const t0 = Date.now();
      let res;
      try {
        res = await call(`nodes.test ${nodeId}`, 600_000);
      } catch (err) {
        res = { ok: false, error: err.message, steps: [] };
      }
      for (const st of res.steps ?? []) console.log(`        · ${st.slice(0, 150)}`);
      const name = `nodes.test paid session over ${proto}`;
      if (res.ok) {
        const via = (res.steps ?? []).some((s) => s.includes('FORCED_HAIRPIN')) ? ' · same-host via the node container (hy2)' : '';
        record('PASS', name, `${res.downloadedBytes} B through the tunnel · revenue ${res.revenueBefore} → ${res.revenueAfter} · channel ${res.channel ?? '?'}${via}`, Date.now() - t0);
      } else if (res.unsupported) {
        record('SKIP', name, `client host limitation (not a node defect): ${res.unsupported}`, Date.now() - t0);
      } else {
        record('FAIL', name, (res.error ?? '').split('\n')[0], Date.now() - t0);
        if (res.clientLog) {
          console.log('        ── client log ──');
          for (const l of res.clientLog.split('\n')) console.log(`        | ${l.slice(0, 300)}`);
        }
      }
    }
    if (TARGET === 'remote') {
      // A real outside client: the paying container runs on THIS machine and dials
      // the node's public URI (host ufw opened by the app at deploy).
      const name2 = `outside client from this machine over ${proto} (public URI, no hairpin)`;
      if (outsideBlocked) {
        record('SKIP', name2, 'environment: upstream firewall already detected for this host (see nodes.inspect); nothing spent');
      } else {
        const t1 = Date.now();
        let res2;
        try {
          res2 = await call(`nodes.test ${nodeId} --client here`, 600_000);
        } catch (err) {
          res2 = { ok: false, error: err.message, steps: [] };
        }
        for (const st of res2.steps ?? []) console.log(`        · ${st.slice(0, 150)}`);
        if (res2.ok) record('PASS', name2, `direct reach ${res2.directReach} · ${res2.downloadedBytes} B · revenue ${res2.revenueBefore} → ${res2.revenueAfter}`, Date.now() - t1);
        else if (res2.blockedUpstream) {
          outsideBlocked = true;
          record('SKIP', name2, `environment: ${res2.blockedUpstream}`, Date.now() - t1);
        } else if (res2.unsupported) record('SKIP', name2, `client host limitation: ${res2.unsupported}`, Date.now() - t1);
        else record('FAIL', name2, (res2.error ?? '').split('\n')[0], Date.now() - t1);
        await sleep(TX_GAP_MS);
      }
    }
    await sleep(TX_GAP_MS);
  }
  if (MATRIX.includes('wireguard') === false || MATRIX[MATRIX.length - 1] !== 'wireguard') {
    await check('nodes.setProtocol back to wireguard', async () => {
      const r = await call(`nodes.setProtocol ${nodeId} --service wireguard`, 420_000);
      assert(r.ok, r.error);
      return 'ok';
    });
  }

  // ── P15 HNS ──
  // HNS on → the image routes tunnel DNS (port 53, whatever server the client asked) to the node's
  // split resolver: HNS names → hnsd root + unbound, ICANN names → 1.1.1.1. A paid client then asks
  // 1.1.1.1 for an HNS name through the tunnel. Off is the negative control: the same HNS lookup must
  // fail while ICANN names keep working.
  if (!SKIP_HNS) {
    phase('P15 HNS resolver');
    const hnsTest = async (label, wantHns, extra = '') => {
      const t0 = Date.now();
      let res;
      try {
        res = await call(`nodes.test ${nodeId}${extra}`, 600_000);
      } catch (err) {
        res = { ok: false, error: err.message, steps: [] };
      }
      for (const st of (res.steps ?? []).filter((s) => /HNS_DNS|ICANN_DNS/.test(s))) console.log(`        · ${st.slice(0, 150)}`);
      if (!res.ok) return record('FAIL', label, `session failed: ${(res.error ?? '').split('\n')[0]}`, Date.now() - t0);
      if (res.hnsDns === undefined) return record('FAIL', label, 'the client did not run the HNS probe (no HNS_DNS line)', Date.now() - t0);
      if (res.hnsDns !== wantHns) return record('FAIL', label, `HNS name ${res.hnsDns ? 'resolved' : 'did not resolve'} (want ${wantHns ? 'resolve' : 'fail'})`, Date.now() - t0);
      if (res.icannDns !== true) return record('FAIL', label, 'ICANN name example.com did not resolve through the node', Date.now() - t0);
      return record('PASS', label, `HNS ${res.hnsDns ? 'resolves' : 'does not resolve'} · ICANN resolves · ${res.downloadedBytes} B`, Date.now() - t0);
    };
    // 0.3.5: wait on the sync state the app reports (also proves the reporting); older images: fixed wait.
    const waitSynced = async (label) => {
      const t0 = Date.now();
      let st;
      while (Date.now() - t0 < 15 * 60_000) {
        st = await call(`nodes.status ${nodeId}`, 60_000).catch(() => null);
        const s = st?.hnsSync?.state;
        if (s === 'synced') return record('PASS', `${label}: app reports HNS synced`, `${Math.round((Date.now() - t0) / 1000)} s · height ${st.hnsSync.height}`, Date.now() - t0);
        if (s === 'unknown' || s === undefined) { await sleep(HNS_SYNC_MS); return record('SKIP', `${label}: app reports HNS synced`, `no sync status (image before 0.3.5): waited ${HNS_SYNC_MS / 1000} s`); }
        if (s === 'stalled') return record('FAIL', `${label}: app reports HNS synced`, `stalled: ${JSON.stringify(st.hnsSync)}`, Date.now() - t0);
        await sleep(10_000);
      }
      return record('FAIL', `${label}: app reports HNS synced`, `not synced in 15 min: ${JSON.stringify(st?.hnsSync)}`, Date.now() - t0);
    };
    const on = await check('nodes.setHns on → hnsd running and users\' DNS routed (≤ 12 min sync)', async () => {
      const r = await call(`nodes.setHns ${nodeId} on`, 420_000);
      assert(r.ok !== false, r.error ?? JSON.stringify(r).slice(0, 160));
      const until = Date.now() + 12 * 60_000;
      let st;
      while (Date.now() < until) {
        st = await call(`nodes.status ${nodeId}`, 60_000);
        if (st?.hnsdRunning && st?.hnsRouting) return 'hnsd running · routing on';
        await sleep(20_000);
      }
      throw new Error(`not routing after 12 min: hnsdRunning=${st?.hnsdRunning} hnsRouting=${st?.hnsRouting}`);
    });
    if (on) {
      await waitSynced('HNS on (fresh sync)');
      for (const proto of HNS_MATRIX) {
        if (proto !== 'wireguard') {
          const sw = await check(`nodes.setProtocol ${proto} keeps HNS on`, async () => {
            const r = await call(`nodes.setProtocol ${nodeId} --service ${proto}`, 420_000);
            assert(r.ok, r.error);
            const st = await call(`nodes.status ${nodeId}`, 60_000);
            assert(st?.hnsRouting, `hnsRouting=${st?.hnsRouting} after the protocol switch`);
            return 'routing on';
          });
          if (!sw) continue;
          await waitSynced(`after switch to ${proto} (checkpoint)`);
        }
        await hnsTest(`HNS name resolves through a ${proto} tunnel (ICANN still resolves)`, true);
        await sleep(TX_GAP_MS);
      }
      if (HNS_MATRIX[HNS_MATRIX.length - 1] !== 'wireguard') {
        await check('nodes.setProtocol back to wireguard (HNS)', async () => {
          const r = await call(`nodes.setProtocol ${nodeId} --service wireguard`, 420_000);
          assert(r.ok, r.error);
          return 'ok';
        });
      }
    }
    await check('nodes.setHns off → hnsd stopped, routing off', async () => {
      const r = await call(`nodes.setHns ${nodeId} off`, 420_000);
      assert(r.ok !== false, r.error ?? JSON.stringify(r).slice(0, 160));
      await sleep(20_000);
      const st = await call(`nodes.status ${nodeId}`, 60_000);
      assert(!st?.hnsRouting, `hnsRouting still ${st?.hnsRouting}`);
      return 'off';
    });
    // Negative control: the same probe with HNS off must fail the HNS name and keep ICANN working.
    await hnsTest('HNS off: HNS name fails through the tunnel, ICANN still resolves (negative control)', false, ' --hns-probe');
    await sleep(TX_GAP_MS);
  }

  await check('nodes.positions + nodes.redemptions show the paid sessions', async () => {
    const ps = await call(`nodes.positions ${nodeId}`, 120_000);
    const rd = await call(`nodes.redemptions ${nodeId}`, 120_000);
    const rdCount = Array.isArray(rd) ? rd.length : Array.isArray(rd?.redemptions) ? rd.redemptions.length : 0;
    assert(ps.length > 0, 'no positions watched after paid sessions');
    assert(rdCount > 0, `no redemptions recorded: ${JSON.stringify(rd).slice(0, 120)}`);
    return `${ps.length} positions · ${rdCount} redemptions`;
  });

  // ── P8 ──
  phase('P8 pricing');
  await check('nodes.updatePricing → three prices on chain', async () => {
    const r = await call(`nodes.updatePricing --nodeId ${nodeId} --gb 0.003 --hr 0.002 --lease 0.0015`, 420_000);
    assert(r.ok, r.error);
    const c = await chain(nodeId);
    assert(c.prices.perGb === 3000 && c.prices.perHour === 2000 && c.prices.leasePerHour === 1500, JSON.stringify(c.prices));
    return JSON.stringify(c.prices);
  });
  await check('prices survive nodes.restart (config is the source of truth)', async () => {
    await call(`nodes.restart ${nodeId}`, 180_000);
    await sleep(45_000);
    const c = await chain(nodeId);
    assert(c.prices.perGb === 3000 && c.prices.perHour === 2000 && c.prices.leasePerHour === 1500, JSON.stringify(c.prices));
    return 'unchanged';
  });

  // ── P9 ──
  phase('P9 withdraw');
  await check('nodes.withdraw → revenue lands in the wallet', async () => {
    const c = await chain(nodeId);
    const w0 = await call('wallet.refreshBalance', 60_000);
    await sleep(TX_GAP_MS);
    const r = await call(`nodes.withdraw --nodeId ${nodeId}`, 300_000);
    if (c.revenue === 0) {
      assert(r.ok === false && /nothing to withdraw/i.test(r.error ?? ''), `no revenue, expected a clean refusal: ${JSON.stringify(r)}`);
      return 'no revenue (every paid session skipped on this host) → clean "nothing to withdraw"';
    }
    assert(r.ok, r.error);
    await sigConfirmed(r.txHash);
    await sleep(5_000);
    const w1 = await call('wallet.refreshBalance', 60_000);
    const c1 = await chain(nodeId);
    assert(c1.revenue === 0, `revenue left ${c1.revenue}`);
    const gained = Math.round((w1.balanceDVPN - w0.balanceDVPN) * 1e6);
    assert(gained >= c.revenue, `wallet +${gained} base units, revenue was ${c.revenue}`);
    return `revenue ${c.revenue} → 0 · wallet +${gained} base units`;
  });

  // ── P10 ──
  phase('P10 lifecycle');
  await check('nodes.stop → container down', async () => {
    await call(`nodes.stop ${nodeId}`, 120_000);
    const n = await call(`nodes.get ${nodeId}`);
    assert(n.status === 'offline', `status ${n.status}`);
    return 'offline';
  });
  await check('nodes.start → daemon up, node listed and unexpired', async () => {
    await call(`nodes.start ${nodeId}`, 180_000);
    for (let i = 0; i < 20; i++) {
      await sleep(6_000);
      const st = await call(`nodes.status ${nodeId}`, 180_000);
      const c = await chain(nodeId);
      if (st.reachable && c.status === 1 && c.listedAt + 86_400 > Date.now() / 1000) {
        return `listed until ${new Date((c.listedAt + 86_400) * 1000).toISOString()}`;
      }
    }
    throw new Error('daemon not ready / node not listed within 120 s');
  });
  await check('nodes.relist → fresh listedAt on chain', async () => {
    const before = (await chain(nodeId)).listedAt;
    await sleep(TX_GAP_MS);
    const r = await call(`nodes.relist ${nodeId}`, 180_000);
    assert(r.ok, r.error);
    for (let i = 0; i < 10; i++) {
      await sleep(5_000);
      const after = (await chain(nodeId)).listedAt;
      if (after > before) return `listedAt ${before} → ${after}`;
    }
    throw new Error(`listedAt did not advance from ${before}`);
  });
  await sleep(TX_GAP_MS);
  await check('nodes.closeSession rejects an unknown session cleanly', async () => {
    const r = await call(`nodes.closeSession ${nodeId} --id 00000000-0000-0000-0000-000000000000`, 60_000);
    assert(r.ok === false && r.error, JSON.stringify(r));
    assertNotFound(r.error);
    return r.error.slice(0, 100);
  });
  await check('nodes.redeem (nothing outstanding is fine)', async () => {
    const r = await call(`nodes.redeem ${nodeId}`, 240_000);
    assert(r.ok || /nothing|no position|threshold/i.test(r.error ?? ''), r.error);
    return r.ok ? JSON.stringify(r.result).slice(0, 100) : r.error;
  });

  // ── P11 ──
  phase('P11 test channels');
  await check('nodes.sweepTestChannels (start-close)', async () => {
    const r = await call('nodes.sweepTestChannels', 600_000);
    assert(r.errors.length === 0, r.errors.join('; '));
    return `closing ${r.startedClose.length} · closed ${r.closed.length} · waiting ${r.pending.length}`;
  });

  // The live node's own directory must survive a leftover scan: it is claimed by a
  // record, and a scan that deleted it would destroy the node key. This runs BEFORE
  // removal precisely so there is a claimed directory to protect.
  await check('nodes.cleanHostLeftovers spares a directory a record still claims', async () => {
    // sshFlag already carries its leading space and is '' for a local target.
    const r = await call(`nodes.cleanHostLeftovers --dry-run${sshFlag}`, 180_000);
    const mine = r.found.filter((f) => f.nodeId === nodeId);
    assert(mine.length === 0, `the live node's own directory was listed as a leftover: ${JSON.stringify(mine)}`);
    const deletable = r.found.filter((f) => f.removed);
    assert(deletable.length === 0, `a dry run must delete nothing, got ${deletable.length}`);
    return `host ${r.host} · ${r.found.length} untracked director${r.found.length === 1 ? 'y' : 'ies'}, live node spared`;
  });

  await sleep(TX_GAP_MS);

  // ── P12 ──
  if (KEEP) {
    phase('P12 remove');
    record('SKIP', 'removal (--keep)');
  } else {
    phase('P12 remove');
    const remoteProbe = TARGET === 'remote' && opt('ssh-host');
    if (remoteProbe) {
      await check('leftover probe sees the live node (positive control)', async () => {
        const seen = await remoteLeftovers(nodeId, node.port, { full: true });
        assert(seen.some((x) => x.startsWith('container')), `probe found no container for the running node: ${seen.join('; ') || 'nothing'}`);
        assert(seen.some((x) => x.startsWith('node folder')), 'probe found no node folder for the running node');
        if (node.firewallOpened) assert(seen.some((x) => x.startsWith('ufw rules')), 'app says ufw is open but the probe found no rule');
        return seen.join(' · ');
      });
    }
    await check('nodes.remove → delisted, closed, bond unbonding', async () => {
      await call(`nodes.remove ${nodeId}`, 60_000);
      for (let i = 0; i < 40; i++) {
        await sleep(8_000);
        const n = await call(`nodes.get ${nodeId}`);
        if (!n) throw new Error('node vanished before unbonding');
        if (n.removalStage === 'unbonding') {
          const acc = await accountInfo(node.nodePda);
          assert(acc === null, 'node account still exists after close_node');
          const ub = await accountInfo(n.unbondingPda);
          assert(ub && ub.owner === PROGRAM_ID, 'no unbonding account');
          const st = state.nodes.find((x) => x.nodeId === nodeId);
          st.unbondsAt = n.unbondsAt;
          await saveState(state);
          return `node account closed · unbonding ${n.unbondingPda} until ${n.unbondsAt}`;
        }
      }
      throw new Error('did not reach the unbonding stage');
    });
    if (remoteProbe) {
      await check('no node container left on the host after removal', async () => {
        const left = await remoteLeftovers(nodeId, node.port, { full: false });
        assert(left.length === 0, `left behind: ${left.join('; ')}`);
        return 'container gone (folder + ufw are checked after --finish)';
      });
    }
    record('SKIP', 'bond withdrawal + key sweep + channel refunds', 'time-gated: run with --finish after unbonding (1 h) and channel grace (2 h)');
  }
  await report();
}

async function finish(state, wallet) {
  phase('P13 finish');
  // The app's poller completes removals on its own once a bond unlocks
  // (withdraw bond → sweep key → forget node). This phase drives what is left
  // and verifies the end state ON CHAIN — not via the wallet balance, which
  // other projects sharing the test wallet move concurrently.
  if (opt('ssh-host')) {
    await check(`nodes.reconnect ${opt('ssh-host')} (memory-only creds after app restart)`, async () => {
      const keyPath = opt('ssh-key');
      const r = await call(
        `nodes.reconnect --ssh-host ${opt('ssh-host')} --ssh-user ${opt('ssh-user', 'root')} --ssh-port ${opt('ssh-port', '22')}${keyPath ? ` --ssh-key-file "${path.resolve(keyPath).split(path.sep).join('/')}"` : ''}`,
        120_000,
      );
      assert(r.ok, r.error);
      return `${r.nodes.length} node(s) re-attached: ${r.nodes.join(', ')}`;
    });
    await sleep(20_000); // let resumed removals advance
  }
  for (const s of state.nodes.filter((n) => !n.finished)) {
    let n = await call(`nodes.get ${s.nodeId}`).catch(() => null);
    if (n) {
      s.operatorAddress = n.operatorAddress;
      s.nodePda = n.nodePda ?? s.nodePda;
      s.unbondingPda = n.unbondingPda ?? s.unbondingPda;
      await saveState(state);
    }
    if (n && !n.removalStage) {
      await check(`nodes.remove ${s.moniker} (kept node) → removal started`, async () => {
        await call(`nodes.remove ${s.nodeId}`, 60_000);
        return 'redeem → stop → delist → close running';
      });
      continue;
    }
    // A removal mid-flight (redeem/stop/delist/close) settles into 'unbonding' (time-gated)
    // or completes; wait for one of those before judging.
    for (let i = 0; i < 30 && n && n.removalStage && !['unbonding', 'withdraw-bond', 'sweep', 'done'].includes(n.removalStage); i++) {
      await sleep(8_000);
      n = await call(`nodes.get ${s.nodeId}`).catch(() => null);
    }
    if (n) {
      s.unbondingPda = n.unbondingPda ?? s.unbondingPda;
      await saveState(state);
    }
    if (n && n.removalStage === 'unbonding' && Date.parse(n.unbondsAt) > Date.now()) {
      record('SKIP', `node ${s.moniker} still unbonding`, `until ${n.unbondsAt}`);
      continue;
    }
    if (n) {
      await check(`${s.moniker}: bond withdrawn, key swept, node forgotten`, async () => {
        if (n.removalStage === 'unbonding') {
          const r = await call(`nodes.withdrawBond ${s.nodeId}`, 600_000);
          assert(r.ok, r.error);
        }
        for (let i = 0; i < 40 && n; i++) {
          await sleep(6_000);
          n = await call(`nodes.get ${s.nodeId}`).catch(() => null);
        }
        assert(!n, `still present at stage ${n?.removalStage}`);
        return 'removed';
      });
    }
    if (s.target === 'remote' && opt('ssh-host') && Number.isInteger(s.port)) {
      await check(`${s.moniker}: nothing left on the host (container, node folder, ufw rules)`, async () => {
        let left = await remoteLeftovers(s.nodeId, s.port, { full: true });
        // A ufw rule covers a port range, and the app keeps it while another live node on this host
        // holds the same ports (0aba731). That rule is the other node's, not a leftover; the other
        // node's own finish check proves it goes away.
        let heldBy = '';
        if (left.some((x) => x.startsWith('ufw rules'))) {
          const all = (await call('nodes.list').catch(() => [])) ?? [];
          const holder = all.find((n) => n.id !== s.nodeId && n.target === 'remote' && n.host === opt('ssh-host') && n.port === s.port && n.firewallOpened);
          if (holder) {
            left = left.filter((x) => !x.startsWith('ufw rules'));
            heldBy = ` (ufw rule for ${s.port} kept: live node ${holder.moniker} uses it)`;
          }
        }
        assert(left.length === 0, `left behind: ${left.join('; ')}`);
        return `host clean${heldBy}`;
      });
    }
    if (!s.operatorAddress && s.preFund) {
      // Deploy failed before the funding step (the app log's stage), so no key ever held money.
      record('PASS', `${s.moniker}: nothing on chain — deploy failed before funding`, s.preFund);
      s.finished = true;
      await saveState(state);
      continue;
    }
    await check(`${s.moniker}: on chain — node + unbonding closed, key emptied`, async () => {
      assert(s.operatorAddress, 'node key unknown (run predates address recording)');
      const lamports = (await rpc('getBalance', [s.operatorAddress, { commitment: 'confirmed' }])).value;
      assert(lamports <= 5_000, `node key still holds ${lamports} lamports`);
      const tokens = await rpc('getTokenAccountsByOwner', [s.operatorAddress, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }]);
      assert(tokens.value.length === 0, `node key still has ${tokens.value.length} token account(s)`);
      if (s.nodePda) assert((await accountInfo(s.nodePda)) === null, 'node account still open');
      if (s.unbondingPda) assert((await accountInfo(s.unbondingPda)) === null, 'unbonding account still open');
      s.finished = true;
      await saveState(state);
      return `key ${lamports} lamports, 0 token accounts${s.nodePda ? ', node closed' : ''}${s.unbondingPda ? ', unbonding closed' : ''}`;
    });
    await sleep(TX_GAP_MS);
  }
  await check('nodes.sweepTestChannels (close + refund)', async () => {
    const r = await call('nodes.sweepTestChannels', 900_000);
    assert(r.errors.length === 0, r.errors.join('; '));
    return `closed ${r.closed.length} · refunded ${r.withdrawnBase} base units · still waiting ${r.pending.length}`;
  });
  await check('final wallet balance', async () => {
    const w = await call('wallet.refreshBalance', 60_000);
    return `${w.balanceSOL.toFixed(4)} SOL · ${w.balanceDVPN} tDVPN (${wallet.address})`;
  });
  await report();
}

async function report() {
  phase('P14 report');
  await check('system.exportDiagnostics', async () => {
    const r = await call('system.exportDiagnostics', 60_000);
    assert(r.ok, r.error);
    return r.path;
  });
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const base = path.join(REPORT_DIR, `e2e-${RUN_ID}${FINISH ? '-finish' : ''}`);
  const rpcLine = `verification RPC ${hostOf(RPC)}: ${rpcStats.requests} requests · ${rpcStats.rateLimited} × 429 · ${rpcStats.movedToPublic} moved to public devnet`;
  await fs.writeFile(`${base}.json`, JSON.stringify({ runId: RUN_ID, target: TARGET, finish: FINISH, pass, fail, skip, rpc: { host: hostOf(RPC), ...rpcStats }, results }, null, 2));
  const md = [
    `# E2E ${RUN_ID}${FINISH ? ' (finish)' : ''} — target ${TARGET}`,
    '',
    `**${pass} pass · ${fail} fail · ${skip} skip**`,
    '',
    rpcLine,
    '',
    '| phase | check | result | detail |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.phase} | ${r.check} | ${r.status} | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
    '',
  ].join('\n');
  await fs.writeFile(`${base}.md`, md);
  console.log(`\n\x1b[1mRESULT: ${pass} pass · ${fail} fail · ${skip} skip\x1b[0m   report: ${base}.md`);
  console.log(rpcLine);
  cli.close();
  process.exitCode = fail ? 1 : 0;
}

main().catch(async (err) => {
  console.error(`\nE2E aborted: ${err.message}`);
  try {
    await report();
  } catch (rerr) {
    console.error('report failed:', rerr.message);
  }
  process.exitCode = 1;
});
