#!/bin/sh
# ─── hnsd supervisor (node image 0.3.2+, T5; quiet log 0.3.3, NM-C9-1; checkpoint 0.3.4, NM-C9-2; log can never stall hnsd 0.3.5; tip status + memory trim 0.3.6) ───
# Installed as /usr/local/sbin/hnsd, ahead of the real /usr/local/bin/hnsd on PATH, so the daemon
# starts this instead.
#
# 1. Restart, not node exit (T5). Upstream runs hnsd in the same errgroup as the node service
#    (sentinel-dvpnd internal/node/runtime.go Serve, hnsd.go runHNSD): ANY hnsd exit returns an
#    error, the group is cancelled and sentinel-dvpnd exits, so a crash of the optional DNS resolver
#    took the whole VPN node down. Here an hnsd exit is restarted in place with backoff.
# 2. Quiet log (NM-C9-1). hnsd prints every header it adds (~500k lines in its first 90 s, ~10k/min
#    after) and the daemon copies all of it into the container log: the 3 × 20 MB rotation then
#    held about an hour and the node page's log pane showed only hnsd. Per-block, per-peer and
#    checkpoint lines are counted instead of printed; a one-line summary (height, lines dropped)
#    goes out at most once a minute. Every other line (errors, listen addresses) passes through.
# 3. Checkpoint that persists (NM-C9-2, image 0.3.4). hnsd writes its temp checkpoint "~<height>"
#    (35 KB, one per 2000 headers) RELATIVE TO ITS WORKING DIRECTORY and then renames it to
#    <-x dir>/checkpoint_main.dat. The daemon runs it from / (container overlay) with -x
#    /root/.dvpnd/hnsd, which is on the image VOLUME /root/.dvpnd (another filesystem): the rename
#    fails (EXDEV), so every start re-synced from height 0 (~3 min) and the temp files piled up in /.
#    Proven: -x on the overlay writes the checkpoint; -x on the volume never does. hnsd now starts
#    with its working directory = the -x directory, and old strays in / are removed.
# 4. Memory after a first sync (image 0.3.6, load study 2026-11-12). hnsd keeps every header it
#    synced in memory: 163 MB after a sync from height 0, flat for good. Started from its checkpoint
#    it holds ~9 MB, with the same CPU (~0%) and traffic (~1 MB/h). So a run that began WITHOUT a
#    checkpoint is restarted once, 60 s after it reaches the tip and a checkpoint exists: ~150 MB
#    back for the life of the node, for ~10 s without HNS answers once.
#
# Stopping: the daemon sends SIGTERM and SIGKILLs 5 s later (sentinel-go-sdk service/exec.go
# stopGrace, service_unix.go terminate): hnsd gets SIGTERM, then SIGKILL after 4 s. A daemon exit
# ends the container and everything in it.
REAL=/usr/local/bin/hnsd
FIFO=/run/nm-hnsd.$$.fifo
child=''
trimmed=''
filt=''

stop() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
    i=0
    while kill -0 "$child" 2>/dev/null && [ "$i" -lt 8 ]; do
      sleep 0.5
      i=$((i + 1))
    done
    kill -KILL "$child" 2>/dev/null
  fi
  [ -n "$filt" ] && kill "$filt" 2>/dev/null
  rm -f "$FIFO"
  exit 0
}
trap stop TERM INT HUP

# NM-C9-2: find the -x directory (arguments stay as given).
data=''
want=''
for a do
  [ "$want" = 1 ] && data=$a
  want=''
  [ "$a" = -x ] && want=1
done
# rm_strays <dir>: delete hnsd temp checkpoints ("~" + digits only) left in <dir>.
rm_strays() {
  for f in "$1"/~[0-9]*; do
    case ${f##*/} in "~"*[!0-9]*) ;; *) [ -f "$f" ] && rm -f "$f" ;; esac
  done
}
rm_strays "$PWD" # images before 0.3.4 left them in the daemon's working directory
if [ -n "$data" ] && [ -d "$data" ] && cd "$data"; then
  rm_strays "$data" # an interrupted write
else
  echo "nm-hnsd-supervisor: could not enter the hnsd directory '$data'; hnsd may not keep its checkpoint" >&2
fi

# The filter (awk) runs per hnsd run and reads a FIFO nobody else holds open. If it ever dies,
# hnsd's writes fail at once (EPIPE/SIGPIPE) instead of blocking on a full pipe, so hnsd can never
# hang on its own log; the watchdog below then restarts the pair (cheap with a kept checkpoint).
filter() {
  awk -v st=/run/nm-hnsd.status '
    # Runs on EVERY line. Writes "<height> <time of that header>" for the app when a newer header is
    # pending (at most every 2 s): proves the real hnsd is syncing, not only that a process named hnsd
    # exists (this supervisor has that name too). Pending = written on the next line of any kind, so
    # the last header of a sync burst is not lost until the next block (~10 min; seen in the load
    # study: status stuck at 344001 while hnsd sat at the tip 355486).
    function tick(now) {
      now = systime()
      if (pending && now - lastw >= 2) { printf "%s %d\n", height, hdrt > st; close(st); lastw = now; pending = 0 }
      if (now - last < 60) return
      if (dropped > 0) printf "hnsd: height %s, %d chain/peer lines not logged in the last minute(s)\n", (height == "" ? "?" : height), dropped
      dropped = 0; last = now; fflush()
    }
    /^chain \([0-9]+\):/ {
      if ($0 ~ /new height:/) { height = $NF; hdrt = systime(); pending = 1 }
      dropped++; tick(); next
    }
    /^store: \([0-9]+\) failed to write checkpoint/ { if (cpfail++ == 0) { print; fflush() } else dropped++; tick(); next }
    /^addrman: added addr/ || /^store: \([0-9]+\) wrote/ || /^pool: size:/ { dropped++; tick(); next }
    /^peer [0-9]+ \(/ && /(sending|requesting|received [0-9]+ (headers|addrs)|closing peer|closed peer|failed connecting|failed adding block: EDUPLICATE|peer sent orphan|failed adding orphan)/ { dropped++; tick(); next }
    { print; fflush(); tick() }
  ' < "$FIFO"
}
# "0 <now>" until the first header: lets the app tell "starting" from "never reached a peer".
echo "0 $(date +%s)" > /run/nm-hnsd.status 2>/dev/null || echo "nm-hnsd-supervisor: cannot write /run/nm-hnsd.status; the app cannot show HNS sync" >&2
rm -f "$FIFO"
if mkfifo -m 600 "$FIFO"; then
  OUT=fifo
else
  echo "nm-hnsd-supervisor: no log filter (mkfifo failed); hnsd output goes to the daemon log unfiltered" >&2
  OUT=plain
fi

# at_tip: the status file's height is within 0.5% of the expected Handshake height (as the app's
# "synced": genesis 1580745078, 600 s blocks).
at_tip() {
  h=$(cut -d' ' -f1 /run/nm-hnsd.status 2>/dev/null)
  case $h in '' | *[!0-9]*) return 1 ;; esac
  exp=$((($(date +%s) - 1580745078) / 600))
  [ $((h * 1000)) -ge $((exp * 995)) ]
}
CKPT=${data:+$data/checkpoint_main.dat}

delay=5
n=0
while :; do
  started=$(date +%s)
  # 4. Trim only a run that started from height 0 (no checkpoint to inject) and only once.
  trim=''
  [ -n "$CKPT" ] && [ ! -s "$CKPT" ] && [ -z "$trimmed" ] && trim=pending
  tip_since=''
  if [ "$OUT" = fifo ]; then
    filter &
    filt=$!
    "$REAL" "$@" > "$FIFO" 2>&1 &
  else
    "$REAL" "$@" &
  fi
  child=$!
  # Watchdog: hnsd running but its filter gone -> restart both (hnsd would only lose its log, but
  # a restart brings the log back and costs seconds now that the checkpoint is kept).
  while kill -0 "$child" 2>/dev/null; do
    if [ -n "$filt" ] && ! kill -0 "$filt" 2>/dev/null; then
      echo "nm-hnsd-supervisor: log filter stopped; restarting hnsd with a new one" >&2
      kill -TERM "$child" 2>/dev/null
    fi
    if [ "$trim" = pending ] && at_tip && [ -s "$CKPT" ]; then
      now=$(date +%s)
      [ -z "$tip_since" ] && tip_since=$now
      if [ $((now - tip_since)) -ge 60 ]; then
        echo "nm-hnsd-supervisor: first sync done; restarting hnsd once from its checkpoint to free the synced headers' memory (~150 MB)" >&2
        trim=done
        trimmed=1
        kill -TERM "$child" 2>/dev/null
      fi
    fi
    sleep 5 &
    wait $!
  done
  wait "$child"
  rc=$?
  child=''
  [ -n "$filt" ] && { kill "$filt" 2>/dev/null; wait "$filt" 2>/dev/null; filt=''; }
  if [ "$trim" = done ]; then
    # Planned: not a crash, no backoff, not counted.
    sleep 1 &
    wait $!
    continue
  fi
  n=$((n + 1))
  # A run longer than 10 minutes was healthy: start the backoff again from 5 s.
  [ $(($(date +%s) - started)) -gt 600 ] && delay=5
  echo "nm-hnsd-supervisor: hnsd exited (code $rc, restart $n), restarting in ${delay} s; the node keeps serving" >&2
  sleep "$delay" &
  wait $!
  delay=$((delay * 2))
  [ "$delay" -gt 300 ] && delay=300
done
