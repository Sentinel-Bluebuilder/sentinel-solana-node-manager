# Upstream notes: hnsd in sentinel-dvpnd (found during Node Manager 0.3.1)

Findings from the Node Manager HNS work (Solana `sentinel-dvpnd` and, compared on 2026-11-12, the Cosmos `sentinel-dvpnx`), ready to file upstream (issue or PR on
`sentinel-official/sentinel-solana`). Node Manager works around all of them inside its own node image;
upstream fixes would make the workarounds unnecessary. Not filed yet: the bot's fork has issues
disabled, and filing them is a separate decision.

## 1. Any hnsd exit stops the whole node daemon

`sentinel-dvpnd/internal/node/runtime.go` `Serve` runs hnsd in the same `errgroup` as the API
server and the VPN service. `hnsd.go` `runHNSD` returns `service.ErrExited` on every exit that
is not a context cancel, so a crash (or OOM kill) of the optional DNS resolver cancels the group
and `sentinel-dvpnd` exits: every user session drops, the container restarts and the node
re-syncs with the chain.

- **Suggested fix:** restart hnsd inside `runHNSD` with backoff and log it, instead of returning
  an error. Or run it outside the errgroup and report its state in status.
- **Node Manager workaround (image 0.3.2):** `docker/hnsd-supervisor.sh`, installed as
  `/usr/local/sbin/hnsd` ahead of the real binary on PATH. It restarts hnsd with 5 s to 300 s
  backoff and stops it within the daemon's 5 s SIGTERM grace (`sentinel-go-sdk` `service/exec.go`
  `stopGrace`, `service_unix.go` `terminate`).
- **Evidence:** container test (hnsd SIGKILLed → back in 5 s under the same supervisor;
  supervisor SIGTERM → all hnsd gone in 0.8 s). Real-arm64 self-test row "supervisor restarts a
  killed hnsd".

## 2. hnsd's own recursive resolver fails many ICANN names

hnsd v2.0.0 (the version both the Cosmos `sentinel-dvpnx` and the Solana `sentinel-dvpnd` ship)
resolves ICANN names itself from a built-in root, and that view is stale. Measured 2026-11-12 with
the official Cosmos image `ghcr.io/sentinel-official/sentinel-dvpnx:latest` (created 2026-07-11),
hnsd started exactly as its node does (`--rs-host <addr>:53 --pool-size 8`), top 500 ICANN names:

| Resolver | failed | notes |
|---|---|---|
| 1.1.1.1 (reference) | 2/500 | |
| Cosmos hnsd recursor | 29/500 (7 SERVFAIL, 22 timeout) | 27/500 with DNSSEC checking off (`+cd`): not a DNSSEC problem only |
| Node Manager chain (dnsmasq → 1.1.1.1 / unbound → hnsd root) | 0 of the 12 re-tested failures | same host, same minute |

Names that work through 1.1.1.1 and fail through hnsd include claude.ai, t.me, telegram.me, bit.ly,
t.co, nasa.gov, cdc.gov, nih.gov, www.gov.uk, europa.eu, line.me, wa.me, yahoo.co.jp, amazon.co.jp,
cloud.microsoft. `.com`/`.org` mostly work; `.ai`, `.me`, `.gov`, `.co`, `.uk`, `.jp`, `.microsoft`
fail. Handshake names give identical answers through both paths (side-by-side, 2026-11-12).

**Who is hit on Cosmos:** the node binds hnsd's recursor directly on the tunnel gateway `:53`
(`node/setup.go serviceGatewayAddr`). A user who sets DNS to the gateway, as the Handshake dVPN
client recommends (`DNS = 10.8.0.1`), sends ALL lookups through it and loses those sites. The SDK
default DNS (OpenDNS) bypasses hnsd, so default users get no HNS at all.

- **Suggested fix:** don't expose hnsd's recursor to users. Split: ICANN TLDs to a normal
  recursor/forwarder, the rest to a recursor that starts at hnsd's ROOT server (`-n`, :5349).
- **Node Manager (image 0.3.1+):** dnsmasq on :53 (ICANN TLDs from the IANA list → 1.1.1.1/1.0.0.1),
  everything else → unbound (iterator only) → hnsd root `127.0.0.1:5349`; tunnel DNS on port 53 is
  redirected to it whatever server the client asked.

## 3. The checkpoint is never written (Solana `sentinel-dvpnd`), never asked for (Cosmos)

hnsd writes its temp checkpoint `~<height>` in its WORKING DIRECTORY and renames it into the `-x`
directory. `sentinel-dvpnd` starts hnsd from `/` with `-x /root/.dvpnd/hnsd`, which is on the image
VOLUME: the rename fails with EXDEV, every start re-syncs from height 0, and 35 KB temp files pile up
in `/`. Cosmos passes no `-x`, so it re-syncs on every start by design.

- **Suggested fix:** set `cmd.Dir` to the `-x` directory in `runHNSD` (Solana); pass `-x` (Cosmos).
- **Node Manager (image 0.3.4+):** the supervisor `cd`s into the `-x` directory and removes strays.
  Restart → back at the tip in 7 s instead of a full sync.

## 4. Memory: hnsd keeps every header it synced

Load study, GCP e2-small (2 vCPU, 2 GB), real hnsd only, from /proc:

| Phase | time | hnsd CPU | network | disk | RSS |
|---|---|---|---|---|---|
| first sync from height 0 | ~85 s | 30 CPU-s (peak 44% of one core) | 210 MB in, 1.3 MB out | 6.5 MB | 163 MB, then flat |
| steady state, 30 min | | 0.2 CPU-s (~0%) | ~0.7 MB/h in, 0.6 MB/h out | 0 | 163 MB, no drift |
| restart from checkpoint | 7 s to the tip | 0.3 CPU-s | 0.8 MB | 0 | **9 MB** |
| user lookups (per 1000) | | ICANN: dnsmasq 0.07–0.23 CPU-s, hnsd/unbound 0; HNS cold: hnsd 4 s + unbound 3 s, cached 0.15 + 0.2 s | | | unbound 9.6 MB, dnsmasq 2 MB |

A Cosmos node (no checkpoint) pays the first-sync row on EVERY restart.

- **Node Manager (image 0.3.6):** after a sync that began without a checkpoint, the supervisor
  restarts hnsd once from its checkpoint 60 s after the tip: 167 MB → 9.5 MB for the node's life.

## 5. Cosmos-only

- `hnsd/hnsd.go`: restarts at most `max_restarts` (default 5) times, 1 s apart, then the node fails.
- HNS works only with WireGuard and AmneziaWG; any other service type with HNS on fails node setup.
- hnsd output goes unfiltered into the node log: 6.9 M lines in the 15-minute test.

## Also worth knowing

- hnsd v2.0.0 finds peers on ports other than 12038/44806: blocking only those two did not stop
  it syncing (2026-11-12 test). A firewall must allow outbound TCP in general.
- Evidence: kept with the Node Manager test records (not in this repository).
