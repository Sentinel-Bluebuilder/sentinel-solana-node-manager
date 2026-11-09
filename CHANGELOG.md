# Changelog

The earlier Cosmos-era app is a separate project and is not part of this repository.

## 0.2.0 RC1 (2026-11-08)

- Release candidate built against fork cut `fork-cb33-4-final6.1` (`02b22fc`); no RC2 build exists for this product.
- Private-network RPC addresses are accepted over http; local privileged steps and shared-firewall handling added.
- Release assets: node daemon and CLI binaries (Linux x86_64 and arm64) with `SHA256SUMS`.
## 0.2.0 — Solana devnet

- Wallet: Solana keypair (24-word phrase, Phantom-compatible path m/44'/501'/0'/0'),
  or import a solana-keygen key file. Balances in SOL and tDVPN (Token-2022).
- Deploy (local Docker or SSH): node key funded with SOL + 1 tDVPN bond, `dvpnd init`,
  `open_node`, daemon lists itself. Failed deploys reclaim funds or start removal.
- All six protocols: WireGuard, AmneziaWG, V2Ray, Xray, OpenVPN, Hysteria2. Each node
  owns a 5-port block; ports are pinned for every protocol so switching needs no re-publish.
- Node management: live chain status, pricing (3 prices), protocol switch, redeem,
  re-list, withdraw revenue, in-app paid test session, specs memo.
- Removal: redeem → stop → delist → close → unbonding → withdraw bond → sweep key,
  resumable across restarts.
- Token label is tDVPN everywhere.

## 0.2.1 — audit pass (2026-10-14)

Four parallel read-only audits (chain services, Docker/SSH runtime, CLI/IPC parity,
renderer) plus a line-by-line review; everything below is fixed and covered by the
e2e suite or unit tests.

- Funds safety: the node id and PDA are persisted before `open_node`; a cancelled or
  timed-out open is re-checked on chain before any sweep; the unbonding account is read
  by its derived address; a node record (its only key backup) is dropped only once the
  key is verifiably empty; node keys are topped up with SOL before signed stages;
  removal is refused during a deploy; program parameters and the pause mask are checked
  before any funding transaction; `sendTx` waits for blockhash expiry before re-signing.
- CLI: undeclared flags and surplus positionals are rejected; `nodes.sweepTestChannels
  --dry-run`, `nodes.leases`, `nodes.exportLogs` (defaults to the container logs),
  `ssh.test --key-file`, `help <command>`; settings are redacted over the pipe; the
  scrubber covers flag variants, escaped JSON and RPC API keys; the standalone client
  prints its own results (a created mnemonic is no longer `***`) and exits non-zero on
  failure; shared validators on IPC and CLI.
- Runtime: remote `readFile` returns stdout only; remote one-shot containers are killed
  on cancel/timeout; env reaches remote containers through a 0600 file; BuildKit forced;
  the image tag covers the link-time identity; TOML values refuse quotes/control chars;
  stop/remove report real failures; tray icon packaged and headless-close guarded.
- UI: wallet balance pushes to every screen; replacing a wallet requires typing REPLACE;
  withdraw/claim include on-chain revenue; all six protocols in the filter; Activity
  shows every Solana event kind; removal is its own state on every button and chip;
  Cosmos-era price caps and country rules removed; Help rewritten; SOL send field;
  reconnect with port/password; paid test confirm; `fund` phase in the deploy pipeline.
