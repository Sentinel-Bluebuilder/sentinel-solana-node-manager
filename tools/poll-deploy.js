#!/usr/bin/env node
'use strict';

// Single-connection deploy poller. Opens the CLI pipe once, sends
// `deploy.status <jobId>` every INTERVAL_MS, prints one compact line per
// status update, and exits at a terminal phase (ready / error / cancelled).
//
// Usage: node tools/poll-deploy.js <jobId> [intervalMs]

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP_NAME = 'sentinel-node-manager';
const jobId = process.argv[2];
const INTERVAL_MS = Number(process.argv[3] || 4000);

if (!jobId) {
  console.error('usage: node tools/poll-deploy.js <jobId> [intervalMs]');
  process.exit(2);
}

function userDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

const ep = process.env.SENTINEL_NODE_MANAGER_CLI_ENDPOINT
  || JSON.parse(fs.readFileSync(path.join(userDataDir(), 'cli-endpoint.json'), 'utf8')).endpoint;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);
const yellow = (s) => c('33', s);

const TERMINAL = new Set(['ready', 'error', 'cancelled']);
let lastSerialized = '';
let pending = false;
let exiting = false;
let timer = null;

const sock = net.createConnection(ep);
let buf = '';

sock.on('error', (err) => {
  console.error(red('connection error:'), err.message);
  process.exit(1);
});

sock.on('connect', () => {
  console.error(dim(`connected to ${ep}`));
  send({ type: 'hello', client: 'shell' });
});

sock.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});

sock.on('close', () => {
  if (timer) clearInterval(timer);
  process.exit(exiting ? 0 : 1);
});

function send(obj) {
  sock.write(JSON.stringify(obj) + '\n');
}

function poll() {
  if (pending) return;
  pending = true;
  send({ type: 'run', line: `deploy.status ${jobId}` });
}

function handle(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type === 'welcome') {
    if (msg.mode !== 'active') {
      console.error(red('another CLI client is active. close it and retry.'));
      exiting = true;
      send({ type: 'bye' });
      return;
    }
    console.error(cyan(`polling job ${jobId} every ${INTERVAL_MS}ms`));
    poll();
    timer = setInterval(poll, INTERVAL_MS);
    return;
  }

  if (msg.type === 'event' && msg.event && msg.event.kind === 'ok' && msg.event.text) {
    let frame;
    try { frame = JSON.parse(msg.event.text); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    const sig = `${frame.phase}|${frame.percent}|${frame.message || ''}`;
    if (sig === lastSerialized) return;
    lastSerialized = sig;
    const ts = new Date().toTimeString().slice(0, 8);
    const tone = frame.phase === 'ready' ? green
      : frame.phase === 'error' || frame.phase === 'cancelled' ? red
      : yellow;
    const pct = frame.percent != null ? `${String(frame.percent).padStart(3)}%` : '   ';
    console.log(`${dim(`[${ts}]`)} ${tone(frame.phase.padEnd(12))} ${pct}  ${frame.message || ''}`);
    if (TERMINAL.has(frame.phase)) {
      console.log('');
      console.log(JSON.stringify(frame, null, 2));
      if (timer) clearInterval(timer);
      exiting = true;
      send({ type: 'bye' });
      sock.end();
    }
    return;
  }

  if (msg.type === 'result') {
    pending = false;
    return;
  }

  if (msg.type === 'goodbye') {
    exiting = true;
  }
}

process.on('SIGINT', () => {
  exiting = true;
  if (timer) clearInterval(timer);
  send({ type: 'bye' });
  sock.end();
});
