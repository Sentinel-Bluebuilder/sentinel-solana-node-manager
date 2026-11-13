# Changelog

The earlier Cosmos-era app is a separate project and is not part of this repository.

## 0.3.1-rc.1 — HNS for users, no Docker needed to withdraw (release candidate, 2026-11-13)

- **HNS Resolver works for the node's users:** with the switch on, a client connected over WireGuard,
  AmneziaWG or OpenVPN can open Handshake names (whatever DNS server it asked, port 53 goes to the
  node's resolver); ordinary names still go to 1.1.1.1. V2Ray, Xray and Hysteria2 nodes resolve
  destinations on the node, through the same resolver, and DNS a Hysteria2/V2Ray/Xray client sends to
  any server is answered by it too. Node page: "Routing users' DNS". Needs the new
  node image 0.3.7 (amd64 + arm64, SHA-256 pinned); turning HNS on moves a node to it. In that image
  an hnsd crash restarts hnsd only (upstream stops the whole node daemon when hnsd exits), and
  hnsd's per-block output (~500k lines while syncing) is summarised once a minute instead of
  filling the node log; hnsd keeps its chain checkpoint, so a restart no longer re-syncs
  the whole Handshake chain (~3 min) and leaves no temp files behind; its log can never stall it.
  After a node's first sync hnsd is restarted once from its checkpoint, which frees ~150 MB of
  memory for good (163 MB → 9.5 MB; measured cost of HNS on a 2 GB VPS: ~85 s and 210 MB download for
  the first sync, then ~0% CPU and ~1 MB/h).
  The node page shows the Handshake sync ("Syncing · 45%", and an error asking for outbound TCP
  when hnsd reaches no Handshake peer or gets no new block for 45 min; "Restarting…" during a
  restart) instead of "Routing users' DNS" as soon as a process named hnsd exists. The paid
  self-test checks HNS names on every protocol (V2Ray/Xray through their proxy).
  An HNS node on an older node image moves to the current one at its next Restart, protocol switch
  or price change (the page says "Restart to update the node image"), so it gets these fixes.
- **Chain actions without Docker on this computer:** withdraw, bond withdrawal, removal and test-escrow
  refunds run on one of your servers when Docker Desktop is off (Settings → Chain-call server). The
  removal card says why it is waiting and offers Start Docker Desktop / Use a server instead.
- **Removal never dead-ends:** Retry now, the cleanup reason, "Retry cleanup now" and "Server is gone";
  a local node whose Docker is gone is forgotten and its container deleted when Docker returns.
- **Test escrow comes home by itself:** the paid self-test starts the channel close right away and the
  app finishes it after the grace period (Wallet → Test escrow card, Reclaim now).
- Wallet: SOL Max leaves the fee and rent; errors on a node stay on its page (red card) instead of
  only in the log.
- Fixes: a damaged app data file is restored from a rolling backup instead of starting empty (that
  lost every node and its key); "getting the chain-call image" no longer repeats every minute with
  Docker off; the escrow sweep no longer writes the same log line every 10 minutes; node logs are
  capped at 3 × 20 MB (hnsd logs ~680k lines while syncing).
- Two changes on one node at once (e.g. a protocol switch and the HNS switch) are refused with
  "… is still running on this node" instead of racing; while a change restarts the node its page says
  "Switching protocol…" instead of "Listing expired", and a server node the app has no SSH access
  to after a restart reads "Not connected" (not "Error") until Reconnect, without a "not live" alert
  or a Docker install hint at every launch.
- After a deploy, the button reads "Save phrase to open node" until the recovery phrase is saved; the
  tour explains the 0.06 SOL per node (0.05 to the node key + fees). Live sessions no longer lists
  sessions the node has already closed (the paid self-test stayed there for an hour).

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
