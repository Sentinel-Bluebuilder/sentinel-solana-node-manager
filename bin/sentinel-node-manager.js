#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sentinel-node-manager — standalone CLI client for the running desktop app.
 *
 * Connects to the local CLI server exposed by Sentinel Node Manager over a
 * Windows named pipe or a unix domain socket. The app must be running
 * AND have the CLI server enabled (the in-app CLI screen has a "Start
 * server" button, or pre-enable it from settings).
 *
 * Usage:
 *   sentinel-node-manager            # interactive shell (default)
 *   sentinel-node-manager --agent    # connect as an AI agent
 *   sentinel-node-manager -e "cmd"   # run one command and exit
 *
 * Discovery:
 *   The app writes a JSON descriptor to its userData directory:
 *     Win:  %APPDATA%\sentinel-node-manager-solana\cli-endpoint.json
 *     mac:  ~/Library/Application Support/sentinel-node-manager-solana/cli-endpoint.json
 *     lin:  ~/.config/sentinel-node-manager-solana/cli-endpoint.json
 *   Override with SENTINEL_NODE_MANAGER_CLI_ENDPOINT=<pipe|socket-path>.
 */

'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const APP_NAME = 'sentinel-node-manager-solana';

const argv = process.argv.slice(2);
const flags = {
  agent: argv.includes('--agent'),
  help: argv.includes('-h') || argv.includes('--help'),
  oneShot: null,
};
{
  const i = argv.findIndex((a) => a === '-e' || a === '--exec');
  if (i >= 0) flags.oneShot = argv[i + 1] ?? '';
}

if (flags.help) {
  console.log(
    [
      'sentinel-node-manager — CLI client for Sentinel Node Manager',
      '',
      'Usage:',
      '  sentinel-node-manager              interactive shell',
      '  sentinel-node-manager --agent      connect as agent (single-active lock still applies)',
      '  sentinel-node-manager -e "cmd"     run one command then exit',
      '  sentinel-node-manager --help       this help',
      '',
      'Env:',
      '  SENTINEL_NODE_MANAGER_CLI_ENDPOINT  override the discovered pipe/socket path',
    ].join('\n'),
  );
  process.exit(0);
}

// ─── colors (no deps) ────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const cyan = (s) => c('36', s);
const bold = (s) => c('1', s);

// ─── endpoint discovery ──────────────────────────────────────────────────────

function userDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

function discover() {
  const override =
    process.env.SENTINEL_NODE_MANAGER_CLI_ENDPOINT ||
    process.env.SENTINEL_DVPN_CLI_ENDPOINT;
  if (override) return { endpoint: override, source: 'env' };
  const file = path.join(userDataDir(), 'cli-endpoint.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.endpoint === 'string' && parsed.endpoint.length > 0) {
      return { endpoint: parsed.endpoint, source: file };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(dim(`discovery file unreadable: ${err.message}`));
  }
  return null;
}

// ─── connect ─────────────────────────────────────────────────────────────────

const found = discover();
if (!found) {
  console.error(red('error:'), 'CLI server not running.');
  console.error('Open the desktop app, go to the CLI screen, and click "Start server".');
  console.error('Or set SENTINEL_NODE_MANAGER_CLI_ENDPOINT to the pipe/socket path.');
  process.exit(2);
}

console.error(dim(`connecting to ${found.endpoint}…`));

const socket = net.createConnection(found.endpoint);
let mode = null; // 'active' | 'watcher'
let exiting = false;
let pending = false; // a 'run' is in flight
const queued = []; // lines received while a run is in flight (piped stdin)
let rl = null;

socket.on('error', (err) => {
  console.error(red('connection error:'), err.message);
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    console.error('Is the desktop app running with the CLI server started?');
  }
  process.exit(1);
});

socket.on('connect', () => {
  send({ type: 'hello', client: flags.agent ? 'agent' : 'shell' });
});

// ─── line buffer ─────────────────────────────────────────────────────────────

let buf = '';
socket.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handleMessage(line);
  }
});

socket.on('close', () => {
  if (!exiting) console.error(dim('\nconnection closed.'));
  if (rl) rl.close();
  process.exit(exiting ? (process.exitCode ?? 0) : 1);
});

function send(obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch (err) {
    console.error(red('write failed:'), err.message);
  }
}

// ─── message handlers ────────────────────────────────────────────────────────

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error(red('malformed message from server:'), raw);
    return;
  }

  if (msg.type === 'welcome') {
    mode = msg.mode === 'watcher' ? 'watcher' : 'active';
    const banner =
      mode === 'active'
        ? bold(green('● active')) + dim(` — session ${msg.sessionStartedAt || ''}`)
        : bold(yellow('● watcher')) + dim(' — another client holds the lock; commands disabled');
    console.error(banner);
    if (flags.oneShot != null && mode === 'active') {
      send({ type: 'run', line: flags.oneShot });
      pending = true;
      return;
    }
    if (flags.oneShot != null && mode === 'watcher') {
      console.error(red('cannot exec: another client is active.'));
      exiting = true;
      process.exitCode = 3;
      send({ type: 'bye' });
      return;
    }
    startRepl();
    return;
  }

  if (msg.type === 'busy') {
    console.error(yellow(`busy: held by ${msg.holder}. you are read-only.`));
    return;
  }

  if (msg.type === 'event') {
    printEvent(msg.event);
    return;
  }

  if (msg.type === 'result') {
    pending = false;
    // Our own output comes from the result (unscrubbed — the broadcast events are
    // redacted for watchers, which would turn a freshly created mnemonic into ***).
    if (msg.ok) {
      if (msg.text) console.log(msg.text);
    } else {
      console.log(red(msg.error || 'error'));
    }
    if (flags.oneShot != null) {
      exiting = true;
      send({ type: 'bye' });
      process.exitCode = msg.ok ? 0 : 1;
      return;
    }
    if (queued.length > 0) {
      pending = true;
      send({ type: 'run', line: queued.shift() });
      return;
    }
    if (rl) rl.prompt();
    return;
  }

  if (msg.type === 'goodbye') {
    exiting = true;
    return;
  }
}

function printEvent(ev) {
  if (!ev) return;
  const tag = `[${ev.source}]`;
  const own = mode === 'active' && ev.source === (flags.agent ? 'agent' : 'shell');
  switch (ev.kind) {
    case 'input':
      // Don't echo our own input back.
      if (own || (mode !== 'watcher' && ev.source !== 'system')) return;
      console.log(dim(tag), cyan(ev.text));
      return;
    case 'ok':
      if (own) return; // printed from the result
      if (ev.text) console.log(dim(tag), ev.text);
      return;
    case 'err':
      if (own) return;
      console.log(dim(tag), red(ev.text || 'error'));
      return;
    case 'info':
    default:
      console.log(dim(tag), dim(ev.text));
      return;
  }
}

// ─── repl ────────────────────────────────────────────────────────────────────

function startRepl() {
  if (mode === 'watcher') {
    // Watchers just stream — no prompt. Ctrl+C exits.
    process.on('SIGINT', () => {
      exiting = true;
      send({ type: 'bye' });
      socket.end();
    });
    return;
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: bold(cyan('sentinel> ')),
    terminal: process.stdout.isTTY,
  });

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line === 'exit' || line === 'quit') {
      exiting = true;
      send({ type: 'bye' });
      rl.close();
      socket.end();
      return;
    }
    if (pending) {
      // Piped input arrives faster than results: queue and drain in order.
      queued.push(line);
      return;
    }
    pending = true;
    send({ type: 'run', line });
  });

  rl.on('SIGINT', () => {
    console.error(dim('\n(use exit/quit to leave)'));
    rl.prompt();
  });

  rl.on('close', () => {
    if (!exiting) {
      exiting = true;
      send({ type: 'bye' });
      socket.end();
    }
  });

  rl.prompt();
}
