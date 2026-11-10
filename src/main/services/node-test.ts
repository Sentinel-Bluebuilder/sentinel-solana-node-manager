import crypto from 'node:crypto';
import { NODE_ENV, NODE_HOME, localCtlImageTag } from './docker';
import { withRuntime } from './node-runtime';
import { appKeypair } from './wallet';
import { keypairToJson } from './keys';
import { ctlConfigToml } from './dvpnctl';
import { cliLayoutOf } from './cli-probe';
import type { CliLayout } from './cli-layout';
import { pickRPC } from './solana-client';
import { addEvent } from './events';
import net from 'node:net';
import { getNode, getSSH, chainNode, redeemNow, nodeAnswersOnHost, nodePorts } from './node-manager';
import { recordTestChannel, walletChannelsTo } from './test-channels';
import { RESERVED_RUNTIME_HOME_IDS } from './validate';
import { log } from './logger';
import type { DeployedNode, NodeTestResult } from '../../shared/types';

/**
 * "Test node" — a real paid session against one of our nodes, run entirely
 * from the app:
 *
 *   a throwaway CLIENT container (same image, own network namespace, so its
 *   full tunnel + kill switch cannot touch this machine) runs `dvpnd` in the
 *   client role signing with the APP WALLET key, opens a voucher channel to
 *   the node, fetches TEST_BYTES through the tunnel, stops the session; then
 *   the node is asked to redeem and the on-chain revenue delta is reported.
 *
 * Hairpin fallback: a node on this machine advertises its LAN IP. If the
 * client container cannot reach that IP:port directly, one nft DNAT rule maps
 * it to the Docker host gateway before the session starts.
 *
 * The wallet key file exists only inside the per-run temp dir (0600) and the
 * dir is deleted when the run ends.
 */

const TEST_ESCROW_BASE = 200_000; // 0.2 tDVPN
const TEST_BYTES = 1_000_000;
const TEST_URL = `https://speed.cloudflare.com/__down?bytes=${TEST_BYTES}`;

const CLIENT_SCRIPT = String.raw`
set -u
H=/root/.dvpnd/$TC
# The daemon socket is named in $H/ctl/config.toml (no flag: older and newer dvpnctl spell it differently).
# LAYOUT=cb33 (public sentinel-solana 26de5240): sentinel-dvpnd / sentinel-dvpn, instance c1, flat home
# (config.toml + keys/operator.json + <service>/), RPC passed as run flags (the flat config.toml also
# holds [tx.paymaster] url, which a blanket "url =" edit would overwrite), --instance on daemon calls.
if [ "$LAYOUT" = "cb33" ]; then
  D="sentinel-dvpnd --instance c1 --home $H"
  C="sentinel-dvpn --home $H/ctl --output json"
  CI="--instance c1"
  CKEY=$H/keys/operator.json
  CCFG=$H/config.toml
else
  D="dvpnd"
  C="dvpnctl --home $H/ctl --output json"
  CI=""
  CKEY=$H/client/keys/device.json
  CCFG=$H/client/config.toml
fi
trap 'rm -rf "$H"' EXIT
# AmneziaWG clients add an IPv6 kill-switch rule that needs nft fib for ip6.
# Docker Desktop's WSL2 kernel lacks nft_fib_ipv6, so the client cannot run there.
if [ "$SERVICE" = "amneziawg" ]; then
  if ! nft -f - >/dev/null 2>&1 <<NFT
add table ip6 snm_cap
add chain ip6 snm_cap c { type filter hook prerouting priority -300; }
add rule ip6 snm_cap c fib saddr type != local drop
NFT
  then echo "UNSUPPORTED kernel lacks nft_fib_ipv6 (IPv6 fib), which the AmneziaWG client kill switch needs"; exit 20; fi
  nft delete table ip6 snm_cap >/dev/null 2>&1
fi
echo "STEP init"
mkdir -p $H
if [ "$LAYOUT" = "cb33" ]; then
  $D init --owner "$OWNER" --plain-key --force > $H/init.log 2>&1 || { echo "FAIL init"; echo LOG_BEGIN; cat $H/init.log; echo LOG_END; exit 10; }
else
  dvpnd init --role client --home $H --owner "$OWNER" --plain-key --force > $H/init.log 2>&1 || { echo "FAIL init"; echo LOG_BEGIN; cat $H/init.log; echo LOG_END; exit 10; }
  sed -i "s#^url = .*#url = '$RPC'#; s#^ws_url = .*#ws_url = '$WS'#" $H/config.toml
fi
# The wallet key over the generated key: signer = owner, so no grant is needed.
install -m 600 $H/wallet.json $CKEY
# Older dvpnd names the key dns, newer (ddv18.32+) and cb33 dns_backend (cb33: under [network]).
sed -i -E "s#^(dns|dns_backend) = .*#\1 = 'resolvconf'#" $CCFG
HP=$(echo "$NODE_URI" | sed -E 's#^https?://##')
NH=$(echo "$HP" | cut -d: -f1)
NP=$(echo "$HP" | cut -d: -f2)
echo "STEP reach $NH:$NP"
CODE=$(curl -sk -m 6 -o /dev/null -w '%{http_code}' "https://$NH:$NP/v1/metadata" || true)
# Same-host client: a container calling the host's public IP lands on the host's
# INPUT chain (often firewalled, e.g. ufw). Map the node's address straight to the
# node container's bridge IP (container-to-container is allowed), else the gateway.
if [ "$CODE" = "000" ] && [ -n "$NO_HAIRPIN" ]; then echo "FAIL unreachable $NH:$NP"; exit 13; fi
# Hysteria2 (QUIC) moves 0 B when a client dials its own host's public IP, even where that host
# hairpins full-size UDP and wg/awg pass on the same port (FS36 S13 run 2, Azure, 2026-11-07). So a
# same-host hy2 test always goes to the node container directly; the outside-client test covers the
# public path.
if [ "$SERVICE" = "hysteria2" ] && [ -z "$NO_HAIRPIN" ] && [ -n "$NODE_IP" ] && [ "$CODE" != "000" ]; then
  echo "STEP hairpin $NH -> $NODE_IP (hysteria2 same-host: QUIC does not survive the host's own public IP)"
  nft add table ip snm_hairpin
  nft add chain ip snm_hairpin out '{ type nat hook output priority -100; }'
  if [ -n "$PORTS" ]; then nft add rule ip snm_hairpin out ip daddr "$NH" meta l4proto '{ tcp, udp }' th dport "{ $PORTS }" dnat to "$NODE_IP"; else nft add rule ip snm_hairpin out ip daddr "$NH" dnat to "$NODE_IP"; fi
  CODE=$(curl -sk -m 6 -o /dev/null -w '%{http_code}' "https://$NH:$NP/v1/metadata" || true)
  echo "FORCED_HAIRPIN hysteria2"
fi
if [ "$CODE" = "000" ]; then
  GW="$NODE_IP"
  [ -n "$GW" ] || GW=$(getent hosts host.docker.internal | awk '{print $1}' | head -1)
  if [ -n "$GW" ]; then
    echo "STEP hairpin $NH -> $GW"
    nft add table ip snm_hairpin
    nft add chain ip snm_hairpin out '{ type nat hook output priority -100; }'
    if [ -n "$PORTS" ]; then nft add rule ip snm_hairpin out ip daddr "$NH" meta l4proto '{ tcp, udp }' th dport "{ $PORTS }" dnat to "$GW"; else nft add rule ip snm_hairpin out ip daddr "$NH" dnat to "$GW"; fi
    CODE=$(curl -sk -m 6 -o /dev/null -w '%{http_code}' "https://$NH:$NP/v1/metadata" || true)
  fi
fi
echo "REACH $CODE"
# The hairpin DNAT runs in nat OUTPUT, before the kill switch's filter OUTPUT, so
# the kill switch would see tunnel packets bound for the container IP (not the
# node's public endpoint) and drop them. A same-host self-test only needs the
# data plane + payment, so it runs without the kill switch in that case.
if nft list table ip snm_hairpin >/dev/null 2>&1; then
  sed -i "s#^kill_switch = .*#kill_switch = 'off'#" $CCFG
  echo "STEP kill-switch off (same-host hairpin)"
fi
echo "STEP daemon"
if [ "$LAYOUT" = "cb33" ]; then
  $D run --rpc.url "$RPC" --rpc.ws-url "$WS" > $H/client.log 2>&1 &
else
  dvpnd start --home $H > $H/client.log 2>&1 &
fi
DP=$!
i=0; while [ $i -lt 90 ] && ! grep -q '"message":"ready"' $H/client.log 2>/dev/null; do i=$((i+1)); sleep 1; done
grep -q '"message":"ready"' $H/client.log || { echo "FAIL daemon-not-ready"; echo LOG_BEGIN; echo "daemon pid alive: $(kill -0 $DP 2>/dev/null && echo yes || echo no)"; ls -la $H; tail -30 $H/client.log; tail -5 $H/init.log; echo LOG_END; kill -TERM $DP; exit 11; }
echo "STEP session-start"
# Newer dvpnctl (ddv18.32+) moved client sessions under "client" and renamed the escrow flag.
if $C client --help >/dev/null 2>&1; then S="client"; EF="--escrow-base-units"; else S="session"; EF="--escrow"; fi
OUT=$($C $S start $CI --node "$NODE" --new-channel --mode voucher $EF "$ESCROW" 2>&1); RC=$?
# A host outside our network reaches Solana through public devnet, which answers bursts with
# 429 "rate limits exceeded" (e2e 11-10, arm64 VPS). Retry once after a pause, as a real client
# would; a channel the failed try opened is found by the before/after channel diff and swept.
if [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -qiE 'rate limit|429'; then
  echo "RETRY session-start after an RPC rate limit"; sleep 15
  OUT=$($C $S start $CI --node "$NODE" --new-channel --mode voucher $EF "$ESCROW" 2>&1); RC=$?
fi
echo "SESSION_START_RC $RC"
echo "SESSION_START_BEGIN"; echo "$OUT"; echo "SESSION_START_END"
SID=$(echo "$OUT" | grep -oE '"(id|session_id|sessionId)": *"[^"]+"' | head -1 | sed -E 's/.*: *"([^"]+)"/\1/')
[ -n "$SID" ] || { echo "FAIL session-start"; echo ERR_BEGIN; grep -iE '"level":"(error|warn)"|error|failed' $H/client.log | grep -v "amnezia-vpn/amneziawg-linux-kernel-module" | tail -8; echo ERR_END; echo LOG_BEGIN; tail -40 $H/client.log; echo LOG_END; kill -TERM $DP; wait $DP; exit 12; }
echo "SID $SID"
sleep 4
echo "STEP download"
# V2Ray/Xray clients are SOCKS proxies (client proxy_port 1080), not tunnels.
# The tunnel can still be coming up right after session start (seen on Hysteria2):
# retry like a real client would, and report how many attempts it took.
BYTES=0; TRY=0
while [ $TRY -lt 4 ]; do
  TRY=$((TRY+1))
  if [ -n "$PROXY" ]; then BYTES=$(curl -s -m 90 -x "$PROXY" -o /dev/null -w '%{size_download}' "$URL" || echo 0); else BYTES=$(curl -s -m 90 -o /dev/null -w '%{size_download}' "$URL" || echo 0); fi
  BYTES=$(printf '%s' "$BYTES" | head -c 12 | tr -cd '0-9'); [ -n "$BYTES" ] || BYTES=0
  [ "$BYTES" -ge 990000 ] && break
  sleep 3
done
echo "ATTEMPTS $TRY"
echo "DOWNLOADED $BYTES"
echo "STATUS_BEGIN"; $C $S status $CI "$SID" 2>&1; echo "STATUS_END"
echo "STEP stop"
$C $S stop $CI "$SID" >/dev/null 2>&1
sleep 3
kill -TERM $DP; wait $DP
echo "LOG_BEGIN"; tail -25 $H/client.log; echo "LOG_END"
# How the client metered the session (vouchers it issued, peer stats it read).
echo "METER_BEGIN"; grep -iE "voucher|peer stats|stats unavailable" $H/client.log | tail -15; echo "METER_END"
echo "DONE"
`;

function between(out: string, a: string, b: string): string {
  const i = out.indexOf(a);
  const j = out.indexOf(b, i + a.length);
  return i >= 0 && j > i ? out.slice(i + a.length, j).trim() : '';
}

function findNumber(text: string, keys: string[]): number | undefined {
  for (const k of keys) {
    const m = new RegExp(`"${k}"\\s*:\\s*"?(\\d+)`).exec(text);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** TCP reachability of host:port from this machine (what any real client needs first). */
function tcpReachable(host: string, port: number, timeoutMs = 6_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function withHostRuntime<T>(node: DeployedNode, fn: (rt: import('./node-runtime').NodeRuntime) => Promise<T>): Promise<T> {
  return withRuntime(node, getSSH(node.id), fn);
}

/**
 * Scratch home on this machine for the outside-client test (UUID shape required by the
 * runtime). Taken from the shared reserved list so host-leftover cleanup passes over it
 * instead of reporting it as an unexplained directory on every run.
 */
const HERE_CLIENT_ID = RESERVED_RUNTIME_HOME_IDS[0];

export async function testNode(nodeId: string, opts: { onStep?: (s: string) => void; clientOn?: 'host' | 'here' } = {}): Promise<NodeTestResult> {
  const clientOn = opts.clientOn ?? 'host';
  const t0 = Date.now();
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
    opts.onStep?.(s);
  };
  const node = await getNode(nodeId);
  if (!node) return { ok: false, nodeId, serviceType: 'wireguard', durationMs: 0, steps, error: 'Node not found' };
  const result: NodeTestResult = { ok: false, nodeId, serviceType: node.serviceType, durationMs: 0, steps, clientOn };
  const tc = `test-client-${crypto.randomUUID().slice(0, 8)}`;
  // Wallet channels to this node before the client ran (see walletChannelsTo).
  let channelsBefore: Set<string> | undefined;
  let nodePda: string | undefined;
  try {
    const chain = await chainNode(node);
    nodePda = chain?.address;
    if (!chain || chain.status !== 1) throw new Error('The node is not listed on chain, so a client cannot discover it.');
    result.revenueBefore = chain.revenue;
    step(`node ${chain.address} listed · ${chain.uri} · protocol bits ${chain.protocols} · revenue ${chain.revenue}`);

    if (clientOn === 'here' && node.target === 'remote') {
      // Probe before paying: if this machine cannot even open the API port while the
      // node answers on its own host, the block is upstream and no channel is opened.
      const u = new URL(chain.uri);
      const port = Number(u.port) || 443;
      step(`outside client: probing ${u.hostname}:${port} from this machine`);
      if (!(await tcpReachable(u.hostname, port))) {
        const selfOk = await nodeAnswersOnHost(node);
        if (selfOk) {
          result.directReach = false;
          result.blockedUpstream = `This machine cannot reach ${chain.uri}, but the node answers on its own host${node.firewallOpened ? ' and the host ufw rules are in place' : ''}: the block is upstream of the host (cloud provider firewall / security group). Open TCP+UDP ${node.port}–${node.port + 4} there; nothing was spent.`;
          result.error = result.blockedUpstream;
          step(`blocked upstream: ${result.blockedUpstream}`);
          result.durationMs = Date.now() - t0;
          return result;
        }
        step(`not reachable from here and the on-host check ${selfOk === false ? 'failed too (node problem)' : 'could not run'} — running the client anyway for the full diagnosis`);
      }
    }

    const wallet = await appKeypair();
    // The client may run on the node's VPS: it needs an RPC reachable from there, not a LAN/VPC gateway.
    const rpcFor = (rt: import('./node-runtime').NodeRuntime) => pickRPC({ forRemoteHost: rt.kind === 'remote' });
    const runClient = (rt: import('./node-runtime').NodeRuntime, nodeIp: string | undefined, layout: CliLayout, rpcUrl: string) =>
      rt.runOnce(['/bin/sh', '-c'], [CLIENT_SCRIPT], {
      timeoutMs: 6 * 60_000,
      onLog: (chunk) => {
        for (const line of chunk.split(/\r?\n/)) if (/^(STEP|REACH|SID|ATTEMPTS|DOWNLOADED|FAIL|UNSUPPORTED|FORCED_HAIRPIN)/.test(line)) step(line.trim());
      },
      extra: {
        capAdd: ['NET_ADMIN', 'NET_RAW'],
        tun: true,
        unmaskSysPaths: true,
        sysctls: { 'net.ipv4.conf.all.src_valid_mark': '1', 'net.ipv6.conf.all.disable_ipv6': '0' },
        extraHosts: ['host.docker.internal:host-gateway'],
        env: [
          ...NODE_ENV,
          `OWNER=${wallet.publicKey.toBase58()}`,
          `NODE=${chain.address}`,
          `NODE_URI=${chain.uri}`,
          `ESCROW=${TEST_ESCROW_BASE}`,
          `URL=${TEST_URL}`,
          `PROXY=${node.serviceType === 'v2ray' || node.serviceType === 'xray' ? 'socks5h://127.0.0.1:1080' : ''}`,
          `RPC=${rpcUrl}`,
          `WS=${rpcUrl.replace(/^http/, 'ws')}`,
          `TC=${tc}`,
          `NODE_IP=${nodeIp ?? ''}`,
          // The hairpin maps only the node's own ports: anything else on that IP (an RPC
          // gateway, a local validator) must keep going to the host.
          `PORTS=${nodePorts(node).join(',')}`,
          `SERVICE=${node.serviceType}`,
          `LAYOUT=${layout}`,
          // An outside client must reach the public URI itself: no hairpin fallback.
          `NO_HAIRPIN=${clientOn === 'here' && node.target === 'remote' ? '1' : ''}`,
        ],
      },
    });
    channelsBefore = await walletChannelsTo(chain.address, node.imageTag).catch((err: unknown) => {
      log.warn('could not list wallet channels before the test; a channel from a failed start will not be found', { err: (err as Error).message });
      return undefined;
    });
    const clientRuntime = <T,>(fn: (rt: import('./node-runtime').NodeRuntime) => Promise<T>) =>
      clientOn === 'here' && node.target === 'remote'
        ? // Runs on LOCAL Docker: the remote node's own image is on its VPS, not here (Q0328).
          localCtlImageTag(node.imageTag).then((imageTag) => withRuntime({ id: HERE_CLIENT_ID, target: 'local', runtimeId: undefined, host: undefined, imageTag }, undefined, fn))
        : withHostRuntime(node, fn);
    const run = await clientRuntime(async (rt) => {
      await rt.writeFile(`${tc}/wallet.json`, keypairToJson(wallet), 0o600);
      await rt.writeFile(`${tc}/ctl/keys/owner.json`, keypairToJson(wallet), 0o600);
      const rpcUrl = await rpcFor(rt);
      await rt.writeFile(`${tc}/ctl/config.toml`, ctlConfigToml(rpcUrl, `${NODE_HOME}/${tc}/daemon.sock`), 0o600);
      // On the node's own host the client may hairpin to the node container; from
      // this machine it must dial the public URI like any real client.
      const nodeIp =
        rt.kind === 'local' && node.target === 'remote'
          ? undefined
          : await rt.containerIp().catch((err: unknown) => {
              log.debug('node container ip lookup failed', { err: (err as Error).message });
              return undefined;
            });
      step(`client container on ${rt.kind === 'local' && node.target === 'remote' ? 'this machine (outside client)' : rt.label}: wallet ${wallet.publicKey.toBase58()} pays a voucher channel (escrow ${TEST_ESCROW_BASE})`);
      try {
        return await runClient(rt, nodeIp, await cliLayoutOf(rt), rpcUrl);
      } finally {
        // The script's EXIT trap removes the whole test dir; if the container never
        // started (Docker error) the wallet key would stay on the host — remove it.
        for (const rel of [`${tc}/wallet.json`, `${tc}/ctl/keys/owner.json`, `${tc}/client/keys/device.json`, `${tc}/keys/operator.json`]) {
          await rt.removeFile(rel).catch((err: unknown) => log.warn('test client key cleanup failed', { rel, err: (err as Error).message }));
        }
      }
    });
    const out = run.output;
    const unsupported = /^UNSUPPORTED (.+)$/m.exec(out)?.[1];
    if (unsupported) {
      const where = node.target === 'local' || clientOn === 'here' ? 'this machine' : node.host;
      result.unsupported = `${node.serviceType} client cannot run on ${where}: ${unsupported}. The node side is unaffected; test from a Linux host with full nftables (e.g. deploy over SSH).`;
      throw new Error(result.unsupported);
    }
    const reach = /^REACH (\d+)$/m.exec(out)?.[1];
    // A forced hy2 hairpin happens only after the public URI already answered, so that still counts as direct.
    const forcedHairpin = /^FORCED_HAIRPIN /m.test(out);
    result.directReach = reach !== undefined && reach !== '000' && (forcedHairpin || !/^STEP hairpin/m.test(out));
    if (forcedHairpin) step('hysteria2 data went to the node container directly (same-host QUIC cannot use the public IP); the outside-client test covers the public path');
    if (/^FAIL unreachable/m.test(out)) {
      throw new Error(`This machine cannot reach ${chain.uri} (the node's public URI). Open TCP+UDP ${node.port}–${node.port + 4} in the host and cloud firewalls; the node itself is fine if the on-host test passes.`);
    }
    const start = between(out, 'SESSION_START_BEGIN', 'SESSION_START_END');
    result.sessionId = /^SID (.+)$/m.exec(out)?.[1]?.trim();
    result.channel = /"channel"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(start)?.[1];
    if (result.channel) await recordTestChannel(result.channel, chain.address);
    result.downloadedBytes = Number(/^DOWNLOADED (\d+)/m.exec(out)?.[1] ?? 0);
    const status = between(out, 'STATUS_BEGIN', 'STATUS_END');
    const rx = findNumber(status, ['rx', 'rx_bytes', 'download_bytes', 'downloaded']);
    const tx = findNumber(status, ['tx', 'tx_bytes', 'upload_bytes', 'uploaded']);
    if (rx !== undefined || tx !== undefined) result.clientBytes = (rx ?? 0) + (tx ?? 0);
    if (status) step(`client session status: ${status.replace(/\s+/g, ' ').slice(0, 400)}`);
    if (run.exitCode !== 0 || !out.includes('\nDONE')) {
      const fail = /^FAIL (.+)$/m.exec(out)?.[1] ?? `exit ${run.exitCode}`;
      result.clientLog = between(out, 'LOG_BEGIN', 'LOG_END').slice(-4000);
      const errLines = between(out, 'ERR_BEGIN', 'ERR_END');
      if (errLines) step(`client errors: ${errLines.replace(/\s+/g, ' ').slice(-1500)}`);
      step(`client daemon log: ${between(out, 'LOG_BEGIN', 'LOG_END').replace(/\s+/g, ' ').slice(-900)}`);
      throw new Error(`client run failed (${fail}). Session start said: ${start.slice(0, 400) || '—'}\n${between(out, 'LOG_BEGIN', 'LOG_END').slice(-800) || out.slice(-800)}`);
    }
    step(`session ${result.sessionId} · downloaded ${result.downloadedBytes} B · client metered ${result.clientBytes ?? '?'} B`);
    const meter = between(out, 'METER_BEGIN', 'METER_END');
    if (meter) step(`client metering log: ${meter.replace(/\s+/g, ' ').slice(-1500)}`);
    if (result.clientBytes === 0 && (result.downloadedBytes ?? 0) > 0) {
      step(`note: the client reported 0 bytes used for a session that moved ${result.downloadedBytes} B (a dvpnd client metering question, not a node fault)`);
    }
    if (!result.downloadedBytes || result.downloadedBytes < TEST_BYTES * 0.99) {
      throw new Error(`Only ${result.downloadedBytes} of ${TEST_BYTES} bytes came through the tunnel.`);
    }

    step('node: redeem vouchers now');
    const r = await redeemNow(nodeId);
    if (!r.ok) step(`redeem: ${r.error}`);
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, 7_000));
      const after = await chainNode(node);
      result.revenueAfter = after?.revenue;
      if (after && after.revenue > (result.revenueBefore ?? 0)) break;
    }
    step(`revenue ${result.revenueBefore} → ${result.revenueAfter}`);
    if (!(result.revenueAfter !== undefined && result.revenueAfter > (result.revenueBefore ?? 0))) {
      throw new Error('The session ran but no revenue reached the node on chain after redeeming.');
    }
    result.ok = true;
    await addEvent({
      kind: 'node-test-passed',
      title: `Test session passed on ${node.moniker} (${node.serviceType})`,
      subtitle: `${result.downloadedBytes} B through the tunnel · revenue +${(result.revenueAfter ?? 0) - (result.revenueBefore ?? 0)}`,
      relatedNodeId: nodeId,
    });
  } catch (err) {
    result.error = (err as Error).message;
    step(`FAILED: ${result.error.split('\n')[0]}`);
    log.warn('node test failed', { nodeId, err: result.error.slice(0, 500) });
    await addEvent({ kind: 'node-test-failed', title: `Test session failed on ${node.moniker}`, subtitle: result.error.slice(0, 180), relatedNodeId: nodeId });
  } finally {
    if (channelsBefore && nodePda && !result.channel) {
      try {
        const opened = [...(await walletChannelsTo(nodePda, node.imageTag))].filter((c) => !channelsBefore?.has(c));
        for (const c of opened) {
          await recordTestChannel(c, nodePda);
          step(`channel ${c} was opened but session start did not report it — recorded for the test-channel sweep`);
        }
        if (opened.length === 1) result.channel = opened[0];
      } catch (err) {
        log.warn('could not list wallet channels after the test', { nodeId, err: (err as Error).message });
      }
    }
    result.durationMs = Date.now() - t0;
  }
  return result;
}
