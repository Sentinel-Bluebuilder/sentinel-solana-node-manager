# Sentinel Node Manager — Solana devnet

Desktop app (Electron + React) to host Sentinel dVPN nodes on the **Sentinel Solana
program** (devnet), on this machine (Docker Desktop) or on a VPS over SSH.

| | |
|---|---|
| Program | `J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs` |
| Token | tDVPN, Token-2022 mint `Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa`, 6 decimals |
| Node image | `node-manager/dvpnd:prebuilt-0.3.0` — `dvpnd` + `dvpnctl` + every protocol binary, linux amd64 + arm64 |
| Protocols | WireGuard, AmneziaWG, V2Ray, Xray, OpenVPN, Hysteria2 |

## Download

Latest release: [**Releases**](https://github.com/Sentinel-Bluebuilder/sentinel-solana-node-manager/releases/latest)

| System | File | Install |
|---|---|---|
| Windows 10/11 x64 | `Sentinel-Node-Manager-0.3.0-win-x64-setup.exe` | Run it. One click, no admin prompt; the app opens when setup ends |
| Windows 11 arm64 | `Sentinel-Node-Manager-0.3.0-win-arm64-setup.exe` | Same as x64 |
| Windows, no install | `Sentinel-Node-Manager-0.3.0-win-x64-portable.exe` | Run it from any folder |
| macOS Apple silicon | `Sentinel-Node-Manager-0.3.0-mac-arm64.dmg` (or `.zip`) | Open, drag to Applications |
| macOS Intel | `Sentinel-Node-Manager-0.3.0-mac-x64.dmg` (or `.zip`) | Open, drag to Applications |
| Ubuntu / Debian | `Sentinel-Node-Manager-0.3.0-linux-amd64.deb` / `-linux-arm64.deb` | `sudo apt install ./<file>.deb` |
| Fedora / RHEL | `Sentinel-Node-Manager-0.3.0-linux-x86_64.rpm` / `-linux-aarch64.rpm` | `sudo dnf install ./<file>.rpm` |
| Any Linux x86_64 | `Sentinel-Node-Manager-0.3.0-linux-x86_64.AppImage` | `chmod +x <file>.AppImage`, then run it (arm64: use the deb or rpm) |

> **Devnet only, unsigned builds.** Tokens on Solana devnet have no value. The installers are not code-signed:
> on Windows choose *More info → Run anyway*; on macOS right-click the app → *Open* the first time.
> Verify downloads: `sha256sum -c --ignore-missing SHA256SUMS` (SHA256SUMS and the files in one folder).

**First node in a few clicks:** create a wallet → send it devnet SOL + tDVPN (0.06 SOL and 1 tDVPN per node; the
Get started card shows the address and the live balance) → *Host on this computer* or *Host on a server (SSH)* →
Deploy. No source code and no build: the app downloads the node image once (about 90 MB), checks its SHA-256
against the hash pinned in the app, and loads it into Docker.

- **This computer** needs Docker: Docker Desktop on Windows/macOS, Docker Engine on Linux.
- **A server over SSH** needs a Linux server (x86_64 or arm64) you can reach over SSH; the app installs Docker there
  if it is missing.

**Node server files** (also on the release, for running a node without the app): `sentinel-dvpnd-linux-{amd64,arm64}`
(daemon), `sentinel-dvpn-linux-{amd64,arm64}` (CLI), and the node images
`sentinel-dvpnd-image-0.3.0-linux-{amd64,arm64}.tar.gz` (`gunzip -c <file> | docker load`).

Test results and known issues:
[sentinel-solana-dvpn-testing-tools](https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools)
([known issues](https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools/blob/main/docs/known-issues-rc1.md)).

## How it works

- **Wallet** — a Solana keypair (24-word phrase, or an imported solana-keygen key file),
  encrypted with the OS keychain. It funds nodes and receives their revenue.
- **Deploy** — the app generates a node key (the node's on-chain owner), funds it with
  0.05 SOL and the 1 tDVPN bond, runs `dvpnd init`, pins every protocol to the node's
  5-port block, opens the node on chain (`open_node`) and starts the daemon, which lists
  itself and re-lists every hour (the listing lasts 24 h).
- **Program calls** go through `dvpnctl` inside the image. The deployed devnet program
  differs from the source IDL, and `dvpnctl` carries the compatibility patches.
- **Changes** (prices, protocol) edit the node's config and restart it; the daemon pushes
  the change on chain (`update_node`) at start-up.
- **Test node** — a throwaway client container pays a voucher channel from your wallet,
  pulls 1 MB through the node, and checks the redeemed revenue on chain.
- **Remove** — redeem, stop, delist, close (bond enters 1 h unbonding), withdraw the bond,
  sweep the node key back to the wallet. Resumes after a restart.
- **Remote hosts** — SSH credentials are never stored; after an app restart use
  `nodes.reconnect` (or the Reconnect prompt on the node page) and remote work resumes.
- **Server IP address changed** — a node record keeps the address it was deployed to, and
  the app cannot move it to a new one yet (planned: "change host"). Every remote step then
  fails with "<host>:22 does not answer over SSH … IP address changed". Until then:
  - *Best:* give the server its old address back (a cloud static/reserved IP), then
    `nodes.reconnect` with it. Everything resumes.
  - *Deploy failed before the node started* (e.g. at `open_node`): **Remove node** still returns the funds,
    because the chain steps run on this machine. The record then waits for host cleanup;
    delete the node's directory and container on the server by hand.
  - *Node live on chain:* removal stops at "stop" (the daemon must be stopped first, or it
    re-lists). Stop the container on the server by hand (`docker rm -f` it at its new
    address), restore the old address long enough to Reconnect and finish the removal, then
    deploy again on the new address.
- **Reachability** — `nodes.inspect` checks the node the way a client does (signed metadata, TLS
  pin, discoverable) and tells you which ports to open if it is listed but unreachable.

## Run

```sh
npm install
npm run dev            # or: powershell scripts/restart-dev.ps1 (CLI server on)
```

By default the node image is downloaded (see **Download**). Developers can build it from a Sentinel Solana
source checkout instead: Settings → Node image → *Build from source*, then set the source folder.

## CLI and end-to-end test

The app exposes every function over a local CLI server (`bin/sentinel-node-manager.js`,
or the in-app CLI screen). `tests/e2e/cli-e2e.mjs` drives all of them from the user's
side and re-verifies every chain effect against devnet RPC:

```sh
node tests/e2e/cli-e2e.mjs                 # full run, local target
node tests/e2e/cli-e2e.mjs --finish        # after unbonding / channel grace: bond back, refunds
node tests/e2e/cli-e2e.mjs --target remote --ssh-host H --ssh-user U --ssh-key KEY
```

Reports land in `tests/e2e/reports/`. Unit tests: `npm test` (CLI parser, secret
scrubber, TOML patchers, program decoding, keys).

CLI conventions: every flag a command accepts is declared, so a mistyped flag fails
loudly instead of running the un-flagged action; `help <command>` prints one command;
`nodes.sweepTestChannels --dry-run` previews; settings read over the pipe never carry
RPC API keys.

Function-by-function map from the Cosmos app: `docs/SOLANA-MAPPING.md`.

## Licences and notices

Built on Sentinel. https://sentinel.co

- The node daemon and CLI inside the node image (and the server files on the release) come from the Sentinel source
  tree and are under the **Sentinel dVPN License**. Their source is not part of this repository. The image
  carries their licence and the licences of its other programs (Xray-core MPL-2.0, Hysteria, hnsd,
  amneziawg-tools GPL-2.0, amneziawg-go, wireguard-go) at `/usr/share/licenses/node-image/`.
- npm packages the app ships: `THIRD-PARTY-NOTICES.md`. Regenerate it with
  `node tools/gen-notices.mjs` after any dependency change.
