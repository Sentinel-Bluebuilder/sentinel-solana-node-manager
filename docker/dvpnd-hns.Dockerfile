# ─── Node image 0.3.7: prebuilt 0.3.0 + HNS DNS routing for users (H2, mode B) + hnsd supervisor (T5, quiet log, kept checkpoint, sync status to the tip, one memory trim after the first sync; DNS relayed by Hysteria2/V2Ray/Xray goes to the split resolver) ───
# A thin layer on the released, SHA-256-pinned 0.3.0 image: the daemon and protocol tools are
# byte-identical; only dnsmasq, the ICANN TLD list and the entrypoint wrapper are added. No
# daemon source is needed to build it.
#   docker build -f docker/dvpnd-hns.Dockerfile -t node-manager/dvpnd:prebuilt-0.3.7 docker/
ARG BASE=node-manager/dvpnd:prebuilt-0.3.0
FROM ${BASE}

RUN apk add --no-cache dnsmasq unbound

# IANA list (docker/icann-tlds.txt, pinned in the repo): these TLDs go to 1.1.1.1, the rest to hnsd.
COPY icann-tlds.txt /etc/nm-hns/icann-tlds.txt
COPY node-entrypoint.sh /usr/local/sbin/node-entrypoint
# 0.3.2 (T5): the daemon starts `hnsd` from PATH; /usr/local/sbin comes first, so this supervisor
# runs and keeps the real /usr/local/bin/hnsd alive. Without it any hnsd exit stopped the node.
COPY hnsd-supervisor.sh /usr/local/sbin/hnsd

RUN <<'EOF'
set -eu
d=/etc/nm-hns
{
  echo "# Generated at image build from icann-tlds.txt. See /usr/local/sbin/node-entrypoint."
  echo "port=53"
  echo "bind-dynamic"
  echo "no-resolv"
  echo "no-hosts"
  # Not root: the entrypoint redirects port 53 sent by root back to dnsmasq (0.3.7).
  echo "user=dnsmasq"
  echo "cache-size=4096"
  echo "dns-forward-max=1000"
  echo "server=127.0.0.1#5351"
  grep -v '^#' "$d/icann-tlds.txt" | tr 'A-Z' 'a-z' | awk 'NF { print "server=/" $1 "/1.1.1.1"; print "server=/" $1 "/1.0.0.1" }'
} > "$d/dnsmasq.conf"
n=$(grep -c '^server=/' "$d/dnsmasq.conf")
[ "$n" -gt 2000 ] || { echo "ICANN TLD list too short: $n server lines"; exit 1; }
dnsmasq --test --conf-file="$d/dnsmasq.conf"
# Non-ICANN names: recursion from hnsd's ROOT server (127.0.0.1:5349, answers from the HNS chain
# hnsd verifies itself). Not hnsd's own recursive resolver (:5350): it validates ICANN DNSSEC
# against a stale built-in root (H2 2026-11-12: ".com ... no keys have a DS with algorithm
# RSASHA256"), marks .com/.org invalid and then fails every HNS name with an ICANN-hosted
# nameserver. Iterator only, so that stale data never decides.
cat > "$d/unbound.conf" <<'U'
server:
  interface: 127.0.0.1@5351
  access-control: 127.0.0.0/8 allow
  do-not-query-localhost: no
  module-config: "iterator"
  chroot: ""
  directory: "/etc/nm-hns"
  pidfile: "/run/nm-unbound.pid"
  use-syslog: no
  logfile: ""
  verbosity: 0
  harden-referral-path: no
  cache-max-ttl: 3600
  msg-cache-size: 8m
  rrset-cache-size: 16m
  num-threads: 1
  username: "unbound"
stub-zone:
  name: "."
  stub-addr: 127.0.0.1@5349
U
unbound-checkconf "$d/unbound.conf"
chown -R root:root "$d" /usr/local/sbin/node-entrypoint /usr/local/sbin/hnsd
chmod 0644 "$d"/*
chmod 0755 "$d" /usr/local/sbin/node-entrypoint /usr/local/sbin/hnsd
[ "$(command -v hnsd)" = /usr/local/sbin/hnsd ] || { echo "hnsd supervisor is not first on PATH"; exit 1; }
[ -x /usr/local/bin/hnsd ] || { echo "real hnsd missing at /usr/local/bin/hnsd"; exit 1; }
[ "$(id -u dnsmasq)" != 0 ] && [ "$(id -u unbound)" != 0 ] || { echo "dnsmasq/unbound must not run as root (port 53 redirect loop)"; exit 1; }
# Same trusted-tool rule as the base image: root-owned, not group/world-writable, up to /.
bad=0
for p in /usr/local/sbin/node-entrypoint /usr/local/sbin/hnsd "$(command -v dnsmasq)" "$(command -v unbound)" "$d/dnsmasq.conf" "$d/unbound.conf"; do
  p=$(readlink -f "$p")
  while :; do
    set -- $(stat -c '%u %g %a' "$p")
    if [ "$1" != 0 ] || [ "$2" != 0 ] || [ $(( 0$3 & 022 )) -ne 0 ]; then echo "untrusted: $p"; bad=1; fi
    [ "$p" = / ] && break
    p=$(dirname "$p")
  done
done
[ "$bad" -eq 0 ]
cat >> /usr/share/licenses/node-image/NOTICES <<'N'

Added in node image 0.3.1:
- dnsmasq (Alpine package): GPL-2.0 or GPL-3.0. Source: https://thekelleys.org.uk/dnsmasq/
- unbound (Alpine package): BSD-3-Clause. Source: https://github.com/NLnetLabs/unbound
- ICANN TLD list from IANA (https://data.iana.org/TLD/tlds-alpha-by-domain.txt), public data.
N
EOF

ENTRYPOINT ["/usr/local/sbin/node-entrypoint"]
