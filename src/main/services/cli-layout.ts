// ─── dvpnd / dvpnctl command-line layouts ───
// Pure helpers (no Electron) so unit tests can load them directly.
//
// Nodes deployed earlier keep their older image, so the app speaks both layouts.
// The newer one (ddv18.32+) renamed a few flags the app uses; everything else it
// passes is the same in both (checked flag by flag with `--help` on both images).
// Global flags (--daemon.socket / --daemon.endpoint, --key / --key.name) differ too,
// which is why the app never passes them: they live in ctl/config.toml.

//
// cb33 (public sentinel-official/sentinel-solana 26de5240) renamed both binaries
// (dvpnd → sentinel-dvpnd, dvpnctl → sentinel-dvpn), replaced `start` with `run`,
// made `--instance <tag>` required on every daemon command, dropped `init --role`
// (the tag's first letter is the role) and moved the node home to one flat folder:
// config.toml (node + daemon settings together), keys/, <service>/config.toml.
// Its chain-command flags match the newer layout.

export type CliLayout = 'older' | 'newer' | 'cb33';

/** The daemon instance every node container runs. One node per container, so always n1. */
export const NODE_INSTANCE = 'n1';

export interface CliBinaries {
  daemon: string;
  ctl: string;
}

export function binariesFor(layout: CliLayout): CliBinaries {
  return layout === 'cb33' ? { daemon: 'sentinel-dvpnd', ctl: 'sentinel-dvpn' } : { daemon: 'dvpnd', ctl: 'dvpnctl' };
}

/** Files under the node home (paths relative to it). */
export interface HomePaths {
  /** service, country, [api], [prices], [redeem]. */
  nodeConfig: string;
  /** [rpc], [tx], [daemon]. In cb33 this is the same file as nodeConfig. */
  topConfig: string;
  keysDir: string;
  serviceConfig(service: string): string;
}

export function homePathsFor(layout: CliLayout): HomePaths {
  if (layout === 'cb33') {
    return {
      nodeConfig: 'config.toml',
      topConfig: 'config.toml',
      keysDir: 'keys',
      serviceConfig: (s) => `${s}/config.toml`,
    };
  }
  return {
    nodeConfig: 'node/config.toml',
    topConfig: 'config.toml',
    keysDir: 'node/keys',
    serviceConfig: (s) => `node/${s}/config.toml`,
  };
}

/** Container command (after the image ENTRYPOINT) that runs the node daemon. */
export function nodeCommandFor(layout: CliLayout, home: string): string[] {
  if (layout === 'cb33') return ['run', '--instance', NODE_INSTANCE, '--home', home];
  return ['start', '--home', home];
}

/**
 * True when `sentinel-dvpnd init --help` came from a cb33 image. An older image has
 * no such binary (non-zero exit), and the caller then asks `dvpnd init --help`.
 */
export function isCb33InitHelp(exitCode: number, help: string): boolean {
  return exitCode === 0 && /--instance\b/.test(help) && /--owner\b/.test(help);
}

/** `dvpnd init --help` of the newer layout lists --api-hosts (older: --api-addrs). */
export function layoutFromInitHelp(help: string): CliLayout {
  if (/--api-hosts\b/.test(help)) return 'newer';
  if (/--api-addrs\b/.test(help)) return 'older';
  throw new Error(`cannot tell the dvpnd version from \`dvpnd init --help\`: ${help.trim().slice(0, 200)}`);
}

/** Older flag → newer flag, per command ("<bin> <sub> [<sub>]"). */
const NEWER_RENAMES: Record<string, Record<string, string>> = {
  'dvpnd init': {
    '--api-addrs': '--api-hosts',
    '--prices.channel-price-per-gb': '--prices.channel-per-gb',
    '--prices.channel-price-per-hour': '--prices.channel-per-hour',
    '--prices.lease-price-per-hour': '--prices.lease-per-hour',
  },
  'dvpnctl node withdraw-node-bond': { '--rent-payer': '--rent-recipient' },
  'dvpnctl channel close-channel': { '--rent-payer': '--rent-recipient' },
  'dvpnctl user withdraw-user-balance': { '--rent-payer': '--rent-recipient' },
};

/** The command words before the first flag, e.g. "dvpnctl node withdraw-node-bond". */
export function commandKey(bin: string, args: readonly string[]): string {
  const words: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) break;
    words.push(a);
  }
  return [bin, ...words].join(' ');
}

/**
 * cb33 init: no --role (the instance tag carries it), and --instance is required.
 * Takes args already renamed for the newer layout.
 */
function cb33Init(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--role') {
      i++;
      continue;
    }
    if (a.startsWith('--role=')) continue;
    out.push(a);
  }
  return [...out, '--instance', NODE_INSTANCE];
}

/**
 * Args written in the older layout, rewritten for `layout`. `bin` is the older
 * binary name ('dvpnd' or 'dvpnctl'); binariesFor() gives the name to run.
 */
export function translateArgs(bin: string, args: readonly string[], layout: CliLayout): string[] {
  if (layout === 'older') return [...args];
  const renamed = renameFlags(bin, args);
  if (layout === 'cb33' && commandKey(bin, args) === 'dvpnd init') return cb33Init(renamed);
  return renamed;
}

/**
 * Args for a CLI command that talks to the running daemon (node sessions/redeem/…,
 * daemon status/version, client start/status/stop). cb33 makes `--instance` required on
 * every one of them even when [daemon] endpoint names the socket (sentinel-dvpn
 * internal/cli/call.go addInstanceFlag); the older CLIs have no such flag.
 */
export function daemonCallArgs(args: readonly string[], layout: CliLayout, instance: string = NODE_INSTANCE): string[] {
  const out = translateArgs('dvpnctl', args, layout);
  return layout === 'cb33' ? [...out, '--instance', instance] : out;
}

function renameFlags(bin: string, args: readonly string[]): string[] {
  const renames = NEWER_RENAMES[commandKey(bin, args)];
  if (!renames) return [...args];
  return args.map((a) => {
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const to = renames[flag];
    if (!to) return a;
    return eq > 0 ? `${to}${a.slice(eq)}` : to;
  });
}
