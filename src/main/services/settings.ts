import { app } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS, DEFAULT_RPC_POOL } from './chain';
import { httpRpcHostAllowed } from './validate';
import type { AppSettings } from '../../shared/types';

let cache: AppSettings | null = null;

const emitter = new EventEmitter();

/**
 * Subscribe to settings changes. Fires after `updateSettings` writes the
 * new settings to disk so pollers can react (e.g. re-arm at the new
 * cadence). Returns an unsubscribe function.
 */
export function onSettingsChanged(handler: (next: AppSettings) => void): () => void {
  emitter.on('changed', handler);
  return () => emitter.off('changed', handler);
}

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * Patched sentinel-solana `upstream/` tree — the node image build context
 * (docker/dvpnd.Dockerfile). Devnet test setup on this machine.
 */
function defaultUpstreamDir(): string {
  return path.join(app.getPath('home'), 'Desktop', 'sentinel-solana', 'upstream');
}

function defaults(): AppSettings {
  return {
    rpcUrls: [...DEFAULT_RPC_POOL],
    priorityFeeMicroLamports: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
    upstreamDir: defaultUpstreamDir(),
    dockerSocket: '',
    seenOnboarding: false,
    minimizeToTrayOnClose: true,
    stopNodesOnQuit: false,
    trayHintShown: false,
    stopCliServerOnQuit: true,
    walletRefreshIntervalSec: 60,
    nodeRefreshIntervalSec: 60,
  };
}

const WALLET_REFRESH_MIN_SEC = 10;
const WALLET_REFRESH_MAX_SEC = 600;
const NODE_REFRESH_MIN_SEC = 15;
const NODE_REFRESH_MAX_SEC = 600;
const PRIORITY_FEE_MAX = 10_000_000;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(file(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = { ...defaults(), ...parsed };
    // Normalize: strip empty strings from rpc pool, drop any non-https
    // entries (and any non-loopback http) — defence against a hand-edited
    // settings.json. isValidRpcUrl is defined later but lifted here at runtime.
    cache.rpcUrls = (Array.isArray(cache.rpcUrls) ? cache.rpcUrls : [])
      .filter((u): u is string => typeof u === 'string')
      .filter((u) => u && u.trim())
      .map((u) => u.trim())
      .filter(isValidRpcUrl);
    if (cache.rpcUrls.length === 0) cache.rpcUrls = [...DEFAULT_RPC_POOL];
    cache.walletRefreshIntervalSec = clampInt(
      cache.walletRefreshIntervalSec,
      WALLET_REFRESH_MIN_SEC,
      WALLET_REFRESH_MAX_SEC,
      defaults().walletRefreshIntervalSec,
    );
    const d = defaults();
    for (const k of BOOLEAN_KEYS) {
      if (typeof cache[k] !== 'boolean') (cache as unknown as Record<string, unknown>)[k] = d[k];
    }
    cache.priorityFeeMicroLamports = clampInt(cache.priorityFeeMicroLamports, 0, PRIORITY_FEE_MAX, d.priorityFeeMicroLamports);
    if (typeof cache.upstreamDir !== 'string' || !cache.upstreamDir.trim()) cache.upstreamDir = d.upstreamDir;
    if (typeof cache.dockerSocket !== 'string') cache.dockerSocket = d.dockerSocket;
    cache.nodeRefreshIntervalSec = clampInt(
      cache.nodeRefreshIntervalSec,
      NODE_REFRESH_MIN_SEC,
      NODE_REFRESH_MAX_SEC,
      defaults().nodeRefreshIntervalSec,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`settings.json unreadable, using defaults: ${(err as Error).message}\n`);
    }
    cache = defaults();
  }
  return cache;
}

// Allowed top-level setting keys. Anything not in this set is dropped
// before merging — protects against prototype pollution (`__proto__`,
// `constructor`, `prototype`) and stray fields from a JSON.parse path.
const ALLOWED_SETTINGS_KEYS: ReadonlySet<keyof AppSettings> = new Set([
  'rpcUrls',
  'priorityFeeMicroLamports',
  'upstreamDir',
  'dockerSocket',
  'seenOnboarding',
  'minimizeToTrayOnClose',
  'stopNodesOnQuit',
  'trayHintShown',
  'stopCliServerOnQuit',
  'walletRefreshIntervalSec',
  'nodeRefreshIntervalSec',
]);

const BOOLEAN_KEYS: ReadonlyArray<keyof AppSettings> = [
  'seenOnboarding',
  'minimizeToTrayOnClose',
  'stopNodesOnQuit',
  'trayHintShown',
  'stopCliServerOnQuit',
];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function wholeNumberIn(key: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/** The node image builds from these folders of the source tree (see image-source.ts). */
const UPSTREAM_MARKER = 'sentinel-dvpnd';

async function checkUpstreamDir(dir: string): Promise<void> {
  try {
    const st = await fs.stat(path.join(dir, UPSTREAM_MARKER));
    if (st.isDirectory()) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') {
      throw new Error(`upstreamDir "${dir}" cannot be read: ${(err as Error).message}`);
    }
  }
  throw new Error(`upstreamDir "${dir}" is not a node source folder: it has no ${UPSTREAM_MARKER}/ folder inside.`);
}

async function checkDockerSocket(sock: string): Promise<void> {
  if (process.platform === 'win32') {
    if (/^(\/\/|\\\\)\.(\/|\\)pipe(\/|\\)[^\s/\\]+$/.test(sock)) return;
    throw new Error(`dockerSocket "${sock}" must be a named pipe such as //./pipe/docker_engine.`);
  }
  let isSocket = false;
  try {
    isSocket = (await fs.stat(sock)).isSocket();
  } catch (err) {
    throw new Error(`dockerSocket "${sock}" cannot be used: ${(err as Error).message}`);
  }
  if (!isSocket) throw new Error(`dockerSocket "${sock}" is not a socket file.`);
}

/**
 * Check a settings patch and return the fields to write. Refuses (throws) instead of
 * storing a wrong type or silently changing a value: a string "no" for a switch used to
 * be saved and read as on. A field equal to the stored value passes untouched, so the
 * Settings screen can send its whole draft even when an unrelated field is stale
 * (e.g. the default source folder on a new machine).
 */
async function checkSettingsPatch(raw: unknown, current: AppSettings): Promise<Partial<AppSettings>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Settings must be a JSON object, e.g. {"stopNodesOnQuit":false}.');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = key as keyof AppSettings;
    if (Object.prototype.hasOwnProperty.call(current, k) && sameValue(value, current[k])) continue;
    if (!ALLOWED_SETTINGS_KEYS.has(k)) {
      throw new Error(`Unknown setting "${key}". Known settings: ${[...ALLOWED_SETTINGS_KEYS].join(', ')}.`);
    }
    if (BOOLEAN_KEYS.includes(k)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false (got ${JSON.stringify(value)}).`);
      out[k] = value;
    } else if (k === 'rpcUrls') {
      if (!Array.isArray(value) || value.some((u) => typeof u !== 'string')) {
        throw new Error('rpcUrls must be a list of URLs, e.g. ["https://api.devnet.solana.com"].');
      }
      const urls = (value as string[]).map((u) => u.trim()).filter(Boolean);
      const bad = urls.filter((u) => !isValidRpcUrl(u));
      if (bad.length) {
        throw new Error(`RPC URL not accepted: ${bad.join(', ')}. Use https:// (http:// only for localhost or a private-network address), with no spaces or quotes.`);
      }
      // An empty list means "use the default pool".
      out[k] = urls.length ? urls : [...DEFAULT_RPC_POOL];
    } else if (k === 'priorityFeeMicroLamports') {
      out[k] = wholeNumberIn(key, value, 0, PRIORITY_FEE_MAX);
    } else if (k === 'walletRefreshIntervalSec') {
      out[k] = wholeNumberIn(key, value, WALLET_REFRESH_MIN_SEC, WALLET_REFRESH_MAX_SEC);
    } else if (k === 'nodeRefreshIntervalSec') {
      out[k] = wholeNumberIn(key, value, NODE_REFRESH_MIN_SEC, NODE_REFRESH_MAX_SEC);
    } else if (k === 'upstreamDir') {
      if (typeof value !== 'string') throw new Error('upstreamDir must be a folder path.');
      const dir = value.trim();
      // Blank means "back to the default folder". The default is checked like any other
      // folder: storing one that does not exist would only fail later, at deploy (NM4).
      if (!dir) {
        const fallback = defaultUpstreamDir();
        try {
          await checkUpstreamDir(fallback);
        } catch (err) {
          throw new Error(`upstreamDir "" means the default folder, and ${(err as Error).message.replace(/^upstreamDir /, '')} Choose the folder that holds the node source instead.`);
        }
        out[k] = fallback;
      } else {
        await checkUpstreamDir(dir);
        out[k] = dir;
      }
    } else if (k === 'dockerSocket') {
      if (typeof value !== 'string') throw new Error('dockerSocket must be a socket path, or "" to find Docker automatically.');
      const sock = value.trim();
      if (sock) await checkDockerSocket(sock);
      out[k] = sock;
    }
  }
  return out as Partial<AppSettings>;
}

function isValidRpcUrl(raw: string): boolean {
  // The URL is written verbatim into TOML config files: no whitespace, quotes or control chars.
  if (/[\s'"\u0000-\u001f\u007f]/.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    process.stderr.write(`invalid RPC URL dropped from settings: ${(err as Error).message}\n`);
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  // http:// only for loopback and private-network addresses (httpRpcHostAllowed) — never
  // for public hosts: plaintext RPC over the open network leaks signed TXs and queries.
  if (parsed.protocol === 'http:') return httpRpcHostAllowed(parsed.hostname);
  return false;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const safe = await checkSettingsPatch(patch, current);
  const next: AppSettings = { ...current, ...safe };
  cache = next;
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await fs.writeFile(file(), JSON.stringify(next, null, 2), 'utf8');
  emitter.emit('changed', next);
  return next;
}

/** Settings safe to export: RPC URLs lose query strings / path tokens (API keys). */
export function redactSettings(s: AppSettings): AppSettings {
  return {
    ...s,
    rpcUrls: s.rpcUrls.map((u) => {
      try {
        const p = new URL(u);
        return `${p.protocol}//${p.host}${p.search ? '/?<redacted>' : p.pathname.length > 1 ? '/<redacted>' : ''}`;
      } catch (err) {
        return `<unparseable: ${(err as Error).message}>`;
      }
    }),
  };
}
