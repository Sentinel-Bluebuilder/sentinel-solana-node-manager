# Changelog

The earlier Cosmos-era app is a separate project and is not part of this repository.

## 0.3.0 — installers and one-download node image (2026-11-10)

- **Installers:** Windows one-click setup (x64, arm64; per user, no admin prompt, opens when done) and a
  portable x64 exe; macOS dmg + zip (Apple silicon, Intel); Linux AppImage, deb and rpm (x64, arm64).
- **No source or build needed to deploy:** each host downloads the published node image for its CPU once,
  checks its SHA-256 against the hash pinned in the app and loads it into Docker (daemon cut final6.5,
  90014b2). On a server over SSH this needs no build context upload and no buildx.
- Settings → Node image: "Download the prebuilt image" (default) or "Build from source" (developers;
  the source folder shows only in that mode). Settings from older versions get the prebuilt image.
- Deploy screen: Xray, OpenVPN and Hysteria2 tiles show their official logos (generic icons before);
  AmneziaWG uses its small icon (the wordmark was unreadable at tile size).
- Get started card on Overview until the first node exists: wallet → funding (live balance, copy
  address) → where the node runs (Docker check with Start / Get Docker Desktop / Check again) → deploy.
- Deploy over SSH: the Deploy button tests the connection itself (no separate Test click needed); a
  server that does not answer stops the deploy before anything is funded.
- After a price or protocol change the app waits up to 6 minutes for the chain to show it (was 3; a
  small server took longer and the app reported a change that had succeeded as failed).
- In-app paid test retries session start once after a public-devnet rate limit (HTTP 429).
- Packaging fixes found by the install tests: every @solana package is in the app (electron-builder
  26), Linux deb/rpm declare the ALSA and GBM libraries Electron needs, logos load in installed apps,
  and the ssh2 native add-on (not buildable for Electron 39) is left out in favour of its JavaScript code.
- arm64 Linux ships deb and rpm only: the arm64 AppImage runtime needs a library desktop systems lack.
- Windows uninstall removes the setup copy it kept in `%LOCALAPPDATA%` and the empty install folder
  (the wallet and settings stay).

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
