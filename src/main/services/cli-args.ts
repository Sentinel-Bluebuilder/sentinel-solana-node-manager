/**
 * CLI argument handling — pure (no Electron), so it is unit-tested directly.
 *
 *   tokenize   splits a command line the way a POSIX shell would for quotes
 *   parseArgs  separates `--flag value` / `--flag=value` / `--bool` from positionals
 *   checkArgs  rejects undeclared flags and surplus positionals (a typo must fail
 *              loudly, never silently run the un-flagged action)
 */

import { readFile } from 'node:fs/promises';

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface CliArgSpec {
  name: string;
  kind: 'positional' | 'flag' | 'bool';
  required?: boolean;
  describe: string;
}

export function tokenize(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        // Inside double quotes only \" and \\ are escapes (so "C:\\Users\\x" keeps its backslashes).
        buf += line[++i];
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      inToken = true; // an empty quoted string is still a token
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        out.push(buf);
        buf = '';
        inToken = false;
      }
      continue;
    }
    buf += ch;
    inToken = true;
  }
  if (quote) throw new Error(`Unterminated ${quote === '"' ? 'double' : 'single'} quote in command line.`);
  if (inToken) out.push(buf);
  return out;
}

/**
 * `boolNames`: flags that never take a value, so `--force <id>` leaves `<id>`
 * positional. A value starting with `--` is only taken via `--flag=--value`.
 * Negative numbers (`--amount -1`) are values, not flags.
 */
export function parseArgs(tokens: string[], boolNames: ReadonlySet<string> = new Set()): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=');
      if (eq > -1) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
      } else {
        const name = t.slice(2);
        const next = tokens[i + 1];
        if (!boolNames.has(name) && next !== undefined && !/^--./.test(next)) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(t);
    }
  }
  return { positional, flags };
}

/** Throws when `parsed` carries a flag the command never declared, or more positionals than it takes. */
export function checkArgs(cmdName: string, usage: string, args: readonly CliArgSpec[], parsed: ParsedArgs): void {
  const declared = new Set(args.filter((a) => a.kind !== 'positional').map((a) => a.name));
  const unknown = Object.keys(parsed.flags).filter((f) => !declared.has(f));
  if (unknown.length) {
    const allowed = [...declared].map((f) => `--${f}`).join(', ') || '(none)';
    throw new Error(
      `Unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((f) => `--${f}`).join(', ')} for ${cmdName}. Allowed: ${allowed}. Usage: ${usage}`,
    );
  }
  const maxPositional = args.filter((a) => a.kind === 'positional').length;
  if (parsed.positional.length > maxPositional) {
    const extra = parsed.positional.length - maxPositional;
    throw new Error(`Too many arguments for ${cmdName} (${extra} unexpected; did a multi-word value need quotes?). Usage: ${usage}`);
  }
}

export const requireFlag = (p: ParsedArgs, name: string): string => {
  const v = p.flags[name];
  if (v === undefined) throw new Error(`Missing required --${name}`);
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`--${name} requires a non-empty value`);
  return v;
};

export const optionalFlag = (p: ParsedArgs, name: string): string | undefined => {
  const v = p.flags[name];
  if (v === true) throw new Error(`--${name} requires a value`);
  return typeof v === 'string' ? v : undefined;
};

export const numberFlag = (p: ParsedArgs, name: string, required = false): number | undefined => {
  const v = p.flags[name];
  if (v === undefined) {
    if (required) throw new Error(`Missing required --${name}`);
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`--${name} requires a numeric value`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

/** `--name` or `--name true|1|yes` → true; absent or `--name false|0|no` → false. */
export const boolFlag = (p: ParsedArgs, name: string): boolean => {
  const v = p.flags[name];
  if (v === undefined) return false;
  if (typeof v !== 'string') return v;
  if (/^(true|1|yes)$/i.test(v)) return true;
  if (/^(false|0|no)$/i.test(v)) return false;
  throw new Error(`--${name} takes no value (or true/false)`);
};

export const requirePositional = (p: ParsedArgs, idx: number, label: string): string => {
  const v = p.positional[idx];
  if (!v) throw new Error(`Missing positional argument: ${label}`);
  return v;
};

export const requirePositionalOrFlag = (p: ParsedArgs, idx: number, label: string, flag = label): string => {
  const pos = p.positional[idx];
  if (pos) return pos;
  const f = p.flags[flag];
  if (typeof f === 'string' && f) return f;
  throw new Error(`Missing ${label} (pass positionally or as --${flag})`);
};

/**
 * Read a file named by a flag (a key file, a wallet key file). A failed read is
 * reported in plain words with the flag and path, never as the raw `ENOENT: …`
 * Node error (NM12).
 */
export const readArgFile = async (flag: string, file: string): Promise<string> => {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`No file at "${file}" (--${flag}). Check the path.`);
    if (code === 'EISDIR') throw new Error(`"${file}" is a folder, not a file (--${flag}).`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`This app is not allowed to read "${file}" (--${flag}).`);
    throw new Error(`Could not read "${file}" (--${flag}).`, { cause: err });
  }
};
