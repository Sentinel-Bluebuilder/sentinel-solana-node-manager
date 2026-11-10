import { useEffect, useMemo, useState } from 'react';
import { MIcon } from '../components/MIcon';
import { GetStarted } from '../components/GetStarted';
import { useApp } from '../store/app';
import { fmtDVPN, relativeTime } from '../lib/format';

export function Overview() {
  const {
    nodes,
    events,
    navigate,
    refreshWallet,
    refreshNodes,
    refreshEvents,
    liveStatuses,
    refreshStatus,
  } = useApp();

  useEffect(() => {
    for (const n of nodes) {
      if (!liveStatuses[n.id]) void refreshStatus(n.id);
    }
    // Push updates via onLiveStatus keep liveStatuses fresh; we only prime
    // entries that have never been seen. Intentionally exclude liveStatuses
    // from deps — its identity changes on every push and would re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, refreshStatus]);

  const totals = useMemo(() => {
    let peers = 0;
    let reachable = 0;
    for (const n of nodes) {
      const s = liveStatuses[n.id];
      if (s?.reachable) {
        reachable++;
        peers += s.sessions;
      }
    }
    const liquidBalance = nodes.reduce((sum, n) => sum + n.balanceDVPN, 0);
    return { peers, liquidBalance, reachable };
  }, [nodes, liveStatuses]);

  const [lastRefreshed, setLastRefreshed] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const refreshAll = () => {
    void refreshWallet();
    void refreshNodes();
    void refreshEvents();
    for (const n of nodes) void refreshStatus(n.id);
    setLastRefreshed(Date.now());
  };

  const staleSeconds = Math.floor((now - lastRefreshed) / 1000);
  const stale = staleSeconds > 90;
  const hasNodes = nodes.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <GetStarted />
      {/* Hero */}
      <div
        className="relative"
        style={{
          background:
            'radial-gradient(ellipse at top left, color-mix(in srgb, var(--accent) 18%, transparent) 0%, transparent 55%), radial-gradient(ellipse at bottom right, color-mix(in srgb, var(--accent) 10%, transparent) 0%, transparent 60%), var(--bg-input)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 'clamp(20px, 2.6vw, 32px) clamp(18px, 2.4vw, 28px)',
          containerType: 'inline-size',
        }}
      >
        <div className="flex flex-col items-center text-center gap-2">
          <h1
            className="font-semibold"
            style={{
              color: 'var(--text)',
              fontFamily:
                'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
              fontSize: 'clamp(18px, 3.4cqi, 32px)',
              lineHeight: 1.15,
              letterSpacing: '-0.01em',
              margin: 0,
              maxWidth: '100%',
              textWrap: 'balance',
            }}
          >
            Secure Bandwidth for Anyone, Anywhere in the World
          </h1>
          <div
            className="text-sm"
            style={{
              color: 'var(--text-muted)',
              maxWidth: 580,
              marginTop: 6,
              lineHeight: 1.5,
            }}
          >
            Spin up nodes, sell capacity, and earn tDVPN straight from your machine.
            <br />
            Your keys, your hardware, your terms.
          </div>
          <div className="flex items-center justify-center gap-3 mt-4 flex-wrap">
            <button
              className="btn btn-primary"
              onClick={() => navigate({ name: 'deploy-local' })}
              style={{ fontSize: 14, padding: '10px 18px', height: 'auto' }}
            >
              <MIcon name="rocket_launch" size={16} />
              {hasNodes ? 'Deploy another node' : 'Deploy your first node'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => navigate({ name: 'wallet' })}
              style={{ fontSize: 14, padding: '10px 18px', height: 'auto' }}
            >
              <MIcon name="account_balance_wallet" size={16} />
              Wallet
            </button>
            <button
              className="btn btn-ghost"
              onClick={refreshAll}
              title="Refresh all"
              style={{ fontSize: 14, padding: '10px 18px', height: 'auto' }}
            >
              <MIcon name="refresh" size={16} />
              Refresh
            </button>
          </div>

          <div
            className="flex items-center justify-center mt-3"
            style={{ fontSize: 12 }}
          >
            <span style={{ color: stale ? 'var(--yellow)' : 'var(--text-dim)' }}>
              {stale ? 'Stale · ' : 'Updated '}
              {relativeTime(new Date(lastRefreshed).toISOString())}
            </span>
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-12 gap-3">
        <Kpi
          icon="public"
          label="Connected peers"
          value={totals.peers.toString()}
          tone="accent"
          hint={hasNodes ? 'live VPN sessions' : 'deploy to start'}
        />
        <Kpi
          icon="dns"
          label="Nodes online"
          value={`${totals.reachable}/${nodes.length || 0}`}
          tone={totals.reachable === nodes.length && hasNodes ? 'green' : 'accent'}
          hint={hasNodes ? `${nodes.length} total` : 'none deployed'}
        />
        <Kpi
          icon="payments"
          label="Operator earnings"
          value={`${fmtDVPN(totals.liquidBalance)} tDVPN`}
          tone="green"
          hint="across all nodes"
        />
        <Kpi
          icon="history"
          label="Activity"
          value={events.length.toString()}
          tone="default"
          hint={events[0] ? relativeTime(events[0].timestamp) : 'no events yet'}
        />
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-12 gap-3">
        <ActionTile
          title="Deploy locally"
          desc="Run a node in Docker on this machine."
          icon="desktop_windows"
          onClick={() => navigate({ name: 'deploy-local' })}
        />
        <ActionTile
          title="Deploy over SSH"
          desc="Provision a remote VPS as a node."
          icon="dns"
          onClick={() => navigate({ name: 'deploy-ssh' })}
        />
        <ActionTile
          title="Batch deploy"
          desc="Roll out many SSH targets in one pass."
          icon="grid_view"
          onClick={() => navigate({ name: 'deploy-ssh-batch' })}
        />
        <ActionTile
          title="Automate via CLI"
          desc="Headless control of every action."
          icon="terminal"
          onClick={() => navigate({ name: 'cli' })}
        />
      </div>

    </div>
  );
}

interface KpiProps {
  icon: string;
  label: string;
  value: string;
  hint: string;
  tone: 'default' | 'accent' | 'green';
}

function Kpi({ icon, label, value, hint, tone }: KpiProps) {
  const tint =
    tone === 'green'
      ? 'var(--green)'
      : tone === 'accent'
        ? 'var(--accent)'
        : 'var(--text-muted)';
  return (
    <div
      className="col-span-6 lg:col-span-3 flex flex-col items-center text-center"
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '14px 16px',
        gap: 6,
      }}
    >
      <div
        className="h-9 w-9 rounded-md grid place-items-center flex-shrink-0"
        style={{
          background: `color-mix(in srgb, ${tint} 15%, transparent)`,
          color: tint,
        }}
      >
        <MIcon name={icon} size={18} />
      </div>
      <div className="w-full min-w-0">
        <div
          className="text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          {label}
        </div>
        <div
          className="text-lg font-semibold leading-tight truncate"
          style={{ color: 'var(--text)' }}
          title={value}
        >
          {value}
        </div>
        <div
          className="text-[11px] truncate"
          style={{ color: 'var(--text-muted)' }}
        >
          {hint}
        </div>
      </div>
    </div>
  );
}

interface ActionTileProps {
  title: string;
  desc: string;
  icon: string;
  onClick: () => void;
}

function ActionTile({ title, desc, icon, onClick }: ActionTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="col-span-12 sm:col-span-6 lg:col-span-3 transition-colors group flex flex-col items-center text-center"
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '12px 16px',
        cursor: 'pointer',
        gap: 6,
      }}
    >
      <div
        className="rounded-md grid place-items-center"
        style={{
          height: 40,
          width: 40,
          background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
          color: 'var(--accent)',
        }}
      >
        <MIcon name={icon} size={22} />
      </div>
      <div
        className="text-sm font-semibold"
        style={{ color: 'var(--text)' }}
      >
        {title}
      </div>
      <div
        className="text-[11px] leading-snug"
        style={{ color: 'var(--text-muted)' }}
      >
        {desc}
      </div>
    </button>
  );
}

