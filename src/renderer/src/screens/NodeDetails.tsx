import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PageHeader } from '../components/PageHeader';
import { BarChart } from '../components/BarChart';
import { QRCode } from '../components/QRCode';
import { MIcon } from '../components/MIcon';
import { CountryFlag } from '../components/CountryFlag';
import { useApp } from '../store/app';
import { SolanaNodePanel } from '../components/SolanaNodePanel';
import { HnsChip, HnsResolverControl } from '../components/HnsResolverControl';
import { fmtDVPN, fmtDVPNSend, fmtBytes, shortAddr } from '../lib/format';
import type {
  DeployedNode,
  MetricsSample,
  NodeLiveStatus,
  NodeLogExportFormat,
} from '../../../shared/types';

interface Props {
  id: string;
}

export function NodeDetails({ id }: Props) {
  const { nodes, wallet, navigate, refreshStatus, liveStatuses, refreshNodes, pushToast, confirm, settings } = useApp();
  const node = useMemo(() => nodes.find((n) => n.id === id) ?? null, [nodes, id]);
  const status = liveStatuses[id] ?? null;
  const [history, setHistory] = useState<MetricsSample[]>([]);
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('24h');
  const [busy, setBusy] = useState<'' | 'start' | 'restart' | 'stop' | 'remove' | 'withdraw' | 'pricing'>('');
  const [editingPricing, setEditingPricing] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [revealedMnemonic, setRevealedMnemonic] = useState<string | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealLoading, setRevealLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    const tick = () => {
      void refreshStatus(id).catch(() => {});
    };
    tick();
    // The main poller pushes live status on its own cadence; this is only a safety net.
    const iv = setInterval(() => {
      if (mounted) tick();
    }, 60_000);
    return () => {
      mounted = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    let mounted = true;
    void window.api.nodes
      .history(id, range)
      .then((h) => {
        if (mounted) setHistory(h);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [id, range]);

  const chartSamples = useMemo(
    () => history.map((s) => ({ ts: s.ts, peers: s.peers })),
    [history],
  );
  const chartWindowMs = useMemo(
    () =>
      range === '1h'
        ? 60 * 60 * 1000
        : range === '24h'
          ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000,
    [range],
  );
  // Earliest meaningful x-axis value.
  // - On the daily ("24h") range the user reads the chart as "today's peers",
  //   so we start at today's midnight and let the axis run forward toward
  //   `now`. If the node started later than midnight we floor to that.
  // - On other ranges we fall back to the earliest meaningful timestamp
  //   (startedAt / createdAt / first sample) so a young node doesn't render
  //   against a mostly-empty axis.
  const chartMinStartMs = useMemo(() => {
    if (range === '24h') {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const startCandidates = [midnight.getTime()];
      if (node?.startedAt) {
        const t = Date.parse(node.startedAt);
        if (Number.isFinite(t)) startCandidates.push(t);
      }
      // Latest of {midnight, startedAt} so a node started this afternoon
      // doesn't show empty axis from midnight onward.
      return Math.max(...startCandidates);
    }
    const candidates: number[] = [];
    if (node?.startedAt) candidates.push(Date.parse(node.startedAt));
    if (node?.createdAt) candidates.push(Date.parse(node.createdAt));
    if (history.length > 0) candidates.push(history[0].ts);
    const valid = candidates.filter((n) => Number.isFinite(n));
    if (valid.length === 0) return undefined;
    return Math.min(...valid);
  }, [range, node?.startedAt, node?.createdAt, history]);

  const parsedLogs = useMemo(
    () => (status?.logTail ?? []).slice(-300).map((l) => parseLogLine(l)),
    [status?.logTail],
  );
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const logAutoScrollRef = useRef(true);
  useEffect(() => {
    const el = logScrollRef.current;
    if (!el || !logAutoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [parsedLogs]);

  // Anchor uptime to wall-clock so it ticks every second locally instead of
  // jumping at poll boundaries. Hooks must run on every render path — keep
  // them above the `!node` early return.
  //
  // The anchor is `Date.now() - status.uptimeMs` from the *first* sample
  // we see. We deliberately do NOT re-anchor on every status push: doing
  // that causes a visible 1–2s stutter every poll when server-reported
  // uptime drifts from local wall-clock by network/poll jitter. We only
  // resync when divergence exceeds 5s (e.g. container restart, clock
  // skew, or coming back from sleep).
  const uptimeAnchorRef = useRef<number | null>(null);
  const hasUptime = !!(status?.uptimeMs && status.uptimeMs > 0);
  useEffect(() => {
    const ms = status?.uptimeMs ?? 0;
    if (ms <= 0) {
      uptimeAnchorRef.current = null;
      return;
    }
    const incomingAnchor = Date.now() - ms;
    const current = uptimeAnchorRef.current;
    if (current == null) {
      uptimeAnchorRef.current = incomingAnchor;
      return;
    }
    // Resync only on meaningful drift to avoid the visible stutter.
    if (Math.abs(current - incomingAnchor) > 5_000) {
      uptimeAnchorRef.current = incomingAnchor;
    }
  }, [status?.uptimeMs]);
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!hasUptime) return;
    const iv = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [hasUptime]);

  if (!node) {
    return (
      <div className="empty-state card">
        <MIcon name="dns" size={40} style={{ color: 'var(--text-muted)' }} />
        <div className="empty-state-title">Node not found</div>
        <div className="empty-state-body">It may have been removed.</div>
        <button className="btn btn-secondary mt-2" onClick={() => navigate({ name: 'nodes' })}>
          Back to nodes
        </button>
      </div>
    );
  }

  // Local-node lifecycle requires Docker; if the daemon is down the
  // dockerode call surfaces a cryptic ECONNREFUSED. Probe first and route
  // the user to Manage Docker so they get a recovery path instead.
  const ensureDockerForLocal = async (action: 'start' | 'restart' | 'stop'): Promise<boolean> => {
    if (node?.target !== 'local') return true;
    const report = await window.api.system.report().catch(() => null);
    if (report?.dockerReachable) return true;
    pushToast({
      title: 'Docker is not running',
      body:
        report?.dockerError?.slice(0, 140) ??
        `Start Docker Desktop before you ${action} a local node. Open Manage Docker to launch it.`,
      tone: 'error',
    });
    navigate({ name: 'manage-docker' });
    return false;
  };

  const onStart = async () => {
    if (!(await ensureDockerForLocal('start'))) return;
    setBusy('start');
    try {
      await window.api.nodes.start(id);
      await refreshNodes();
      pushToast({ title: `Starting ${node.moniker}`, tone: 'info' });
    } catch (e) {
      pushToast({ title: 'Start failed', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy('');
    }
  };
  const onRestart = async () => {
    if (!(await ensureDockerForLocal('restart'))) return;
    setBusy('restart');
    try {
      await window.api.nodes.restart(id);
      await refreshNodes();
      pushToast({ title: `Restarted ${node.moniker}`, tone: 'success' });
    } catch (e) {
      pushToast({ title: 'Restart failed', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy('');
    }
  };
  const onStop = async () => {
    const ok = await confirm({
      title: `Stop ${node.moniker}?`,
      body: 'The node will stop serving traffic and not earn rewards until you start it again.',
      tone: 'warning',
      confirmLabel: 'Stop node',
    });
    if (!ok) return;
    if (!(await ensureDockerForLocal('stop'))) return;
    setBusy('stop');
    try {
      await window.api.nodes.stop(id);
      await refreshNodes();
      pushToast({ title: `Stopped ${node.moniker}`, tone: 'info' });
    } finally {
      setBusy('');
    }
  };
  const onRemove = async () => {
    const ok = await confirm({
      title: `Remove ${node.moniker}?`,
      body: 'The app redeems outstanding vouchers, stops the node, delists and closes it on chain. Remaining revenue is paid to the node key; the 1 tDVPN bond unlocks after 1 hour, then the app withdraws it and sweeps everything back to your wallet. You can follow each step on this page.',
      tone: 'danger',
      confirmLabel: 'Remove node',
    });
    if (!ok) return;
    setBusy('remove');
    try {
      await window.api.nodes.remove(id);
      pushToast({ title: `Removing ${node.moniker}`, body: 'Bond unlocks in 1 hour; the app finishes the rest.', tone: 'info' });
    } finally {
      setBusy('');
    }
  };

  const openWithdraw = () => {
    if (!wallet?.address) {
      pushToast({
        title: 'No app wallet yet',
        body: 'Set up the app wallet first so we know where to send the tDVPN.',
        tone: 'error',
      });
      return;
    }
    if (!(withdrawableDVPN > 0)) {
      pushToast({
        title: 'Nothing to withdraw',
        body: 'This node has no revenue on chain yet.',
        tone: 'warn',
      });
      return;
    }
    setWithdrawOpen(true);
  };

  const doExportLogs = async (format: NodeLogExportFormat) => {
    setExportMenuOpen(false);
    const lines = status?.logTail ?? [];
    if (lines.length === 0) {
      pushToast({ title: 'Nothing to export', body: 'No log lines captured yet.', tone: 'warn' });
      return;
    }
    setExporting(true);
    try {
      const res = await window.api.nodes.exportLogs({ nodeId: id, format, lines });
      if (res.ok) {
        pushToast({
          title: 'Logs exported',
          body: res.path,
          tone: 'success',
        });
      } else if (res.cancelled) {
        // user dismissed the save dialog — stay quiet
      } else {
        pushToast({ title: 'Export failed', body: res.error, tone: 'error' });
      }
    } finally {
      setExporting(false);
    }
  };

  const doWithdraw = async (amount: number, to: string) => {
    setBusy('withdraw');
    try {
      const res = await window.api.nodes.withdraw({ nodeId: id, to, amountDVPN: amount });
      if (res.ok) {
        pushToast({
          title: 'Withdrawal broadcast',
          body: `tx ${res.txHash?.slice(0, 16)}…`,
          tone: 'success',
        });
        await refreshNodes();
        setWithdrawOpen(false);
      } else {
        pushToast({ title: 'Withdrawal failed', body: res.error, tone: 'error' });
      }
    } finally {
      setBusy('');
    }
  };

  // Revenue is held on chain until withdrawn; the node key itself usually holds 0 tDVPN.
  const withdrawableDVPN = node.balanceDVPN + (status?.revenueDVPN ?? 0);
  const uptime = uptimeAnchorRef.current == null
    ? formatDuration(0)
    : formatDuration(Date.now() - uptimeAnchorRef.current);
  const statusTone =
    node.status === 'online'
      ? 'chip-success'
      : node.status === 'loading' || (!node.removalStage && status?.sshDisconnected)
        ? 'chip-warn'
        : 'chip-danger';
  // T9 (e): after an app restart a server node shows "Not connected" until Reconnect, not "Error".
  const notConnected = !node.removalStage && !!status?.sshDisconnected && node.status !== 'online';
  const statusLabel =
    node.removalStage ? 'Removing' : notConnected ? 'Not connected' : node.status === 'online' ? 'Online' : node.status === 'loading' ? 'Starting' : node.status === 'error' ? 'Error' : 'Offline';

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      {node.lastError && (
        // Fix F: background failures are shown, not only logged.
        <div className="card" role="alert" style={{ borderColor: 'var(--red)' }}>
          <div className="card-body flex items-start gap-2 text-xs" style={{ color: 'var(--red)' }}>
            <MIcon name="error" size={14} />
            <span>
              {node.lastError.what} failed at {new Date(node.lastError.at).toLocaleTimeString()}: {node.lastError.message} The app keeps trying and
              clears this when it works again.
            </span>
          </div>
        </div>
      )}
      <PageHeader
        title={node.moniker}
        subtitle={`${node.target === 'remote' ? 'Remote via SSH' : 'Local via Docker'} · ${node.serviceType} · ${node.host ?? '127.0.0.1'}:${node.port}`}
        right={
          <>
            <button
              className="btn btn-ghost"
              onClick={() => navigate({ name: 'nodes' })}
              title="Back to Nodes"
            >
              <MIcon name="arrow_back" size={14} />
              Back
            </button>
            <span
              className={`chip ${statusTone}`}
              title={
                node.status === 'loading'
                  ? "Node process is up but the API endpoint isn't yet answering. Usually resolves in 60–120 s after start."
                  : undefined
              }
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    node.status === 'online'
                      ? 'var(--green)'
                      : node.status === 'loading'
                        ? 'var(--yellow)'
                        : 'var(--red)',
                }}
              />
              {statusLabel}
            </span>
            <button className="btn btn-secondary" onClick={() => void refreshStatus(id)}>
              <MIcon name="refresh" size={14} />
              Refresh
            </button>
            {(() => {
              const specsReady = Boolean(node.specsTxHash);
              const specsPending = !specsReady && node.specsPublishPending === true;
              return (
                <button
                  className="btn btn-secondary justify-center"
                  disabled={!specsReady}
                  aria-disabled={!specsReady}
                  onClick={() => {
                    if (!specsReady) return;
                    navigate({
                      name: 'activity',
                      kinds: ['specs-reported'],
                      nodeId: id,
                    });
                  }}
                  style={
                    !specsReady
                      ? { opacity: 0.65, cursor: 'not-allowed', minWidth: 240 }
                      : { minWidth: 240 }
                  }
                  title={
                    specsReady
                      ? 'Open Activity feed pre-filtered to on-chain hardware-specs reports for this node'
                      : specsPending
                        ? 'Broadcasting specs:v1 memo on-chain — this button unlocks once the tx lands.'
                        : 'No specs broadcast for this node yet — wait for the deploy to publish, then this unlocks.'
                  }
                >
                  {specsPending ? (
                    <span
                      aria-hidden
                      className="ring-spin"
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        border: '2px solid var(--border)',
                        borderTopColor: 'var(--accent)',
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <MIcon name={specsReady ? 'memory' : 'lock'} size={14} />
                  )}
                  {specsPending
                    ? 'Posting on-chain…'
                    : 'View On-Chain Specs Reporting'}
                </button>
              );
            })()}
            <button
              className="btn btn-secondary"
              onClick={() => {
                setRevealedMnemonic(null);
                setRevealOpen(true);
              }}
              title="Decrypt and show this node's 24-word operator recovery phrase"
            >
              <MIcon name="key" size={14} />
              Recovery phrase
            </button>
            {/* NM-C9 (b): during a removal these do nothing; a disabled blue Start still read as
                enabled next to the "Removing" pill, so they are hidden and the removal card leads. */}
            {!node.removalStage && (
              <>
                {node.status === 'offline' ? (
                  <button className="btn btn-primary" onClick={onStart} disabled={!!busy || !!node.removalStage}>
                    <MIcon name="play_arrow" size={14} />
                    {busy === 'start' ? 'Starting…' : 'Start'}
                  </button>
                ) : (
                  <button className="btn btn-secondary" onClick={onRestart} disabled={!!busy || !!node.removalStage}>
                    <MIcon name="restart_alt" size={14} />
                    {busy === 'restart' ? 'Restarting…' : 'Restart'}
                  </button>
                )}
                <button
                  className="btn btn-secondary"
                  onClick={onStop}
                  disabled={!!busy || node.status === 'offline' || !!node.removalStage}
                >
                  <MIcon name="stop" size={14} />
                  {busy === 'stop' ? 'Stopping…' : 'Stop'}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={onRemove}
                  disabled={!!busy || !!node.removalStage}
                  title={node.removalStage ? 'Removal in progress — see the panel below' : 'Remove node: redeem, stop, delist, close on chain, return the bond and sweep the key to your wallet'}
                >
                  <MIcon name="warning" size={14} />
                  {busy === 'remove' ? 'Removing…' : 'Remove node'}
                </button>
              </>
            )}
          </>
        }
      />

      {/* Stat row */}
      <div className="grid grid-cols-12 gap-3">
        <div
          className="stat-card col-span-6 lg:col-span-3 flex flex-col items-center text-center"
          style={{
            background:
              'linear-gradient(180deg, color-mix(in srgb, var(--accent) 9%, var(--bg-card)) 0%, var(--bg-card) 70%)',
            borderColor: 'color-mix(in srgb, var(--accent) 26%, var(--border))',
          }}
        >
          <div className="flex items-center justify-center gap-1.5">
            <span
              className="inline-flex items-center justify-center rounded-full"
              style={{
                width: 18,
                height: 18,
                background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <MIcon name="account_balance_wallet" size={11} />
            </span>
            <div className="stat-label" style={{ marginBottom: 0 }}>
              Withdrawable
            </div>
          </div>
          <div
            className="stat-value flex items-baseline justify-center gap-1.5"
            style={{ color: 'var(--accent)' }}
            title={`${fmtDVPN(node.balanceDVPN, 6)} on the node key + ${fmtDVPN(status?.revenueDVPN ?? 0, 6)} revenue on chain`}
          >
            <span style={{ letterSpacing: '-0.01em' }}>{fmtDVPN(withdrawableDVPN)}</span>
            <span
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: 'var(--text-dim)' }}
            >
              tDVPN
            </span>
          </div>
          <button
            className="btn btn-primary btn-sm mt-1.5 flex-shrink-0"
            onClick={openWithdraw}
            disabled={!!busy || !!node.removalStage || withdrawableDVPN < 0.000001}
            style={{ position: 'relative', zIndex: 1 }}
            title={
              withdrawableDVPN < 0.000001
                ? 'Nothing to withdraw yet — revenue appears here after clients pay and the node redeems'
                : `Withdraw ${fmtDVPN(withdrawableDVPN, 6)} tDVPN (on-chain revenue + node key balance) to your wallet`
            }
          >
            <MIcon name="north_east" size={12} />
            Withdraw
          </button>
        </div>
        <div className="stat-card col-span-6 lg:col-span-3 flex flex-col items-center text-center">
          <div className="stat-label">Chain status</div>
          <div
            className="stat-value"
            style={{ color: status?.reachable ? 'var(--green)' : 'var(--text-dim)' }}
          >
            {status?.reachable ? formatChainStatus(status.chainStatus) : '—'}
          </div>
          <div className="stat-sub">
            {status?.reachable
              ? 'Listed and unexpired'
              : status?.configChange
                ? `${changeLabel(status.configChange)}… the node is restarting`
                : status?.sshDisconnected && status?.chainStatus !== 'delisted' && status?.chainStatus !== 'not-found'
                  ? 'Not connected — reconnect to see its status'
                  : status?.chainStatus === 'delisted'
                ? 'Delisted on chain'
                : status?.chainStatus === 'not-found'
                  ? 'Node account closed'
                  : node.registeredOnChain
                    ? 'Listing expired — re-list or start the node'
                    : 'Not opened on chain yet'}
          </div>
        </div>
        <div className="stat-card col-span-6 lg:col-span-3 flex flex-col items-center text-center">
          <div className="stat-label">Active sessions</div>
          <div className="stat-value">{status?.reachable ? status.sessions.toLocaleString() : '—'}</div>
          <div className="stat-sub">
            {status?.reachable
              ? fmtBytes(status.bytesIn + status.bytesOut) + ' served'
              : 'waiting'}
          </div>
        </div>
        <div className="stat-card col-span-6 lg:col-span-3 flex flex-col items-center text-center">
          <div className="stat-label">Uptime</div>
          <div className="stat-value">{uptime}</div>
          <div className="stat-sub">
            {node.status === 'online' ? 'container running' : node.status === 'loading' ? 'starting' : node.status === 'error' ? 'listed but not live' : 'stopped'}
          </div>
        </div>
      </div>

      {/* Identity / details disclosure */}
      <IdentityDisclosure
        node={node}
        status={status}
        onEditPricing={() => setEditingPricing(true)}
        onReveal={() => {
          setRevealedMnemonic(null);
          setRevealOpen(true);
        }}
        onCopy={async (label, value) => {
          await navigator.clipboard.writeText(value);
          pushToast({ title: `${label} copied`, tone: 'success' });
        }}
      />

      <SolanaNodePanel node={node} status={status} />

      <div className="grid grid-cols-12 gap-3 items-start">
        {/* Peer chart + subscriptions stack */}
        <div className="col-span-12 lg:col-span-7 flex flex-col gap-3">
          <div className="card flex flex-col overflow-hidden">
            <div className="card-header">
              <div className="card-title">Peer count history</div>
              <div className="flex gap-1">
                {(['1h', '24h', '7d'] as const).map((w) => (
                  <button
                    key={w}
                    className={`btn btn-sm ${w === range ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setRange(w)}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
            <div className="card-body">
              <BarChart
                samples={chartSamples}
                windowMs={chartWindowMs}
                minStartMs={chartMinStartMs}
                height={160}
                minScale={10}
                emptyLabel={
                  status?.error
                    ? 'Samples unavailable. Check connection.'
                    : `Waiting for the first sample (the node poller runs every ${settings?.nodeRefreshIntervalSec ?? 60} s)`
                }
              />
            </div>
          </div>

          <div className="card flex flex-col overflow-hidden">
            <div className="card-header">
              <div className="card-title flex items-center gap-2">
                <MIcon name="receipt_long" size={13} />
                Leases
              </div>
              {status && (
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  {(status.linkedPlans ?? []).length} linked
                </span>
              )}
            </div>
            <div className="card-body" style={{ maxHeight: 240, overflowY: 'auto' }}>
              {!status ? (
                <div className="loading-state">Querying on-chain…</div>
              ) : (status.linkedPlans ?? []).length === 0 ? (
                <div className="empty-state" style={{ padding: '20px 12px' }}>
                  <MIcon name="inbox" size={26} style={{ color: 'var(--text-muted)' }} />
                  <div className="empty-state-body text-xs">
                    No leases. A provider leases this node by pre-paying it per hour (open_lease); the daemon watches and redeems them automatically. Prices are per hour (lease) as set above.
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {(status.linkedPlans ?? []).slice(0, 50).map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 px-3 py-2"
                      style={{
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)',
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <div
                          className="mono-inline text-[12px] truncate"
                          style={{ color: 'var(--text)' }}
                          title={`Lease ${p.id}${p.provider ? ` · provider ${p.provider}` : ''}`}
                        >
                          {p.id.slice(0, 8)}…{p.id.slice(-6)}
                        </div>
                        <div
                          className="text-[10px]"
                          style={{ color: 'var(--text-dim)' }}
                        >
                          {fmtDVPN(p.price, 6)} tDVPN escrow left · {p.durationDays}d{p.status ? ` · ${p.status}` : ''}{p.provider ? ` · ${p.provider.slice(0, 6)}…` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card flex flex-col min-h-0 overflow-hidden flex-1">
            <div className="card-header">
              <div className="card-title flex items-center gap-2">
                <MIcon name="groups" size={13} />
                Active sessions
              </div>
              {status?.reachable && (
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  {status.activeSubscriptions.length} live
                </span>
              )}
            </div>
            <div className="card-body overflow-auto" style={{ maxHeight: '50vh' }}>
              {!status?.reachable ? (
                <div className="loading-state">Querying on-chain…</div>
              ) : status.activeSubscriptions.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px 12px' }}>
                  <MIcon name="inbox" size={26} style={{ color: 'var(--text-muted)' }} />
                  <div className="empty-state-body text-xs">
                    No active sessions. They appear here the moment a client connects and pays with vouchers.
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {status.activeSubscriptions.slice(0, 50).map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-3 px-3 py-2"
                      style={{
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)',
                      }}
                    >
                      <div
                        className="h-8 w-8 rounded-full flex-shrink-0"
                        style={{
                          background: 'linear-gradient(135deg, var(--accent), var(--green))',
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div
                          className="mono-inline text-[12px] truncate"
                          style={{ color: 'var(--text)' }}
                        >
                          {s.subscriberShort}
                        </div>
                        <div
                          className="text-[10px]"
                          style={{ color: 'var(--text-dim)' }}
                        >
                          {fmtBytes(s.bytesIn + s.bytesOut)} ·{' '}
                          {formatDuration(s.durationSeconds * 1000)}
                        </div>
                      </div>
                      {s.status && <span className="chip chip-muted">{s.status}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Logs */}
        <div className="col-span-12 lg:col-span-5 card flex flex-col min-h-0 overflow-hidden">
          <div className="card-header">
            <div className="card-title flex items-center gap-2">
              <MIcon name="terminal" size={13} />
              Container logs
              <span className="mono-tag">{parsedLogs.length}</span>
            </div>
            <div className="flex items-center gap-1">
              <div style={{ position: 'relative' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setExportMenuOpen((v) => !v)}
                  disabled={exporting || parsedLogs.length === 0}
                  title={
                    parsedLogs.length === 0
                      ? 'No log lines captured yet'
                      : 'Export container logs'
                  }
                >
                  <MIcon name="download" size={12} />
                  {exporting ? 'Exporting…' : 'Export'}
                  <MIcon name="arrow_drop_down" size={12} />
                </button>
                {exportMenuOpen && (
                  <>
                    <div
                      onClick={() => setExportMenuOpen(false)}
                      style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 30,
                      }}
                    />
                    <div
                      className="card-elev"
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 4px)',
                        right: 0,
                        zIndex: 31,
                        minWidth: 220,
                        padding: 4,
                      }}
                    >
                      <ExportMenuItem
                        icon="description"
                        title="Plain text (.txt)"
                        subtitle="ANSI-stripped, one line per row"
                        onClick={() => void doExportLogs('txt')}
                      />
                      <ExportMenuItem
                        icon="article"
                        title="Log file (.log)"
                        subtitle="Same as .txt, for log viewers"
                        onClick={() => void doExportLogs('log')}
                      />
                      <ExportMenuItem
                        icon="data_object"
                        title="Structured JSON (.json)"
                        subtitle="Parsed timestamp, level, message, fields"
                        onClick={() => void doExportLogs('json')}
                      />
                    </div>
                  </>
                )}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void refreshStatus(id)}
              >
                <MIcon name="refresh" size={12} />
                Re-fetch
              </button>
            </div>
          </div>
          <div
            ref={logScrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
              logAutoScrollRef.current = atBottom;
            }}
            className="overflow-auto"
            style={{
              background: 'var(--bg-terminal)',
              borderTop: '1px solid var(--border)',
              fontFamily:
                "'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'Liberation Mono', monospace",
              fontSize: 11,
              lineHeight: '16px',
              height: '50vh',
              minHeight: 280,
            }}
          >
            {parsedLogs.length > 0 ? (
              <div style={{ paddingTop: 6, paddingBottom: 12 }}>
                {parsedLogs.map((line, i) => (
                  <LogRow key={i} line={line} />
                ))}
              </div>
            ) : (
              <div className="text-[12px]" style={{ color: 'var(--text-dim)', padding: '10px 12px' }}>
                No log output captured yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {withdrawOpen && wallet?.address && (
        <WithdrawEditor
          nodeBalance={node.balanceDVPN + (status?.revenueDVPN ?? 0)}
          defaultTo={wallet.address}
          pending={busy === 'withdraw'}
          onCancel={() => setWithdrawOpen(false)}
          onSubmit={(amount, to) => doWithdraw(amount, to)}
        />
      )}

      {editingPricing && (
        <PricingEditor
          initialGiga={node.gigabytePriceDVPN}
          initialHour={node.hourlyPriceDVPN}
          initialLease={node.leaseHourlyPriceDVPN ?? node.hourlyPriceDVPN}
          onCancel={() => setEditingPricing(false)}
          onSubmit={async (giga, hour, lease) => {
            setBusy('pricing');
            try {
              const res = await window.api.nodes.updatePricing({
                nodeId: id,
                gigabytePriceDVPN: giga,
                hourlyPriceDVPN: hour,
                leaseHourlyPriceDVPN: lease,
              });
              if (res.ok) {
                pushToast({ title: 'Pricing updated', body: 'New prices are on chain.', tone: 'success' });
                await refreshNodes();
                await refreshStatus(id);
                setEditingPricing(false);
              } else {
                pushToast({ title: 'Pricing update failed', body: res.error, tone: 'error' });
              }
            } finally {
              setBusy('');
            }
          }}
        />
      )}

      {revealOpen && (
        <RevealMnemonicModal
          loading={revealLoading}
          mnemonic={revealedMnemonic}
          onClose={() => {
            setRevealOpen(false);
            setRevealedMnemonic(null);
          }}
          onReveal={async () => {
            setRevealLoading(true);
            try {
              const res = await window.api.nodes.revealMnemonic(id);
              if (res.ok) {
                setRevealedMnemonic(res.mnemonic);
              } else {
                pushToast({ title: 'Cannot reveal mnemonic', body: res.error, tone: 'error' });
                setRevealOpen(false);
              }
            } finally {
              setRevealLoading(false);
            }
          }}
          onCopy={async () => {
            if (!revealedMnemonic) return;
            await navigator.clipboard.writeText(revealedMnemonic);
            pushToast({ title: 'Mnemonic copied', tone: 'success' });
          }}
        />
      )}
    </div>
  );
}

function RevealMnemonicModal({
  loading,
  mnemonic,
  onClose,
  onReveal,
  onCopy,
}: {
  loading: boolean;
  mnemonic: string | null;
  onClose: () => void;
  onReveal: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        className="card-elev"
        style={{ width: 'min(560px, 92vw)', maxHeight: '88vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="card-title flex items-center gap-2">
            <MIcon name="key" size={14} />
            Reveal node mnemonic
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <MIcon name="close" size={14} />
          </button>
        </div>
        <div className="card-body flex flex-col gap-3">
          {!mnemonic ? (
            <>
              <div
                className="text-[12px] leading-relaxed"
                style={{ color: 'var(--text-muted)' }}
              >
                The 24-word mnemonic below controls this node's on-chain operator key —
                anyone with it can withdraw rewards and impersonate the node. Reveal it
                only on a screen you trust, and don't paste it anywhere outside a wallet
                you control.
              </div>
              <div className="flex justify-end gap-2 mt-1">
                <button className="btn btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button
                  className="btn btn-danger"
                  onClick={onReveal}
                  disabled={loading}
                >
                  <MIcon name="visibility" size={14} />
                  {loading ? 'Decrypting…' : 'Reveal'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                className="grid"
                style={{
                  gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                  gap: 4,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '10px 12px',
                }}
              >
                {mnemonic.trim().split(/\s+/).map((word, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 min-w-0"
                    style={{ padding: '3px 6px' }}
                  >
                    <span
                      className="tabular-nums flex-shrink-0"
                      style={{ color: 'var(--text-dim)', fontSize: 9, width: 14 }}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className="truncate"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text)',
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                      title={word}
                    >
                      {word}
                    </span>
                  </div>
                ))}
              </div>
              <div
                className="text-[11px]"
                style={{ color: 'var(--text-muted)' }}
              >
                Close this dialog when you're done. The mnemonic stays encrypted on disk.
              </div>
              <div className="flex justify-end gap-2 mt-1">
                <button className="btn btn-ghost" onClick={onCopy}>
                  <MIcon name="content_copy" size={14} />
                  Copy
                </button>
                <button className="btn btn-primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ExportMenuItem({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-start gap-2 px-2.5 py-2 rounded hover:bg-white/5 text-left"
      style={{ color: 'var(--text)' }}
    >
      <MIcon name={icon} size={14} style={{ color: 'var(--accent)', marginTop: 2 }} />
      <div className="flex flex-col">
        <span className="text-[12px] font-semibold">{title}</span>
        <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {subtitle}
        </span>
      </div>
    </button>
  );
}

// ─── IdentityDisclosure primitives ───────────────────────────────────────
// Single canonical scale used inside the expanded "Node details" panel:
//   PanelLabel  - section heading (10px uppercase, accent-tinted)
//   KV          - one row, fixed left label / right value alignment
//   Mono        - mono value cell (11.5px tabular-nums)
//   CopyMono    - clickable mono value with copy icon (accent)
//   PanelSection- column wrapper with consistent left divider + spacing
function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-[9.5px] uppercase font-semibold"
      style={{
        color: 'var(--accent)',
        letterSpacing: '0.08em',
        marginBottom: 2,
      }}
    >
      {children}
    </div>
  );
}

function PanelSection({
  label,
  labelTrailing,
  children,
}: {
  label: string;
  labelTrailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col lg:border-l lg:pl-4"
      style={{ borderColor: 'var(--border)', rowGap: 4 }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        <PanelLabel>{label}</PanelLabel>
        {labelTrailing}
      </div>
      {children}
    </section>
  );
}

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      className="flex items-center justify-between gap-3"
      style={{ minHeight: 20 }}
    >
      <span
        className="text-[10.5px] uppercase"
        style={{
          color: 'var(--text-dim)',
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span className="min-w-0 flex justify-end">{value}</span>
    </div>
  );
}

function Mono({
  children,
  title,
  truncate,
  maxWidth,
}: {
  children: ReactNode;
  title?: string;
  truncate?: boolean;
  maxWidth?: number;
}) {
  return (
    <span
      className={`mono-inline tabular-nums text-[11.5px]${truncate ? ' truncate' : ''}`}
      style={{
        color: 'var(--text)',
        ...(maxWidth ? { maxWidth } : null),
      }}
      title={title}
    >
      {children}
    </span>
  );
}

function CopyMono({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono-inline tabular-nums text-[11.5px] inline-flex items-center gap-1 hover:underline"
      style={{ color: 'var(--accent)' }}
      title="Copy"
    >
      <MIcon name="content_copy" size={11} />
      {text}
    </button>
  );
}

function IdentityDisclosure({
  node,
  status,
  onEditPricing,
  onReveal,
  onCopy,
}: {
  node: DeployedNode;
  status: NodeLiveStatus | null;
  onEditPricing: () => void;
  onReveal: () => void;
  onCopy: (label: string, value: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const operatorAddr = node.operatorAddress ?? '';
  const nodeAddr = status?.chainAddress ?? '';
  const region = node.region ?? '—';
  const hostPort = `${node.host ?? '127.0.0.1'}:${node.port}`;
  const countryLabel = node.countryName ?? node.country ?? region;


  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/5"
        style={{ borderBottom: open ? '1px solid var(--border)' : 'none' }}
      >
        <div className="flex items-center gap-2">
          <MIcon name="info" size={14} style={{ color: 'var(--accent)' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
            Node details
          </span>
          <span
            className="text-[11px] flex items-center gap-1"
            style={{ color: 'var(--text-dim)' }}
          >
            {operatorAddr ? shortAddr(operatorAddr, 6, 4) : hostPort} ·{' '}
            <CountryFlag code={node.country} />
            <span>{countryLabel}</span>
          </span>
          <HnsChip node={node} status={status} />
        </div>
        <MIcon name={open ? 'expand_less' : 'expand_more'} size={16} />
      </button>
      {open && (
        <div
          className="overflow-y-auto"
          style={{
            maxHeight: 'min(60vh, 520px)',
            padding: '14px 16px',
          }}
        >
          <div
            className="grid grid-cols-1 lg:grid-cols-[160px_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)]"
            style={{ columnGap: 18, rowGap: 14 }}
          >
            {/* Address QR */}
            <section className="flex flex-col items-center gap-2">
              <PanelLabel>Operator address</PanelLabel>
              {operatorAddr ? (
                <>
                  <div
                    className="rounded-md"
                    style={{
                      background: '#fff',
                      border: '1px solid var(--border)',
                      padding: 6,
                      lineHeight: 0,
                    }}
                  >
                    <QRCode value={operatorAddr} size={104} />
                  </div>
                  <button
                    type="button"
                    onClick={() => void onCopy('Operator address', operatorAddr)}
                    className="chip mono-inline tabular-nums"
                    style={{
                      fontSize: 10,
                      padding: '3px 8px',
                      color: 'var(--text)',
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                    title="Copy operator address"
                  >
                    <MIcon name="content_copy" size={10} />
                    {shortAddr(operatorAddr, 6, 4)}
                  </button>
                </>
              ) : (
                <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  Awaiting operator key
                </div>
              )}
            </section>

            {/* Identity */}
            <PanelSection label="Identity">
              {operatorAddr && (
                <KV
                  label="Operator"
                  value={
                    <CopyMono
                      onClick={() => void onCopy('Operator address', operatorAddr)}
                      text={shortAddr(operatorAddr, 8, 6)}
                    />
                  }
                />
              )}
              {nodeAddr && (
                <KV
                  label="Node"
                  value={
                    <CopyMono
                      onClick={() => void onCopy('Node address', nodeAddr)}
                      text={shortAddr(nodeAddr, 8, 6)}
                    />
                  }
                />
              )}
              <KV label="Host" value={<Mono>{hostPort}</Mono>} />
              {node.remoteUrl && node.remoteUrl !== node.host && (
                <KV label="Public URI" value={<Mono>{`https://${node.remoteUrl}:${node.port}`}</Mono>} />
              )}
              {node.tlsSha256 && (
                <KV
                  label="TLS pin"
                  value={<CopyMono onClick={() => void onCopy('TLS fingerprint', node.tlsSha256 ?? '')} text={`${node.tlsSha256.slice(0, 12)}…`} />}
                />
              )}
              <KV
                label="Region"
                value={
                  <span
                    className="inline-flex items-center gap-1.5 text-[11.5px]"
                    style={{ color: 'var(--text)' }}
                  >
                    <CountryFlag code={node.country} />
                    {countryLabel}
                  </span>
                }
              />
              <KV
                label="Protocol"
                value={
                  <span
                    className="text-[11.5px]"
                    style={{ color: 'var(--text)' }}
                  >
                    {node.serviceType}
                  </span>
                }
              />
              <KV label="HNS resolver" value={<HnsResolverControl node={node} status={status} />} />
              <button
                className="btn btn-secondary btn-sm self-start"
                style={{ marginTop: 6 }}
                onClick={onReveal}
                title="Decrypt and show this node's 24-word operator mnemonic"
              >
                <MIcon name="key" size={12} />
                Reveal mnemonic
              </button>
            </PanelSection>

            {/* Pricing */}
            <PanelSection label="Pricing">
              <KV
                label="Per GB"
                value={<Mono>{`${fmtDVPN(node.gigabytePriceDVPN, 3)} tDVPN`}</Mono>}
              />
              <KV
                label="Per hour"
                value={<Mono>{`${fmtDVPN(node.hourlyPriceDVPN, 3)} tDVPN`}</Mono>}
              />
              <KV
                label="Lease / hour"
                value={<Mono>{`${fmtDVPN(node.leaseHourlyPriceDVPN ?? node.hourlyPriceDVPN, 3)} tDVPN`}</Mono>}
              />
              {status?.chainPrices &&
                (status.chainPrices.perGb !== node.gigabytePriceDVPN ||
                  status.chainPrices.perHour !== node.hourlyPriceDVPN ||
                  status.chainPrices.leasePerHour !== (node.leaseHourlyPriceDVPN ?? node.hourlyPriceDVPN)) && (
                  <div className="text-[10.5px]" style={{ color: 'var(--yellow)' }}>
                    On chain: {fmtDVPN(status.chainPrices.perGb, 3)} / {fmtDVPN(status.chainPrices.perHour, 3)} / {fmtDVPN(status.chainPrices.leasePerHour, 3)} — the daemon syncs prices at its next start.
                  </div>
                )}
              <button
                className="btn btn-secondary btn-sm self-start"
                style={{ marginTop: 6 }}
                onClick={onEditPricing}
              >
                <MIcon name="price_change" size={12} />
                Edit pricing
              </button>
            </PanelSection>

            {/* Specs */}
            <SpecsReportingPanel node={node} onCopy={onCopy} />
          </div>
        </div>
      )}
    </div>
  );
}

function SpecsReportingPanel({
  node,
  onCopy,
}: {
  node: DeployedNode;
  onCopy: (label: string, value: string) => void | Promise<void>;
}) {
  const specs = node.specs;
  const txHash = node.specsTxHash;
  const pending = node.specsPublishPending === true && !txHash;
  const publishedAt = node.specsPublishedAt
    ? new Date(node.specsPublishedAt).toLocaleString()
    : null;
  const explorerUrl = txHash ? `https://explorer.solana.com/tx/${txHash}?cluster=devnet` : null;
  if (!specs && !txHash && !pending) return null;
  return (
    <PanelSection
      label="On-chain hardware reporting"
      labelTrailing={
        pending ? (
          <span
            className="chip"
            style={{
              background:
                'color-mix(in srgb, var(--yellow, #f5b04a) 14%, transparent)',
              border:
                '1px solid color-mix(in srgb, var(--yellow, #f5b04a) 50%, transparent)',
              color: 'var(--text)',
              fontSize: 9,
              padding: '2px 6px',
              letterSpacing: 0,
              textTransform: 'none',
            }}
          >
            Awaiting broadcast
          </span>
        ) : null
      }
    >
      {specs && (
        <>
          <KV
            label="CPU"
            value={
              <Mono title={specs.cpu} truncate maxWidth={220}>
                {specs.cpu || '—'}
              </Mono>
            }
          />
          <KV label="Cores" value={<Mono>{`${specs.cr}/${specs.c}`}</Mono>} />
          <KV
            label="RAM"
            value={<Mono>{`${Math.round(specs.r / 1024)} GiB`}</Mono>}
          />
          <KV
            label="RAM available"
            value={<Mono>{`${Math.round(specs.rr / 1024)} GiB`}</Mono>}
          />
        </>
      )}
      {publishedAt && (
        <KV
          label="Published"
          value={
            <span
              className="text-[11.5px] tabular-nums"
              style={{ color: 'var(--text)' }}
            >
              {publishedAt}
            </span>
          }
        />
      )}
      {txHash ? (
        <KV
          label="Tx"
          value={
            <span className="inline-flex items-center gap-2">
              <CopyMono
                onClick={() => void onCopy('Specs tx hash', txHash)}
                text={shortAddr(txHash, 8, 6)}
              />
              {explorerUrl && (
                <a
                  className="text-[11px] inline-flex items-center gap-0.5 hover:underline"
                  style={{ color: 'var(--accent)' }}
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="View on Solana Explorer (devnet)"
                >
                  View
                  <MIcon name="open_in_new" size={11} />
                </a>
              )}
            </span>
          }
        />
      ) : pending ? (
        <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
          Broadcast queued — will retry on next app start if it failed.
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
          No specs tx recorded for this node.
        </div>
      )}
    </PanelSection>
  );
}

function WithdrawEditor({
  nodeBalance,
  defaultTo,
  pending,
  onCancel,
  onSubmit,
}: {
  nodeBalance: number;
  defaultTo: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (amount: number, to: string) => void | Promise<void>;
}) {
  // Fees are paid in SOL by the node key, so the whole tDVPN amount is withdrawable.
  const GAS_BUFFER = 0;
  const OPS_BUFFER = 0;
  const maxWithdrawable = Math.max(0, nodeBalance - GAS_BUFFER);
  const suggested = Math.max(0, nodeBalance - GAS_BUFFER - OPS_BUFFER);
  const [amount, setAmount] = useState(suggested.toFixed(6));
  const [to, setTo] = useState(defaultTo);

  const amountNum = Number(amount) || 0;
  const valid =
    amountNum > 0 &&
    amountNum <= maxWithdrawable &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to.trim());
  const leaving = Math.max(0, nodeBalance - amountNum - GAS_BUFFER);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-sm no-drag">
      <div className="card-elev w-[480px] max-w-[92vw]">
        <div className="card-body">
          <div className="flex items-start gap-3">
            <div
              className="h-10 w-10 grid place-items-center flex-shrink-0"
              style={{
                background: 'var(--green-dim)',
                color: 'var(--green)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <MIcon name="north_east" size={20} />
            </div>
            <div className="flex-1">
              <div className="text-base font-bold" style={{ color: 'var(--text)' }}>
                Withdraw from node
              </div>
              <div className="mt-1 text-[13px]" style={{ color: 'var(--text-dim)' }}>
                Moves the node's on-chain revenue to its key (withdraw_node_revenue), then sends it to the address below.
              </div>
            </div>
          </div>

          <div className="callout mt-4">
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between">
                <span>Node balance</span>
                <span className="font-semibold" style={{ color: 'var(--text)' }}>
                  {fmtDVPN(nodeBalance)} tDVPN
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Estimated gas</span>
                <span>~{GAS_BUFFER} tDVPN</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Max withdrawable</span>
                <span>{fmtDVPN(maxWithdrawable)} tDVPN</span>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="field-label">Amount (tDVPN)</div>
            <div className="flex items-center gap-2">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                type="number"
                step="0.000001"
                min="0"
                max={maxWithdrawable}
                className="field-input flex-1"
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAmount(maxWithdrawable.toFixed(6))}
              >
                Max
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAmount(suggested.toFixed(6))}
              >
                Suggested
              </button>
            </div>
            <div className="mt-1.5 text-[11px]" style={{ color: 'var(--text-dim)' }}>
              Node will retain{' '}
              <span style={{ color: 'var(--text)' }}>{fmtDVPN(leaving)} tDVPN</span> after the
              transaction.
            </div>
          </div>

          <div className="mt-4">
            <div className="field-label">Destination address</div>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="field-input input-mono"
            />
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            <button className="btn btn-secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!valid || pending}
              onClick={() => onSubmit(amountNum, to.trim())}
            >
              {pending ? 'Broadcasting…' : `Withdraw ${fmtDVPNSend(amountNum)} tDVPN`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PricingEditor({
  initialGiga,
  initialHour,
  initialLease,
  onCancel,
  onSubmit,
}: {
  initialGiga: number;
  initialHour: number;
  initialLease: number;
  onCancel: () => void;
  onSubmit: (giga: number, hour: number, lease: number) => void | Promise<void>;
}) {
  const [giga, setGiga] = useState(String(initialGiga));
  const [hour, setHour] = useState(String(initialHour));
  const [lease, setLease] = useState(String(initialLease));
  const [pending, setPending] = useState(false);
  const gigaNum = Number(giga);
  const hourNum = Number(hour);
  const leaseNum = Number(lease);
  // The program rejects a zero price; all three are sent together. There is no
  // network price cap on the Solana program.
  const valid = gigaNum > 0 && hourNum > 0 && leaseNum > 0;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-sm no-drag">
      <div className="card-elev w-[440px] max-w-[92vw]">
        <div className="card-body">
          <div className="flex items-start gap-3">
            <div
              className="h-10 w-10 grid place-items-center flex-shrink-0"
              style={{
                background: 'var(--accent-glow)',
                color: 'var(--accent)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <MIcon name="price_change" size={20} />
            </div>
            <div className="flex-1">
              <div className="text-base font-bold" style={{ color: 'var(--text)' }}>
                Update node pricing
              </div>
              <div className="mt-1 text-[13px]" style={{ color: 'var(--text-dim)' }}>
                Writes the node config and restarts it; the daemon pushes all three prices on chain (update_node) at start-up.
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <div className="field-label">tDVPN per GB</div>
              <input
                value={giga}
                onChange={(e) => setGiga(e.target.value)}
                type="number"
                step="0.0001"
                className="field-input"
              />
            </div>
            <div>
              <div className="field-label">tDVPN per hour</div>
              <input
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                type="number"
                step="0.0001"
                className="field-input"
              />
            </div>
            <div className="col-span-2">
              <div className="field-label">tDVPN per hour (lease)</div>
              <input value={lease} onChange={(e) => setLease(e.target.value)} type="number" step="0.0001" className="field-input" />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            <button className="btn btn-secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!valid || pending}
              onClick={async () => {
                setPending(true);
                try {
                  await onSubmit(Number(giga), Number(hour), Number(lease));
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? 'Updating… (≈30 s)' : 'Update prices'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatChainStatus(s?: string): string {
  if (!s) return '—';
  const map: Record<string, string> = {
    listed: 'Listed',
    delisted: 'Delisted',
    'not-found': 'Closed',
    'not-opened': 'Not opened',
  };
  return map[s] ?? s;
}

function formatDuration(ms: number): string {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

interface LogField {
  key: string;
  value: string;
}

interface ParsedLog {
  time: string;
  level: string;
  message: string;
  fields: LogField[];
}

const LEVEL_COLORS: Record<string, string> = {
  ERROR: 'var(--red)',
  WARN: 'var(--yellow)',
  WARNING: 'var(--yellow)',
  INFO: 'var(--accent)',
  DEBUG: 'var(--text-dim)',
  TRACE: 'var(--text-muted)',
};

// Matches ANSI CSI escapes like ESC[90m, ESC[0m, ESC[1m, etc. Also matches
// the stripped form (bare `[90m`) some log backends emit when the ESC byte
// was already consumed somewhere upstream.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]|\[[0-9]{1,3}(?:;[0-9]{1,3})*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** dvpnd logs one JSON object per line: {"level","time","message", ...fields}. */
function parseJsonLogLine(line: string): ParsedLog | null {
  if (!line.startsWith('{')) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null; // not JSON after all — fall back to the text parser
  }
  const t = typeof obj.time === 'string' ? new Date(obj.time) : null;
  const time =
    t && !Number.isNaN(t.getTime())
      ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
      : '';
  const level = normalizeLevel(String(obj.level ?? ''));
  const message = String(obj.message ?? obj.msg ?? '');
  const fields: LogField[] = Object.entries(obj)
    .filter(([k]) => !['level', 'time', 'message', 'msg'].includes(k))
    .map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }));
  return { time, level, message, fields };
}

function parseLogLine(raw: string): ParsedLog {
  const line = stripAnsi(raw).replace(/\s+$/u, '');
  const json = parseJsonLogLine(line);
  if (json) return json;
  let time = '';
  let rest = line;
  const tsMatch = rest.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/u,
  );
  if (tsMatch) {
    const d = new Date(tsMatch[1]);
    if (!Number.isNaN(d.getTime())) {
      time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }
    rest = tsMatch[2];
  }
  let level = '';
  const lvlMatch = rest.match(
    /^\[?(ERROR|ERR|WARN(?:ING)?|INFO|INF|DEBUG|DBG|TRACE|TRC|FATAL|FTL)\]?[:\s]\s*(.*)$/iu,
  );
  if (lvlMatch) {
    level = normalizeLevel(lvlMatch[1]);
    rest = lvlMatch[2];
  }
  const { message, fields } = splitKV(rest);
  return { time, level, message, fields };
}

function splitKV(rest: string): { message: string; fields: LogField[] } {
  // zerolog-style: `Message text key=value key2="quoted value" key3=[1,2]`
  //
  // Some console-format daemons drop whitespace between the message and the
  // first field, and between subsequent fields, so the input becomes
  // `Registering nodeprice=1000remote_addrs=[...]`.
  // To recover sane fields:
  //   1. Find every `<key>=` boundary, treating the *last* run of `[A-Za-z_]\w*`
  //      directly before `=` as the key. Any preceding alphanumerics belong
  //      to the previous value (or the message).
  //   2. Each field's value runs from the `=` up to the start of the next
  //      key (or end of string). Quoted strings and bracketed lists are
  //      consumed greedily so embedded `=` doesn't fool us.
  const fields: LogField[] = [];
  const boundaries: { keyStart: number; keyEnd: number; valStart: number }[] = [];
  // Match any `=` not inside quotes/brackets, then walk back for the key.
  const eqRe = /=/g;
  let inQuote = false;
  let bracketDepth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (inQuote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === '[') bracketDepth++;
    else if (ch === ']' && bracketDepth > 0) bracketDepth--;
    else if (ch === '=' && bracketDepth === 0) {
      // Walk back to find the key. Key chars: [A-Za-z_][A-Za-z0-9_.-]*
      let k = i - 1;
      while (k >= 0 && /[A-Za-z0-9_.-]/.test(rest[k]!)) k--;
      // Inside the key range, the *first* char must match [A-Za-z_].
      // If the run is purely digits/punctuation, skip — not a real key.
      const keyStart = k + 1;
      if (keyStart >= i) continue;
      if (!/[A-Za-z_]/.test(rest[keyStart]!)) {
        // Trim leading non-letters so e.g. "5key=" still extracts "key".
        let s = keyStart;
        while (s < i && !/[A-Za-z_]/.test(rest[s]!)) s++;
        if (s >= i) continue;
        boundaries.push({ keyStart: s, keyEnd: i, valStart: i + 1 });
      } else {
        boundaries.push({ keyStart, keyEnd: i, valStart: i + 1 });
      }
    }
  }
  eqRe.lastIndex = 0;

  if (boundaries.length === 0) {
    return { message: rest.trim(), fields };
  }

  for (let bi = 0; bi < boundaries.length; bi++) {
    const b = boundaries[bi]!;
    const next = boundaries[bi + 1];
    // Value ends right before the next key (which starts at next.keyStart).
    const valEnd = next ? next.keyStart : rest.length;
    let value = rest.slice(b.valStart, valEnd).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    // Strip trailing comma/semicolon left over from glued field separation.
    value = value.replace(/[,;]+$/u, '');
    const key = rest.slice(b.keyStart, b.keyEnd);
    fields.push({ key, value });
  }
  // Message = everything before the first key, with trailing punctuation
  // and connecting whitespace stripped.
  const message = rest.slice(0, boundaries[0]!.keyStart).replace(/[\s,;:]+$/u, '').trim();
  return { message, fields };
}

function normalizeLevel(lvl: string): string {
  const u = lvl.toUpperCase();
  if (u === 'ERR') return 'ERROR';
  if (u === 'INF') return 'INFO';
  if (u === 'WARNING') return 'WARN';
  if (u === 'DBG') return 'DEBUG';
  if (u === 'TRC') return 'TRACE';
  if (u === 'FTL') return 'FATAL';
  return u;
}

function LogRow({ line }: { line: ParsedLog }) {
  const color = LEVEL_COLORS[line.level] ?? 'var(--text-dim)';
  return (
    <div
      className="flex items-baseline gap-2"
      style={{
        padding: '1px 12px',
        color: 'var(--text-terminal)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {line.time && (
        <span
          className="flex-shrink-0 tabular-nums"
          style={{ color: 'var(--text-muted)', fontSize: 10 }}
        >
          {line.time}
        </span>
      )}
      <span
        className="flex-shrink-0 uppercase"
        style={{ color, fontSize: 10, fontWeight: 700, width: 36, textAlign: 'left' }}
      >
        {line.level || '—'}
      </span>
      <span className="flex-1 min-w-0">
        <span style={{ color: 'var(--text-terminal)' }}>{line.message}</span>
        {line.fields.map((f, i) => (
          <span key={i} style={{ marginLeft: 8 }}>
            <span style={{ color: 'var(--text-muted)' }}>{f.key}=</span>
            <span style={{ color: 'var(--text-terminal)' }}>{f.value}</span>
          </span>
        ))}
      </span>
    </div>
  );
}


/** 'A protocol switch' -> 'Switching protocol' for the status line while a change runs (T9 d). */
function changeLabel(change: string): string {
  const m: Record<string, string> = {
    'A protocol switch': 'Switching protocol',
    'A restart': 'Restarting',
    'A price change': 'Applying the new prices',
    'An HNS resolver switch': 'Switching the HNS resolver',
  };
  return m[change] ?? 'Applying a change';
}
