#!/usr/bin/env node
/**
 * Universal end-to-end test runner.
 *
 *   npm run test:universal
 *
 * Runs every test surface this repo ships:
 *   1. tsc --noEmit    (both projects)
 *   2. vitest run      (unit + renderer; auto-rebuild better-sqlite3 for node ABI)
 *   3. CLI e2e harness (spends devnet SOL + tDVPN from the test wallet — gated;
 *      only runs if the app's CLI pipe is already open AND --skip-money is NOT passed)
 *   4. better-sqlite3 is restored to the Electron ABI on exit, so the
 *      app keeps working after the test run.
 *
 * Flags:
 *   --skip-money     skip the CLI e2e (no devnet tDVPN spent)
 *   --skip-rebuild   skip the better-sqlite3 ABI toggle (faster but flakier)
 *   --skip-typecheck skip tsc
 *
 * Exit codes:
 *   0  every section passed
 *   1  one or more sections failed
 *   2  setup error (couldn't even start)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { platform } from 'node:os';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const args = process.argv.slice(2);
const flags = {
  skipMoney: args.includes('--skip-money'),
  skipRebuild: args.includes('--skip-rebuild'),
  skipTypecheck: args.includes('--skip-typecheck'),
};

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
function discoverPipe() {
  if (process.env.SENTINEL_NODE_MANAGER_CLI_ENDPOINT) return process.env.SENTINEL_NODE_MANAGER_CLI_ENDPOINT;
  const dir =
    platform() === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'sentinel-node-manager-solana')
      : platform() === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'sentinel-node-manager-solana')
        : path.join(os.homedir(), '.config', 'sentinel-node-manager-solana');
  try {
    return JSON.parse(readFileSync(path.join(dir, 'cli-endpoint.json'), 'utf8')).endpoint;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('cli-endpoint.json unreadable:', err.message);
    return platform() === 'win32' ? `\\\\.\\pipe\\sentinel-node-manager-solana-${process.env.USERNAME ?? 'default'}` : `${os.homedir()}/.sentinel-node-manager-solana/cli.sock`;
  }
}
const PIPE = discoverPipe();

function header(s) {
  console.log(`\n${C.bold}${C.cyan}═══ ${s} ═══${C.reset}`);
}
function pass(s) {
  console.log(`  ${C.green}✓${C.reset} ${s}`);
}
function fail(s) {
  console.log(`  ${C.red}✗${C.reset} ${s}`);
}
function skip(s) {
  console.log(`  ${C.yellow}–${C.reset} ${s} ${C.dim}(skipped)${C.reset}`);
}
function info(s) {
  console.log(`  ${C.dim}${s}${C.reset}`);
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    // On Windows, npm/npx are .cmd files which Node cannot spawn directly
    // without `shell: true` (or by spelling out the .cmd extension and using
    // shell: true regardless on modern Node). Use shell mode universally.
    const child = spawn(cmd, argv, {
      stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: true,
      env: { ...process.env, FORCE_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    if (opts.silent) {
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
    }
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

async function pipeOpen() {
  return new Promise((resolve) => {
    const sock = net.createConnection(PIPE);
    const done = (ok) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
}

// Sanity: must be run from repo root.
if (!existsSync('package.json') || !existsSync('tests/e2e/cli-e2e.mjs')) {
  console.error(`${C.red}universal.mjs must be run from the repo root.${C.reset}`);
  process.exit(2);
}

console.log(`${C.bold}Sentinel Node Manager — universal test${C.reset}`);
console.log(`${C.dim}flags: ${JSON.stringify(flags)}${C.reset}`);

// ─── 1. typecheck ─────────────────────────────────────────────────────────
if (flags.skipTypecheck) {
  header('1/4 typecheck');
  skip('npm run typecheck');
  record('typecheck', true, 'skipped');
} else {
  header('1/4 typecheck (tsc — both projects)');
  const r = await run('npm', ['run', 'typecheck']);
  if (r.code === 0) {
    pass('npm run typecheck');
    record('typecheck', true);
  } else {
    fail('npm run typecheck');
    record('typecheck', false, `exit ${r.code}`);
  }
}

// ─── 2. vitest ────────────────────────────────────────────────────────────
header('2/4 vitest (unit + renderer)');
let rebuiltForNode = false;
if (!flags.skipRebuild) {
  info('rebuilding better-sqlite3 for Node ABI…');
  const r = await run('npm', ['run', 'rebuild:node'], { silent: true });
  if (r.code === 0) {
    rebuiltForNode = true;
    pass('better-sqlite3 → Node ABI');
  } else {
    info(`rebuild:node exited ${r.code} (vitest may report sqlite failures) — proceeding anyway`);
  }
}
const vRes = await run('npm', ['test']);
if (vRes.code === 0) {
  pass('npm test');
  record('vitest', true);
} else {
  fail('npm test');
  record('vitest', false, `exit ${vRes.code}`);
}

if (rebuiltForNode) {
  info('restoring better-sqlite3 to Electron ABI…');
  const r = await run('npm', ['run', 'rebuild:electron'], { silent: true });
  if (r.code === 0) pass('better-sqlite3 → Electron ABI');
  else info(`${C.yellow}rebuild:electron exited ${r.code}${C.reset} — run \`npm run rebuild:electron\` manually before next \`npm run dev\``);
}

// ─── 3. CLI e2e (real-money) ──────────────────────────────────────────────
header('3/4 CLI e2e harness (real-money mainnet)');
if (flags.skipMoney) {
  skip('--skip-money set');
  record('cli-e2e', true, 'skipped');
} else {
  const open = await pipeOpen();
  if (!open) {
    fail(`pipe ${PIPE} is not accepting connections`);
    info('Start the app with `npm run dev`, sign in, open the in-app CLI screen,');
    info('and click "Start". Then re-run this command.');
    record('cli-e2e', false, 'pipe not open');
  } else {
    pass(`pipe ${PIPE} is open`);
    const r = await run('npm', ['run', 'test:e2e']);
    if (r.code === 0) {
      pass('CLI e2e harness');
      record('cli-e2e', true);
    } else {
      fail('CLI e2e harness');
      record('cli-e2e', false, `exit ${r.code}`);
    }
  }
}

// ─── 4. summary ───────────────────────────────────────────────────────────
header('4/4 summary');
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
for (const r of results) {
  const tag = r.ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
  const detail = r.detail ? ` ${C.dim}(${r.detail})${C.reset}` : '';
  console.log(`  ${tag}  ${r.name}${detail}`);
}
console.log(`\n  ${C.bold}${passed} passed · ${failed} failed${C.reset}`);
process.exit(failed === 0 ? 0 : 1);
