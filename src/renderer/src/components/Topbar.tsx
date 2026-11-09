import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { fmtDVPN } from '../lib/format';
import { MIcon } from './MIcon';
import { useTheme } from '../lib/theme';

// If the backend stops emitting deploy frames for this long, treat the
// in-flight job as wedged and surface a Cancel button instead of the
// silent spinning pill.
const STALE_PROGRESS_MS = 90_000;

export function Topbar() {
  const {
    wallet,
    refreshWallet,
    settings,
    online,
    chainHealth,
    progress,
    progressAt,
    route,
    navigate,
    nodes,
    clearStuckDeploy,
  } = useApp();
  const [theme, , toggleTheme] = useTheme();

  // Force a re-render every 5s so the staleness pill flips to "stuck" without
  // needing a new progress frame to arrive.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!progress) return;
    const t = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [progress]);

  const deployActive =
    progress &&
    progress.phase !== 'done' &&
    progress.phase !== 'error' &&
    progress.phase !== 'cancelled' &&
    route.name !== 'progress';
  const isStuck =
    deployActive && progressAt !== null && Date.now() - progressAt > STALE_PROGRESS_MS;
  const activeNode = deployActive
    ? nodes.find((n) => n.id === progress.nodeId)
    : null;
  const deployMoniker = activeNode?.moniker ?? 'node';

  const healthy = chainHealth.filter((h) => h.reachable).length;
  const healthDot =
    chainHealth.length === 0
      ? 'var(--text-dim)'
      : healthy === 0
        ? 'var(--red)'
        : healthy < chainHealth.length
          ? 'var(--yellow)'
          : 'var(--green)';

  return (
    <header
      className="drag-region flex items-center px-6 gap-3 flex-shrink-0"
      style={{
        height: 'var(--header-h)',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
      }}
    >
      <div className="flex-1" />

      {deployActive && (
        <div className="no-drag flex items-center gap-1">
          <button
            className="flex items-center gap-2 px-3 py-1.5"
            onClick={() =>
              navigate({
                name: 'progress',
                jobId: progress.jobId,
                moniker: deployMoniker,
              })
            }
            title={
              isStuck
                ? `No update for ${Math.round((Date.now() - (progressAt ?? Date.now())) / 1000)}s — click to inspect or use ✕ to clear`
                : `${progress.message} — click to return`
            }
            style={{
              background: isStuck
                ? 'color-mix(in srgb, var(--yellow) 18%, transparent)'
                : 'var(--accent-dim)',
              border: `1px solid ${
                isStuck
                  ? 'color-mix(in srgb, var(--yellow) 45%, transparent)'
                  : 'color-mix(in srgb, var(--accent) 35%, transparent)'
              }`,
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: isStuck ? 'var(--yellow)' : 'var(--accent)',
                animation: isStuck ? 'none' : 'pulse-dot 1.4s ease-in-out infinite',
              }}
            />
            <span
              className="text-[11px] uppercase tracking-wider"
              style={{ color: 'var(--text-dim)' }}
            >
              {isStuck ? 'Stuck' : 'Deploying'}
            </span>
            <span className="text-[12px] font-semibold truncate max-w-[140px]">
              {deployMoniker}
            </span>
            <span
              className="tabular-nums text-[12px] font-semibold"
              style={{
                color: isStuck ? 'var(--yellow)' : 'var(--accent-bright, var(--accent))',
              }}
            >
              {Math.round(progress.percent)}%
            </span>
          </button>
          <button
            className="flex items-center justify-center"
            onClick={() => void clearStuckDeploy()}
            title="Cancel and clear this deploy"
            style={{
              width: 28,
              height: 28,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-dim)',
            }}
          >
            <MIcon name="close" size={14} />
          </button>
        </div>
      )}

      {!online && (
        <span className="no-drag chip chip-warn">
          <MIcon name="wifi_off" size={12} />
          Offline
        </span>
      )}

      <button
        className="no-drag flex items-center gap-2 px-3 py-2 text-xs"
        onClick={() => void refreshWallet()}
        title="Refresh balance"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-dim)',
        }}
      >
        <MIcon name="refresh" size={14} />
        <span className="uppercase tracking-wider">Balance</span>
        <span className="font-bold text-[13px]" style={{ color: 'var(--text)' }}>
          {wallet ? fmtDVPN(wallet.balanceDVPN) : '0.00'} tDVPN
        </span>
      </button>

      <div
        className="no-drag flex items-center gap-2 px-3 py-2 text-[10px] uppercase tracking-wider"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          color: 'var(--text-dim)',
        }}
        title={
          chainHealth.length
            ? chainHealth
                .map(
                  (h) =>
                    `${h.rpcUrl.replace('https://', '')}: ${h.reachable ? 'ok' : (h.error ?? 'down')}`,
                )
                .join('\n')
            : 'probing…'
        }
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: healthDot }}
        />
        Solana devnet
      </div>

      <button
        className="no-drag btn btn-ghost !p-2"
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label="Toggle theme"
      >
        <MIcon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} size={18} />
      </button>
    </header>
  );
}
