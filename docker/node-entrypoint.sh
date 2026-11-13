#!/bin/sh
# ─── node-entrypoint: HNS DNS routing for the node's users (0.3.1, H2 mode B; local DNS redirect 0.3.7) ───
# Runs as PID 1 of the node container, sets up DNS routing, then execs the daemon with the same
# arguments the app passes. Root-owned, part of the image (never written by the app).
#
# When config.toml has `[handshake_dns] enabled = true` (the daemon then runs hnsd on
# 127.0.0.1:5350):
#   - dnsmasq listens on port 53 on every interface except the public one. It sends names under
#     ICANN top-level domains to 1.1.1.1 / 1.0.0.1 and everything else (Handshake names) to a
#     local unbound (127.0.0.1:5351) that recurses from hnsd's root server (127.0.0.1:5349).
#     H2 (2026-11-12): hnsd's own recursive resolver (:5350) fails ICANN DNSSEC against a stale
#     built-in root, so neither user ICANN names nor HNS nameserver lookups go through it.
#   - WireGuard / AmneziaWG / OpenVPN: port 53 (udp+tcp) arriving on a tunnel interface is
#     redirected to dnsmasq, whatever DNS server the client asked for.
#   - V2Ray / Xray / Hysteria2: the node resolves destinations itself, so the container's
#     resolv.conf points at dnsmasq.
#     A DNS packet such a server relays for a user (Hysteria2 UDP, V2Ray/Xray UDP) leaves the
#     container from a root process to the address the client chose: port 53 sent by root is
#     redirected to dnsmasq as well (0.3.7). dnsmasq and unbound run as their own users.
# Off (or no config): nothing is changed. Docker rewrites resolv.conf and the network namespace
# at every container start, so turning HNS off and restarting leaves no trace.
# A failure here never stops the node: it logs and starts the daemon without HNS routing.

CFG=/root/.dvpnd/config.toml
TABLE=nm_hns
log() { echo "node-entrypoint: $*" >&2; }

hns_enabled() {
  [ -f "$CFG" ] || return 1
  awk '
    /^[[:space:]]*\[/ { s = ($0 ~ /^[[:space:]]*\[handshake_dns\][[:space:]]*$/) ; next }
    s && /^[[:space:]]*enabled[[:space:]]*=/ { v = $0; sub(/^[^=]*=[[:space:]]*/, "", v); sub(/[[:space:]#].*$/, "", v); last = v }
    END { exit !(last == "true") }
  ' "$CFG"
}

setup_hns() {
  out=$(ip route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
  [ -n "$out" ] || out=eth0
  # Recursion for non-ICANN names from hnsd's root server (127.0.0.1:5349); see the Dockerfile.
  if ! unbound -c /etc/nm-hns/unbound.conf; then
    log "unbound did not start; HNS names will not resolve for users"
    return 1
  fi
  if ! dnsmasq --conf-file=/etc/nm-hns/dnsmasq.conf --except-interface="$out"; then
    log "dnsmasq did not start; HNS names will not resolve for users"
    return 1
  fi
  if ! nft -f - <<EOF
table inet $TABLE {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname != { "lo", "$out" } udp dport 53 redirect to :53
    iifname != { "lo", "$out" } tcp dport 53 redirect to :53
  }
  # 0.3.7: Hysteria2 (and UDP relayed by V2Ray/Xray) has no tunnel interface: the server process
  # sends the user's DNS packet to 1.1.1.1 itself, so prerouting never sees it (P15 a7a557d:
  # nathan.woodburn NXDOMAIN over hysteria2). Redirect port 53 sent by root (the daemon and the
  # protocol servers). dnsmasq and unbound run as their own users, so their upstream queries are
  # not looped back.
  chain output {
    type nat hook output priority -100; policy accept;
    meta skuid 0 oifname != "lo" udp dport 53 redirect to :53
    meta skuid 0 oifname != "lo" tcp dport 53 redirect to :53
  }
}
EOF
  then
    log "nft redirect failed; tunnel clients keep their own DNS server"
  fi
  # Write in place: /etc/resolv.conf is a bind mount and cannot be replaced.
  if cp /etc/resolv.conf /run/resolv.conf.docker 2>/dev/null && printf 'nameserver 127.0.0.1\noptions ndots:0\n' > /etc/resolv.conf; then
    :
  else
    log "could not point resolv.conf at dnsmasq; proxy protocols keep Docker's resolver"
  fi
  log "HNS routing on (public interface $out; ICANN names -> 1.1.1.1, other names -> hnsd)"
}

nft delete table inet "$TABLE" 2>/dev/null
if hns_enabled; then
  setup_hns || log "continuing without HNS routing"
else
  log "HNS routing off"
fi

# Test hook for the image build and e2e (no daemon): set up, then idle.
[ "${1:-}" = "--nm-hns-selftest" ] && exec sleep 2147483647

exec sentinel-dvpnd "$@"
