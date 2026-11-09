#!/usr/bin/env node
// Generate docs/COVERAGE.md: every dvpnctl leaf command and every dvpn program
// instruction, classified against this app. Fails (exit 1) if any item is left
// unclassified, so new upstream commands cannot slip through silently.
//
//   node scripts/gen-coverage.mjs [path/to/sentinel-solana]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ss = process.argv[2] ?? path.join(os.homedir(), 'Desktop', 'sentinel-solana');
const cliRef = fs.readFileSync(path.join(ss, 'docs', '22-CLI-REFERENCE.md'), 'utf8');
const lib = fs.readFileSync(path.join(ss, 'upstream', 'sentinel-programs', 'programs', 'dvpn', 'src', 'lib.rs'), 'utf8');
const commands = [...cliRef.matchAll(/^## dvpnctl (.+)$/gm)].map((m) => m[1].trim());
const instructions = [...lib.matchAll(/pub fn ([a-z_]+)(?:<[^>]*>)?\(/g)].map((m) => m[1]);

// Status legend:
//   APP     — an app function calls it (CLI command / UI) and the e2e suite tests it
//   DAEMON  — the node daemon does it on its own; the app triggers or observes it
//   TEST    — used by the app's paid self-test / test-channel sweep (client side)
//   N/A     — not a node-operator function (client, provider, plan, governance) — out of scope
//   CHOSEN  — deliberately not used, with the reason
const CMD = {
  'node open-node': ['APP', 'deploy.start (open_node, node key signs)'],
  'node update-node': ['DAEMON', 'daemon start-up sync after nodes.updatePricing / nodes.setProtocol (config → restart)'],
  'node list-node': ['APP', 'nodes.relist (always an explicit list_node)'],
  'node delist-node': ['APP', 'nodes.remove (stage delist)'],
  'node close-node': ['APP', 'nodes.remove (stage close)'],
  'node withdraw-node-bond': ['APP', 'nodes.withdrawBond / removal stage withdraw-bond'],
  'node withdraw-node-revenue': ['APP', 'nodes.withdraw'],
  'node sweep-node-fees': ['DAEMON', 'daemon sweeps at start-up; fees go to the treasury, not the operator'],
  'node show': ['APP', 'nodes.chain / nodes.status / every on-chain verification'],
  'node search': ['APP', 'nodes.inspect (discoverable check)'],
  'node inspect': ['APP', 'nodes.inspect (signed metadata + TLS pin)'],
  'node status': ['APP', 'nodes.status (daemon reachability)'],
  'node sessions': ['APP', 'nodes.sessions / nodes.status'],
  'node session': ['APP', 'nodes.session'],
  'node close-session': ['APP', 'nodes.closeSession'],
  'node positions': ['APP', 'nodes.positions'],
  'node redeem': ['APP', 'nodes.redeem (+ hourly daemon loop)'],
  'node redemptions': ['APP', 'nodes.redemptions'],
  'node heartbeat': ['DAEMON', 'hourly loop; skips a still-fresh listing, so nodes.relist sends list_node directly (found live)'],
  'node sync': ['CHOSEN', 'redundant: config changes need a restart to load, and the daemon syncs on start-up'],
  'node unbonding search': ['APP', 'removal stage close / withdraw-bond'],
  'node unbonding show': ['CHOSEN', 'search by owner already returns the unbonding account'],
  'program params': ['APP', 'program.status, deploy (vault, bond, pause guard)'],
  'program status': ['APP', 'program.status'],
  version: ['APP', 'program.status (image identity: network, program id, mint)'],
  'wallet balance': ['CHOSEN', 'wallet balances read natively with web3.js (no container needed)'],
  'wallet create-token-account': ['CHOSEN', 'ATA created idempotently inside every transfer'],
  'wallet approve-delegate': ['N/A', 'client delegate for channel funding'],
  'wallet revoke-delegate': ['N/A', 'client delegate'],
  'keys list': ['CHOSEN', 'keys are generated and held by the app (OS keychain)'],
  'keys new': ['CHOSEN', 'node keys derive from a 24-word phrase the user can back up'],
  'keys show': ['CHOSEN', 'app shows addresses itself'],
  'config init': ['CHOSEN', 'app writes the dvpnctl config directly'],
  'config show': ['CHOSEN', 'app writes the dvpnctl config directly'],
  'daemon status': ['APP', 'nodes.daemon'],
  'daemon version': ['APP', 'nodes.daemon'],
  'channel open-channel': ['TEST', 'nodes.test (client opens a voucher channel)'],
  'channel start-close-channel': ['TEST', 'nodes.sweepTestChannels'],
  'channel close-channel': ['TEST', 'nodes.sweepTestChannels'],
  'channel search': ['TEST', 'nodes.sweepTestChannels'],
  'channel show': ['N/A', 'client'],
  'channel fund-channels': ['N/A', 'client top-up'],
  'channel redeem-channel-vouchers': ['DAEMON', 'daemon redeem loop / nodes.redeem'],
  'channel redeem-channel-streams': ['DAEMON', 'daemon redeem loop (stream mode)'],
  'user withdraw-user-balance': ['TEST', 'nodes.sweepTestChannels (refund to wallet)'],
  'user show': ['TEST', 'nodes.sweepTestChannels'],
  'user search': ['N/A', 'client'],
  'session start': ['TEST', 'nodes.test'],
  'session status': ['TEST', 'nodes.test'],
  'session stop': ['TEST', 'nodes.test'],
  'session list': ['N/A', 'client'],
  'session watch': ['N/A', 'client'],
  'session channels': ['N/A', 'client'],
  'session tickets': ['N/A', 'client (subscription tickets)'],
  'lease redeem-lease-vouchers': ['DAEMON', 'daemon redeem loop'],
  'lease redeem-lease-streams': ['DAEMON', 'daemon redeem loop'],
  'lease search': ['APP', 'nodes.leases (on-chain leases on the node); the Leases card also shows the daemon-watched ones'],
  'lease show': ['N/A', 'provider'],
  'lease open-lease': ['N/A', 'provider pays the node'],
  'lease fund-leases': ['N/A', 'provider'],
  'lease start-close-lease': ['N/A', 'provider'],
  'lease close-lease': ['N/A', 'provider'],
  'operator add-operator': ['CHOSEN', 'per-node key is the owner (owner decision); mandates not needed'],
  'operator update-operator': ['CHOSEN', 'see add-operator'],
  'operator remove-operator': ['CHOSEN', 'see add-operator'],
  'operator mandate search': ['CHOSEN', 'see add-operator'],
  'operator mandate show': ['CHOSEN', 'see add-operator'],
};
const NA_GROUPS = {
  governance: 'program authority only',
  plan: 'provider role (Plan Manager Solana, project #29)',
  provider: 'provider role (Plan Manager Solana, project #29)',
  subscription: 'client / provider',
  ticket: 'client / provider',
};

const INS = {
  open_node: ['APP', 'deploy.start'],
  update_node: ['DAEMON', 'start-up sync after config changes'],
  list_node: ['APP', 'nodes.relist (explicit); daemon heartbeat hourly'],
  delist_node: ['APP', 'nodes.remove'],
  close_node: ['APP', 'nodes.remove'],
  withdraw_node_bond: ['APP', 'nodes.withdrawBond'],
  withdraw_node_revenue: ['APP', 'nodes.withdraw'],
  sweep_node_fees: ['DAEMON', 'start-up sweep to treasury'],
  redeem_channel_vouchers: ['DAEMON', 'redeem loop; nodes.redeem'],
  redeem_channel_streams: ['DAEMON', 'redeem loop'],
  redeem_lease_vouchers: ['DAEMON', 'redeem loop'],
  redeem_lease_streams: ['DAEMON', 'redeem loop'],
  open_channel: ['TEST', 'nodes.test'],
  start_close_channel: ['TEST', 'nodes.sweepTestChannels'],
  close_channel: ['TEST', 'nodes.sweepTestChannels'],
  withdraw_user_balance: ['TEST', 'nodes.sweepTestChannels'],
  fund_channels: ['N/A', 'client'],
  add_operator: ['CHOSEN', 'per-node owner key'],
  update_operator: ['CHOSEN', 'per-node owner key'],
  remove_operator: ['CHOSEN', 'per-node owner key'],
};
const insNA = (n) =>
  /^(initialize_config|set_params|set_treasury|set_paused|propose_authority|accept_authority|sweep_config_fees)$/.test(n)
    ? 'governance (authority only)'
    : /provider|plan|subscription|lease/.test(n)
      ? 'provider / plan / subscription role (project #29)'
      : null;

const missing = [];
const cmdRows = commands.map((c) => {
  if (CMD[c]) return [c, ...CMD[c]];
  const g = c.split(' ')[0];
  if (NA_GROUPS[g]) return [c, 'N/A', NA_GROUPS[g]];
  missing.push(`command: ${c}`);
  return [c, '??', 'UNCLASSIFIED'];
});
const insRows = instructions.map((i) => {
  if (INS[i]) return [i, ...INS[i]];
  const na = insNA(i);
  if (na) return [i, 'N/A', na];
  missing.push(`instruction: ${i}`);
  return [i, '??', 'UNCLASSIFIED'];
});

const tally = (rows) => rows.reduce((m, r) => ((m[r[1]] = (m[r[1]] ?? 0) + 1), m), {});
const fmtTally = (t) => Object.entries(t).map(([k, v]) => `${k} ${v}`).join(' · ');
const md = [
  '# Coverage — dvpnctl + dvpn program vs this app',
  '',
  'Generated by `scripts/gen-coverage.mjs` from `sentinel-solana/docs/22-CLI-REFERENCE.md` and',
  '`programs/dvpn/src/lib.rs`. Do not edit by hand. Regenerate after an upstream update; the',
  'script exits non-zero if any command or instruction is unclassified.',
  '',
  '**Legend** — APP: an app function (CLI + UI), covered by `tests/e2e/cli-e2e.mjs` ·',
  'DAEMON: the node daemon does it, the app triggers/observes it · TEST: used by the paid',
  'self-test / test-channel sweep · CHOSEN: deliberately not used (reason given) · N/A: not a',
  'node-operator function.',
  '',
  `## dvpnctl commands (${commands.length}) — ${fmtTally(tally(cmdRows))}`,
  '',
  '| command | status | where / why |',
  '|---|---|---|',
  ...cmdRows.map((r) => `| \`${r[0]}\` | ${r[1]} | ${r[2]} |`),
  '',
  `## Program instructions (${instructions.length}) — ${fmtTally(tally(insRows))}`,
  '',
  '| instruction | status | where / why |',
  '|---|---|---|',
  ...insRows.map((r) => `| \`${r[0]}\` | ${r[1]} | ${r[2]} |`),
  '',
  '## Removed as redundant or harmful (inherited from the Cosmos app)',
  '',
  '| item | why |',
  '|---|---|',
  '| auto-updater channel | pointed at the Cosmos app\'s GitHub releases; a packaged build would have replaced itself with the Cosmos app. Disabled. |',
  '| oracle price mode (`priceMode: oracle`, Osmosis TWAP) | the Solana program has no oracle; prices are flat base units |',
  '| `price.ts` (Cosmos `denom:base,quote` price strings) | Solana prices are three integers in the node config |',
  '| sentinelhub keyring seeding | the node key is a solana-keygen file written into the node home |',
  '| `$P2P` / `P2P` labels, DVPN→P2P log rewriter, p2pscan links | token is tDVPN; explorer is explorer.solana.com (devnet) |',
  '| Cosmos plans card (MsgLinkNode) | replaced by positions (channels / leases the daemon watches) |',
  '',
].join('\n');

fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'docs', 'COVERAGE.md'), md);
console.log(`commands ${commands.length}: ${fmtTally(tally(cmdRows))}`);
console.log(`instructions ${instructions.length}: ${fmtTally(tally(insRows))}`);
if (missing.length) {
  console.error(`UNCLASSIFIED:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
