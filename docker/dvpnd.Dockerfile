# Sentinel dVPN node image for the Solana program (dvpnd + dvpnctl).
#
# Build context = the root of the patched sentinel-solana `upstream/` tree:
#   sentinel-dvpnd/  sentinel-dvpnctl/  sentinel-go-sdk/  sentinel-programs/clients/go/
# Both Go modules `replace` the SDK and the program client with those sibling
# directories, so the context must be the tree root (upstream's own per-repo
# Dockerfiles cannot build with the replaces in place).
#
# Build identity is link-time only: SENTINEL_NETWORK / SENTINEL_PROGRAM_ID /
# SENTINEL_MINT must all be passed, or the binaries fail closed at runtime.

# go.mod requires go >= 1.27.1; upstream's own Dockerfile still pins 1.26 and cannot build.
FROM golang:1.27.1-alpine3.24 AS build

ARG SENTINEL_NETWORK=devnet
ARG SENTINEL_PROGRAM_ID=
ARG SENTINEL_MINT=
ARG GIT_COMMIT=unknown
ARG GIT_TAG=unknown

WORKDIR /root

RUN apk add --no-cache \
    autoconf \
    automake \
    bash \
    ca-certificates \
    curl \
    file \
    g++ \
    gcc \
    git \
    libtool \
    linux-headers \
    make \
    musl-dev \
    unbound-dev \
    unzip

ARG HNSD_VERSION=v2.0.0
RUN git clone --branch="${HNSD_VERSION}" --depth=1 https://github.com/handshake-org/hnsd.git && \
    cd ./hnsd && \
    ./autogen.sh && \
    ./configure && \
    make --jobs=$(nproc)

ARG TARGETARCH
ARG XRAY_VERSION=v26.3.27
ARG XRAY_SHA256_amd64=23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae
ARG XRAY_SHA256_arm64=4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) asset="Xray-linux-64.zip";        sha="${XRAY_SHA256_amd64}" ;; \
        arm64) asset="Xray-linux-arm64-v8a.zip"; sha="${XRAY_SHA256_arm64}" ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 --retry-delay 2 -o /tmp/xray.zip \
        "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${asset}"; \
    echo "${sha}  /tmp/xray.zip" | sha256sum -c -; \
    unzip -j /tmp/xray.zip xray -d /usr/local/bin; \
    chmod +x /usr/local/bin/xray; \
    rm /tmp/xray.zip

ARG HYSTERIA_VERSION=v2.9.2
ARG HYSTERIA_SHA256_amd64=86fef8e2f1b2bf41318ac96724eee6c3b449e4e510022cc89658b63a6713922a
ARG HYSTERIA_SHA256_arm64=9ec8f49f4ea554b1cac04e6f3690cea76ff835082e943e54196d7f323fcfba71
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) asset="hysteria-linux-amd64"; sha="${HYSTERIA_SHA256_amd64}" ;; \
        arm64) asset="hysteria-linux-arm64"; sha="${HYSTERIA_SHA256_arm64}" ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/hysteria2 \
        "https://github.com/apernet/hysteria/releases/download/app/${HYSTERIA_VERSION}/${asset}"; \
    echo "${sha}  /usr/local/bin/hysteria2" | sha256sum -c -; \
    chmod +x /usr/local/bin/hysteria2

ARG AMNEZIAWG_TOOLS_COMMIT=61e741780e8465a67a7d7fb6cffe14a8a15d624a
RUN git clone https://github.com/amnezia-vpn/amneziawg-tools.git /tmp/amneziawg-tools && \
    git -C /tmp/amneziawg-tools checkout --quiet "${AMNEZIAWG_TOOLS_COMMIT}" && \
    make -C /tmp/amneziawg-tools/src --jobs=$(nproc) && \
    make -C /tmp/amneziawg-tools/src install \
        DESTDIR=/tmp/amneziawg-out PREFIX=/usr \
        WITH_WGQUICK=yes WITH_BASHCOMPLETION=no WITH_SYSTEMDUNITS=no && \
    install -m 0755 /tmp/amneziawg-out/usr/bin/awg /usr/local/bin/awg && \
    install -m 0755 /tmp/amneziawg-out/usr/bin/awg-quick /usr/local/bin/awg-quick && \
    rm -rf /tmp/amneziawg-tools /tmp/amneziawg-out

ARG AMNEZIAWG_GO_COMMIT=1cc94272ca8e9e223a5fe76382f5880f09d3c12d
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    git clone https://github.com/amnezia-vpn/amneziawg-go.git /tmp/amneziawg-go && \
    git -C /tmp/amneziawg-go checkout --quiet "${AMNEZIAWG_GO_COMMIT}" && \
    cd /tmp/amneziawg-go && \
    go build -o /usr/local/bin/amneziawg-go . && \
    rm -rf /tmp/amneziawg-go

ARG WIREGUARD_GO_VERSION=0.0.20250522
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    git clone --branch="${WIREGUARD_GO_VERSION}" --depth=1 https://github.com/WireGuard/wireguard-go.git /tmp/wireguard-go && \
    cd /tmp/wireguard-go && \
    go build -o /usr/local/bin/wireguard-go . && \
    rm -rf /tmp/wireguard-go

WORKDIR /src
COPY sentinel-go-sdk /src/sentinel-go-sdk
COPY sentinel-programs/clients/go /src/sentinel-programs/clients/go
COPY sentinel-dvpnd /src/sentinel-dvpnd
COPY sentinel-dvpnctl /src/sentinel-dvpnctl

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eux; \
    for mod in sentinel-dvpnd sentinel-dvpnctl; do \
        cd /src/$mod && go mod download && \
        make install GIT_COMMIT=${GIT_COMMIT} GIT_TAG=${GIT_TAG} \
            SENTINEL_NETWORK=${SENTINEL_NETWORK} \
            SENTINEL_PROGRAM_ID=${SENTINEL_PROGRAM_ID} \
            SENTINEL_MINT=${SENTINEL_MINT} || exit 1; \
    done

# Licence notices shipped in the image (/usr/share/licenses/node-image). The Sentinel licence text comes
# from the source tree itself when it has one; every other component is listed with its licence and source.
RUN <<'EOF'
set -eu
d=/licenses
mkdir -p "$d/sentinel"
for f in LICENSE CREDITS.md; do
  if [ -f "/src/sentinel-dvpnd/$f" ]; then cp "/src/sentinel-dvpnd/$f" "$d/sentinel/$f"; fi
done
cat > "$d/NOTICES" <<NOTICES
Node image built by the node manager app (Solana devnet). Built on Sentinel. https://sentinel.co

The Sentinel node daemon and CLI in /usr/local/bin (built from the Sentinel source tree given as
the build context, commit ${GIT_COMMIT}) are licensed under the Sentinel dVPN License, (c) Capybara
Publishing LTD. Full text: sentinel/LICENSE next to this file when the tree ships one, else LICENSE
in that source tree. Public tree: https://github.com/sentinel-official/sentinel-solana
Every Go module compiled into them, with its full licence text: THIRD-PARTY-NOTICES-daemon.txt
next to this file.

Third-party programs in this image, each under its own licence:
- Xray-core ${XRAY_VERSION}: MPL-2.0. Source: https://github.com/XTLS/Xray-core/tree/${XRAY_VERSION}
- Hysteria ${HYSTERIA_VERSION}: MIT. Source: https://github.com/apernet/hysteria/tree/app/${HYSTERIA_VERSION}
- hnsd ${HNSD_VERSION}: MIT. Source: https://github.com/handshake-org/hnsd/tree/${HNSD_VERSION}
- amneziawg-tools (awg, awg-quick; awg-quick patched for AWG_FORCE_USERSPACE): GPL-2.0.
  Source, built in this image from: https://github.com/amnezia-vpn/amneziawg-tools/tree/${AMNEZIAWG_TOOLS_COMMIT}
- amneziawg-go: MIT. Source: https://github.com/amnezia-vpn/amneziawg-go/tree/${AMNEZIAWG_GO_COMMIT}
- wireguard-go ${WIREGUARD_GO_VERSION}: MIT. Source: https://git.zx2c4.com/wireguard-go
- Alpine packages (openvpn, v2ray, wireguard-tools, nftables, ...): their own licences, see apk info.
NOTICES
EOF

# Every Go module compiled into the daemon and CLI, with its full licence text, read from the binaries just
# built (go version -m), so the list always matches the build. Adapted from #29's dvpnd_notices.sh.
RUN --mount=type=cache,target=/go/pkg/mod <<'EOF'
#!/bin/bash
set -euo pipefail
out=/licenses/THIRD-PARTY-NOTICES-daemon.txt
mkdir -p /licenses
mods=$(for b in /go/bin/*; do go version -m "$b" 2>/dev/null | awk '$1=="dep"{print $2, $3}'; done | sort -u)
n=$(printf '%s\n' "$mods" | grep -c .)
{
  echo "Third-party Go modules compiled into the Sentinel daemon and CLI in /usr/local/bin"
  echo "Generated from the binaries' embedded module lists (go version -m): $n modules."
  echo "The daemon and CLI themselves are under the Sentinel dVPN License (see NOTICES)."
  echo
} > "$out"
missing=0
while read -r mod ver; do
  case "$mod" in github.com/sentinel-official/*) continue ;; esac
  esc=$(printf '%s' "$mod" | awk '{s=""; for (i = 1; i <= length($0); i++) { c = substr($0, i, 1); s = s (c ~ /[A-Z]/ ? "!" tolower(c) : c) } print s}')
  dir="/go/pkg/mod/$esc@$ver"
  [ -d "$dir" ] || go mod download "$mod@$ver" > /dev/null
  file=$(ls "$dir" | grep -i -E '^(licen[cs]e|copying)(\.(md|txt))?$' | head -1 || true)
  {
    echo "================================================================================"
    echo "$mod $ver"
    case "$mod" in github.com/ncruces/go-sqlite3-wasm/*) echo "License: MIT-0 (contains SQLite, public domain: https://sqlite.org/copyright.html)" ;; esac
    echo "Source: https://pkg.go.dev/$mod@$ver"
    echo "--------------------------------------------------------------------------------"
    if [ -n "$file" ]; then cat "$dir/$file"; else echo "(the module ships no licence file)"; fi
    for f in $(ls "$dir" | grep -i -E '^notice(\.(md|txt))?$' || true); do echo "--- $f ---"; cat "$dir/$f"; done
    echo
  } >> "$out"
  [ -n "$file" ] || { missing=$((missing + 1)); echo "no licence file: $mod $ver"; }
done <<< "$mods"
echo "Go notices: $n modules, $missing without a licence file, $(wc -l < "$out") lines"
EOF

FROM alpine:3.24

RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    iproute2 \
    nftables \
    openvpn \
    unbound-libs \
    v2ray \
    wireguard-tools && \
    rm -rf /etc/v2ray/ /usr/share/v2ray/

COPY --from=build /go/bin/dvpnd /usr/local/bin/dvpnd
COPY --from=build /go/bin/dvpnctl /usr/local/bin/dvpnctl
COPY --from=build /root/hnsd/hnsd /usr/local/bin/hnsd
COPY --from=build /usr/local/bin/xray /usr/local/bin/xray
COPY --from=build /usr/local/bin/hysteria2 /usr/local/bin/hysteria2
COPY --from=build /usr/local/bin/awg /usr/local/bin/awg
COPY --from=build /usr/local/bin/awg-quick /usr/local/bin/awg-quick
COPY --from=build /usr/local/bin/amneziawg-go /usr/local/bin/amneziawg-go
COPY --from=build /usr/local/bin/wireguard-go /usr/local/bin/wireguard-go
COPY --from=build /licenses /usr/share/licenses/node-image

# AWG_FORCE_USERSPACE=1 makes awg-quick use amneziawg-go even when the host has an
# amneziawg kernel module. A host module older than these AmneziaWG 2.0 tools
# rejects H1-H4 with "Unable to modify interface: Invalid argument" (seen with
# module 1.0.0 on Ubuntu 6.8), and stock awg-quick never falls back when any
# module is loaded. The build fails unless both edits land.
RUN <<'EOF'
set -e
f=/usr/local/bin/awg-quick
sed -i 's#if ! cmd ip link add "$INTERFACE" type amneziawg; then#if [[ -n ${AWG_FORCE_USERSPACE:-} ]] || ! cmd ip link add "$INTERFACE" type amneziawg; then#' "$f"
sed -i 's#\[\[ -e /sys/module/amneziawg \]\] ||#[[ -z ${AWG_FORCE_USERSPACE:-} \&\& -e /sys/module/amneziawg ]] ||#' "$f"
test "$(grep -c AWG_FORCE_USERSPACE "$f")" -eq 2
EOF

# The daemon only runs protocol tools that root alone can change (upstream PR #34, trusted-tool lookup):
# every tool and each folder above it must be owned by root and not group- or world-writable. Fail the
# build here rather than have a protocol refuse to start on a deployed node.
RUN <<'EOF'
set -eu
bad=0
for t in hysteria2 v2ray xray wg awg awg-quick amneziawg-go wireguard-go openvpn hnsd dvpnd; do
  p=$(command -v "$t") || { echo "missing protocol tool: $t"; bad=1; continue; }
  p=$(readlink -f "$p")
  while :; do
    set -- $(stat -c '%u %g %a' "$p")
    if [ "$1" != 0 ] || [ "$2" != 0 ] || [ $(( 0$3 & 022 )) -ne 0 ]; then echo "untrusted: $p uid=$1 gid=$2 mode=$3 (tool $t)"; bad=1; fi
    [ "$p" = / ] && break
    p=$(dirname "$p")
  done
done
[ "$bad" -eq 0 ]
EOF

ENV DVPND_NETWORK_DNS=resolvconf

VOLUME ["/root/.dvpnd"]

ENTRYPOINT ["dvpnd"]
