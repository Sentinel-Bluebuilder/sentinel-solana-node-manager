# Cosmos → Solana function map

How every function of the Cosmos node-hosting app (the Cosmos app) maps to the Sentinel Solana program on devnet. Kept current with the code.

## Core design
- **Program instructions + program reads → `dvpnctl`** (patched, every node instruction proven on
  devnet), running **inside the node image**: `runOnce` for one-shot txs, `docker exec` against the
  running daemon socket. JSON output, one wrapper. No TypeScript re-implementation of the program, so
  the devnet layout drift (doc 14) cannot bite.
- **Wallet, SOL/SPL transfers, memos → `@solana/web3.js` + `@solana/spl-token` + `@solana/spl-memo`.**
- **Node → `dvpnd start`** in Docker. It does its own heartbeat/re-list (24 h TTL), voucher
  redemption, fee sweep, and at start-up sends `update_node` when the config (prices, uri, service bit)
  differs from the chain (doc 26 §3). The app changes the config file and restarts, and the chain follows.
- **Self-test from the app**: a "Test node" action runs a **client** `dvpnd` from the same image in a
  throwaway container (its own netns, so no routing loop). The app wallet pays a voucher channel, the
  app fetches 1 MB through the tunnel, and it reports bytes, redemption and revenue. This is both a
  product feature and the e2e harness.

## Facts resolved from source
| Fact | Value | Source |
|---|---|---|
| Node PDA / unbonding PDA | `["node", owner, node_id]` / `["node_unbonding", owner, node_id]` | `idl/dvpn.json` `open_node` |
| `open-node` flags | `--node-id` (32 B hex), `--bond 1000000`, `--country`, `--protocols <bit>`, `--uri` (**literal**), `--prices.channel-price-per-gb/-per-hour`, `--prices.lease-price-per-hour`, `--mint --vault --owner-token --rent-payer` | doc 22, `e2e-full.sh:124` |
| vault / treasury | read once from `dvpnctl program params` (devnet vault `EQJyAy…`) | `e2e-full.sh:28` |
| `close_node` | owner-only; **pays out remaining revenue to owner_token itself**; parks fees; creates unbonding; **no open-positions guard** (so removal needs no extra branch; redeem first so vouchers aren't lost) | `node.rs:281-369` |
| `dvpnd init` | `--role node --home H --owner P --country --api-addrs --api-port --prices.* --service --plain-key` → JSON `{id, key, public_key, api_port, tls_sha256}`; renders `H/node/config.toml` + one `H/node/<service>/config.toml` per protocol | `init.go:59-235`, `config.go:234` |
| Daemon signs as owner | overwrite `H/node/keys/<key>.json` with the node key (solana-keygen JSON) | handoff, proven 2026-10-05 |
| Switch protocol | edit top-level `service` in `H/node/config.toml` → restart → on-chain bit follows | doc 26 §7 |
| Kernel vs userspace WG/AWG | automatic: kernel module if `/sys/module/<m>` exists, else `wireguard-go` / `amneziawg-go` on PATH (both in the image). **No config switch** | `preflight.go:34-43,262-283` |
| Service ports (random at init) | public: wireguard/amneziawg `listen_port` (udp); openvpn `listen_port` (`protocol` udp/tcp); hysteria2 `listen_port` (udp); v2ray/xray `[[inbounds]] port` (tcp; transports `ws`/`grpc`/`tcp`). Internal, not published: `api_port`, `management_port`, `auth_port`, `stats_port` | SDK `ServerConfig` toml tags |
| REALITY | carries 0 bytes here → the app strips `security = "reality"` inbounds from v2ray/xray configs | doc 26 §7, handoff |
| Build context | `upstream/` root (dvpnd + dvpnctl replace `../sentinel-go-sdk`, `../sentinel-programs/clients/go`); build ARGs `SENTINEL_NETWORK=devnet SENTINEL_PROGRAM_ID SENTINEL_MINT` | `go.mod`, upstream `Dockerfile` |
| RPC | public `https://api.devnet.solana.com` (all suites passed on it) + 429 backoff; Settings may add more | `ctl-home/config.toml` |
| A separate test host | x86_64, kernel 6.8, **wireguard + amneziawg modules loaded**, no Docker (the app's SSH flow installs it), 8 CPU / 31 GB / 400 GB free | read-only SSH check 2026-10-14 |

## Port pinning (makes all 6 protocols publishable)
After `dvpnd init`, the app assigns each node a contiguous block `P…P+4`. It rewrites `[api] port = P`
and every **public** port in the chosen service's config (`listen_port`, or each inbound `port`) to
`P+1…`, using `@iarna/toml` parse/stringify. It then publishes each pinned port as **both tcp and udp**
(`docker run -p` / `PortBindings`). Before deploy, the block is checked free (local: `net.listen`
probe; remote: `ss -lntu`). The same block is stored on the node record and reused on protocol switch,
so the published set never changes. Container: `CapAdd NET_ADMIN, NET_RAW`, `Devices /dev/net/tun`,
mount `H` → `/root/.dvpnd`.

## Function mapping (Cosmos → Solana)
| App function (file) | Cosmos today | Solana replacement |
|---|---|---|
| `chain.ts` | `udvpn`/`sent`/`sentinelhub-2`/RPC pool | `DECIMALS=6`, `PROGRAM_ID`, `MINT`, `TOKEN_2022`, devnet genesis hash, RPC list, `PROTOCOLS` table (name ↔ cb33 bit: wireguard 1, v2ray 2, openvpn 4, amneziawg 8, xray 16, hysteria2 32 ↔ public-port keys ↔ transport) |
| `createWallet`/`restoreWallet`/`generateNodeKey`/`signerFromMnemonic` | CosmJS HD 118 | `@scure/bip39` 24 words + SLIP-0010 `m/44'/501'/0'/0'` → `Keypair.fromSeed`; **plus `importKeyFile`** (64-byte JSON) so `9enW…` can be the app wallet; secret in `safeStorage` |
| `isValidBech32` | bech32 | base58 `PublicKey` + `isOnCurve` |
| `fetchBalance`/`refreshWalletBalance` | `getBalance(udvpn)` | SOL `getBalance` + ATA `getTokenAccountBalance`; `WalletState.balanceSOL` |
| `sendTokens` | `MsgSend` | Token-2022 `transferChecked` (+ idempotent ATA create) and SOL `transfer`; genesis-hash check; retry on 429 / blockhash expiry |
| `sentinel-client.ts` → `solana-client.ts` | Comet38/Stargate | `Connection` per URL, probe `getGenesisHash`+`getSlot`, same `withRpcTimeout` + cache, `sendTx()` with priority fee + backoff |
| deploy preflight | ≥ 1.05 DVPN | ≥ 0.06 SOL and ≥ 1 tDVPN; port block free; Docker healthy |
| deploy funding | `MsgSend` 1 DVPN | one tx: 0.05 SOL → node key, create node ATA, 1 tDVPN (bond) |
| keyring seed | `sentinelhub keys add` | `runOnce dvpnd init` → parse JSON → overwrite node key + write `CTLH/keys/owner.json` (0600, temp file + `rm`) → pin ports → strip REALITY → patch `[redeem] threshold = 1`, `[rpc]` |
| registration | dvpnx `MsgRegisterNode` | `runOnce dvpnctl node open-node` (node key signs; `id` from init; `uri=https://<host>:P`; bit of the chosen protocol) → `dvpnd start` lists it |
| `docker.ts` image | dvpnx + sentinelhub Dockerfile | upstream dvpnd Dockerfile **+ dvpnctl stage + `curl`**, context = tar of patched `upstream/` (no `target/`, `.git`, `node_modules`); tag `node-manager/dvpnd:devnet-<sha>` |
| `runRemoteDeploy` | heredoc Dockerfile | install Docker if missing (existing flow) → SFTP context tar + Dockerfile → `docker build` → same init/pin/open/run via `runRemote` |
| `liveStatus`/poller | `node.node`, `sessionsForNode` | `docker exec dvpnctl node status` + `node sessions` + `dvpnctl node show <PDA>` (status, listing expiry, revenue, fees, prices, uri, protocol bit) + node key balances |
| `accountToNodeAddr` | `sentnode` | Node PDA via `findProgramAddressSync` |
| plans for node | `plan.plans` | leases on node (`dvpnctl lease search`, filtered) |
| sessions | `sessionsForNode` | daemon `node sessions` + on-chain channels (`channel search`, filtered) |
| `withdrawFromNode` | `MsgSend` | `withdraw-node-revenue --amount <revenue>` → node ATA → `transferChecked` to the destination (default: app wallet) |
| `updateNodePricing` | `MsgUpdateNodeDetails` | patch `[prices]` (3 fields) → restart → confirmed by `node show` |
| **change protocol** (new) | none (2 fixed types) | patch `service` + pin that service's ports into the node's block + strip REALITY → restart → bit confirmed by `node show` |
| **test node** (new) | none | client container from the same image: `dvpnd init --role client --owner <app wallet>` with the app wallet key, `session start --node <PDA> --new-channel --mode voucher --escrow 200000`, `curl` 1 MB through the tunnel, `session stop`, then the node `redeem`. Reports bytes (client + node), tx sigs, revenue delta. The channel is start-closed; **`sweep test channels`** closes after the 7200 s grace and withdraws the user balance back |
| `removeNode` | stop + forget | `redeem` → stop container → `delist-node` → `close-node` (revenue auto-paid) → `unbonding` state with countdown → `withdraw-node-bond` → sweep node key tDVPN + SOL to the app wallet, close ATA. Stage stored in `removalStage`, resumable on relaunch |
| failed deploy | node purged | before `open_node`: sweep funds back; after: run the remove flow |
| `publishNodeSpecs` | self-MsgSend memo | SPL Memo signed by the node key, `specs:v1:` kept; read via `getSignaturesForAddress` |
| price modes | flat / oracle | flat only (no oracle in the program); USD box stays as an input helper |
| service types | wireguard / v2ray | **all 6** in the deploy picker + NodeDetails switcher, each with a one-line description (obfuscated WG, proxy, UDP/QUIC, etc.) |
| `classifyErr` | Cosmos rawLog | Anchor number → devnet name table (doc 14), plus lamports, blockhash, 429 |
| `metrics.ts` | `earnings_udvpn`, `chain_height` | migration → `earnings_base`, `slot` |
| settings | rpcUrls, chainId, gasPriceUdvpn | rpcUrls, `priorityFeeMicroLamports`; program/mint read-only |
| CLI (`cli-registry.ts`, `cli-server.ts`, `renderer/lib/cli.ts`) | Cosmos commands | rewired + `nodes.redeem`, `nodes.relist`, `nodes.setProtocol`, `nodes.test`, `nodes.withdrawBond`, `nodes.sweepTestChannels`, `wallet.importKey` |
| Renderer (Wallet, WalletSetup, DeployLocal/Ssh/Batch, NodeDetails, Nodes, Settings, Help, Activity, OnChainSpecs, Progress) | `sent1`, udvpn, Msg* | base58, SOL + tDVPN, 3 prices, protocol picker/switcher, Test-node panel, unbonding countdown, listing expiry, explorer links `?cluster=devnet` |
| `shared/types.ts` + IPC | Cosmos fields | `nodeOwner`, `nodePda`, `nodeId`, `portBlock`, `protocol`, `tlsSha256`, `balanceSOL`, `removalStage`, `unbondsAt`, price triple, `TestResult`; new channels wired through enum → main broadcast → preload subscribe |

## Verified at runtime (2026-10-14)

- dvpnd SetupEgress writes /proc/sys/net/ipv4/ip_forward itself: containers run with MaskedPaths/ReadonlyPaths = [] (CLI: --security-opt systempaths=unconfined). net.* sysctls are per network namespace.
- Docker Desktop (WSL2 6.6 kernel) has the wireguard module (kernel WG works in containers) but no amneziawg module: AmneziaWG uses amneziawg-go.
- V2Ray / Xray clients are SOCKS proxies on 127.0.0.1:1080, not tunnels; the self-test downloads through the proxy.
- A node on the LAN IP is reachable from a client container directly (no hairpin DNAT needed on Docker Desktop).
- Ubuntu hosts (AppArmor docker-default) also need `apparmor=unconfined` for the same /proc/sys writes.
- A host amneziawg kernel module older than the image's AmneziaWG 2.0 tools rejects H1–H4; the image's awg-quick honours
  `AWG_FORCE_USERSPACE=1` (set on every container) and uses amneziawg-go.
- Remote command lines use strict POSIX single quotes (shell-quote escaped `!` as `\!`, breaking scripts).
- sshd caps channels per connection: every SFTP upload ends its session.
- Same-host self-test (client on the node's host): hairpin DNAT to the node container IP, kill switch off.
- SSH credentials are memory-only; after an app restart `nodes.reconnect` re-attaches them per host and stalled
  removals resume.
- `node heartbeat` skips a still-fresh listing; `nodes.relist` sends `list_node` directly.

## Final results (2026-10-14)

| run | pass | fail | skip | notes |
|---|---|---|---|---|
| local, Docker Desktop (Windows) | 55 | 0 | 2 | AmneziaWG client host limitation (no nft_fib_ipv6); time-gated finish |
| remote, Ubuntu 24.04 over SSH | 55 | 0 | 2 | inspect: provider firewall admits only 22/443; time-gated finish |

All six protocols carried a paid session (1 MB) with revenue +1960 base units each, verified on chain.

## Invariants added by the 2026-10-14 audit

- A node record is never forgotten while its key holds tDVPN, a token account, or more
  than rent dust in SOL — not by removal, not by reap-stuck, not by failed-deploy recovery.
- `chainNodeId`/`nodePda` are written before `open_node`; recovery asks the chain whether
  the node exists instead of trusting the stage the deploy reached.
- The unbonding account is read at `["node_unbonding", owner, node_id]`; an empty
  `unbonding search` is never evidence that no bond exists.
- Every node-signed stage first tops the key up to ≥ 0.002 SOL from the app wallet.
- Program params, pause mask and the minimum bond are read before the funding tx.
- `sendTx` never re-signs while the previous transaction's blockhash is still valid.
- dvpnctl homes use the health-checked RPC (`pickRPC`), and the node key copy under
  `ctl/keys/` exists only for the duration of the call.
