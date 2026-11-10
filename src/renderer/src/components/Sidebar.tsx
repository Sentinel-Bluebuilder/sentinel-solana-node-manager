import { useApp, type Route } from '../store/app';
import { MIcon } from './MIcon';

interface Item {
  key: string;
  label: string;
  icon: string;
  route?: Route;
  comingSoon?: boolean;
}

const TOP: Item[] = [
  { key: 'overview', label: 'Overview', icon: 'dashboard', route: { name: 'overview' } },
  { key: 'nodes', label: 'My Nodes', icon: 'dns', route: { name: 'nodes' } },
  { key: 'activity', label: 'Activity', icon: 'history', route: { name: 'activity' } },
  { key: 'deploy-local', label: 'Deploy Local', icon: 'desktop_windows', route: { name: 'deploy-local' } },
  { key: 'deploy-ssh', label: 'Deploy SSH', icon: 'cloud', route: { name: 'deploy-ssh' } },
  { key: 'earnings', label: 'Earnings', icon: 'paid', comingSoon: true },
  { key: 'manage-docker', label: 'Manage Docker', icon: 'deployed_code', route: { name: 'manage-docker' } },
  { key: 'wallet', label: 'Wallet', icon: 'account_balance_wallet', route: { name: 'wallet' } },
  { key: 'cli', label: 'CLI', icon: 'terminal', route: { name: 'cli' } },
];

const BOTTOM: Item[] = [
  { key: 'on-chain-specs', label: 'On-Chain Specs', icon: 'receipt_long', route: { name: 'on-chain-specs' } },
  { key: 'system', label: 'System', icon: 'memory', route: { name: 'system' } },
  { key: 'settings', label: 'Settings', icon: 'settings', route: { name: 'settings' } },
  { key: 'help', label: 'Help', icon: 'help', route: { name: 'help' } },
];

export function Sidebar() {
  const { route, navigate, wallet, logoutWallet, confirm, pushToast } = useApp();
  const activeKey = activeKeyFor(route);

  const onLogout = async () => {
    const ok = await confirm({
      title: 'Log out of this wallet?',
      body: `The encrypted ${wallet?.secretKind === 'keyfile' ? 'key file' : 'recovery phrase'} will be removed from this device. You can only sign back in if you have a copy of it. Running nodes are not affected; their keys stay backed up in the app.`,
      tone: 'danger',
      confirmLabel: 'Log out',
      requireType: 'LOGOUT',
    });
    if (!ok) return;
    try {
      await logoutWallet();
      pushToast({
        title: 'Logged out',
        body: 'The encrypted wallet vault has been cleared from this device.',
        tone: 'success',
      });
    } catch (err) {
      pushToast({
        title: 'Logout failed',
        body: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  };

  const renderItem = (it: Item) => {
    if (it.comingSoon || !it.route) {
      return (
        <button
          key={it.key}
          disabled
          className="no-drag nav-item w-full justify-between"
          style={{ opacity: 0.55, cursor: 'not-allowed' }}
          title="Coming soon"
        >
          <span className="flex items-center gap-2">
            <MIcon name={it.icon} size={18} />
            <span>{it.label}</span>
          </span>
          <span
            className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              color: 'var(--text-dim)',
              letterSpacing: '0.06em',
            }}
          >
            Soon
          </span>
        </button>
      );
    }
    const active = it.key === activeKey;
    const route = it.route;
    return (
      <button
        key={it.key}
        onClick={() => navigate(route)}
        className={`no-drag nav-item w-full ${active ? 'active' : ''}`}
      >
        <MIcon name={it.icon} size={18} filled={active} />
        <span>{it.label}</span>
      </button>
    );
  };

  const platform = window.api.platform;
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const headerPad = isMac ? 'pt-10' : 'pt-6';

  return (
    <aside
      className="flex-shrink-0 flex flex-col h-full overflow-hidden"
      style={{
        width: 'var(--sidebar-w)',
        background: 'var(--bg)',
        borderRight: '1px solid var(--border)',
      }}
    >
      <div className={`drag-region px-5 ${headerPad} pb-5 flex items-center gap-3 flex-shrink-0`}>
        <img
          src="./brand/sentinel-shield-transparent.png"
          alt="Sentinel"
          width={34}
          height={34}
          style={{ display: 'block', flexShrink: 0 }}
        />
        <div className="leading-tight min-w-0 flex-1">
          <div
            className="font-bold text-[20px] flex items-center gap-2.5"
            style={{ color: 'var(--text)' }}
          >
            <span>Sentinel</span>
            {isWin && (
              <svg
                aria-label="Windows"
                role="img"
                width={17}
                height={17}
                viewBox="0 0 16 16"
                style={{
                  flexShrink: 0,
                  color: '#0078D4',
                  display: 'block',
                  transform: 'translateY(0.5px)',
                }}
              >
                <path
                  fill="currentColor"
                  d="M0 2.25 6.546 1.36v6.39H0V2.25Zm0 11.5L6.546 14.64v-6.39H0v5.5Zm7.273.89L16 16V8.25H7.273v6.39ZM7.273 1.36V7.75H16V0L7.273 1.36Z"
                />
              </svg>
            )}
          </div>
          <div
            className="text-[11px]"
            style={{ color: 'var(--text-dim)' }}
          >
            Node Manager
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 space-y-1 mt-2">{TOP.map(renderItem)}</nav>
      <nav
        className="px-3 space-y-1 pt-3"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        {BOTTOM.map(renderItem)}
      </nav>
      {wallet?.address ? (
        <div
          className="px-3 pt-3 pb-4 mt-1"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={() => void onLogout()}
            className="no-drag nav-item w-full justify-between"
            title={wallet.address}
          >
            <span className="flex items-center gap-2 min-w-0">
              <MIcon name="logout" size={18} />
              <span className="flex flex-col items-start min-w-0">
                <span>Log out</span>
                <span
                  className="mono-inline truncate text-[10px]"
                  style={{ color: 'var(--text-dim)', maxWidth: '140px' }}
                >
                  {wallet.address.slice(0, 10)}…{wallet.address.slice(-4)}
                </span>
              </span>
            </span>
          </button>
        </div>
      ) : (
        <div
          className="px-3 pt-3 pb-4 mt-1"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <button
            onClick={() => navigate({ name: 'wallet-setup' })}
            className="no-drag w-full flex flex-col items-stretch gap-1.5 px-3 py-2.5 text-left"
            style={{
              background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 38%, transparent)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
            }}
            title="Create or restore your Sentinel wallet"
          >
            <span
              className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              <MIcon name="account_balance_wallet" size={14} />
              No wallet yet
            </span>
            <span className="text-[12px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              Create or restore a wallet to deploy nodes and earn rewards.
            </span>
            <span
              className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              Create / Restore wallet
              <MIcon name="arrow_forward" size={12} />
            </span>
          </button>
        </div>
      )}
      {/* Attribution required by the Sentinel dVPN License §4. The link opens in the OS browser (setWindowOpenHandler). */}
      <div className="px-4 pb-3 text-[11px]" style={{ color: 'var(--text-dim)' }}>
        Built on Sentinel.{' '}
        <a href="https://sentinel.co" target="_blank" rel="noreferrer" className="no-drag underline" style={{ color: 'var(--text-muted)' }}>
          sentinel.co
        </a>
      </div>
    </aside>
  );
}

function activeKeyFor(route: Route): Route['name'] {
  if (route.name === 'node-details') return 'nodes';
  if (route.name === 'progress') return route.origin === 'ssh' ? 'deploy-ssh' : 'deploy-local';
  return route.name;
}
