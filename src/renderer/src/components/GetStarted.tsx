import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { MIcon } from './MIcon';

// ─── Get started ───
// First-node checklist on the Overview screen, shown until the first node exists. Every step
// reads live state (wallet balance, Docker), so the user always sees the one thing left to do.

/** Per node: 0.05 SOL on the node key + fees, and the 1 tDVPN bond (Onboarding slide 4). */
const NEED_SOL = 0.06;
const NEED_DVPN = 1;

type Step = { done: boolean; title: string; body: string; action?: { label: string; icon: string; run: () => void } };

export function GetStarted() {
  const { wallet, nodes, navigate, refreshWallet } = useApp();
  const [docker, setDocker] = useState<'checking' | 'running' | 'off'>('checking');
  const [copied, setCopied] = useState(false);

  const checkDocker = useCallback(async () => {
    setDocker('checking');
    try {
      const o = await window.api.docker.overview();
      setDocker(o.reachable ? 'running' : 'off');
    } catch (err) {
      console.warn('get-started: docker overview failed', err);
      setDocker('off');
    }
  }, []);

  useEffect(() => {
    void checkDocker();
    const id = setInterval(() => void refreshWallet(), 20_000);
    return () => clearInterval(id);
  }, [checkDocker, refreshWallet]);

  if (nodes.length > 0 || !wallet?.address) return null;

  const sol = wallet.balanceSOL ?? 0;
  const dvpn = wallet.balanceDVPN;
  const funded = sol >= NEED_SOL && dvpn >= NEED_DVPN;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('get-started: copy address failed', err);
    }
  };

  const steps: Step[] = [
    { done: true, title: 'Wallet ready', body: 'Your wallet is set up and encrypted on this computer.' },
    {
      done: funded,
      title: funded ? 'Wallet funded' : `Fund your wallet: ${NEED_SOL} SOL + ${NEED_DVPN} tDVPN per node`,
      body: funded
        ? `${sol.toFixed(3)} SOL and ${dvpn.toFixed(2)} tDVPN available.`
        : `Send devnet SOL and tDVPN to ${wallet.address}. Now: ${sol.toFixed(3)} SOL, ${dvpn.toFixed(2)} tDVPN. This updates by itself.`,
      action: funded ? undefined : { label: copied ? 'Copied' : 'Copy address', icon: copied ? 'check' : 'content_copy', run: () => void copy() },
    },
    {
      done: false,
      title: 'Choose where your node runs',
      body:
        docker === 'running'
          ? 'Docker is running here, so you can host the node on this computer, or on any Linux server you can reach over SSH.'
          : docker === 'checking'
            ? 'Checking for Docker on this computer…'
            : 'To host on this computer, install or start Docker Desktop. Or host it on a Linux server over SSH (the app sets up Docker there).',
    },
  ];

  return (
    <div className="card" data-testid="get-started">
      <div className="card-header">
        <div className="card-title flex items-center gap-2">
          <MIcon name="rocket_launch" size={16} /> Get started: your first node
        </div>
      </div>
      <div className="card-body flex flex-col gap-3">
        {steps.map((s, i) => (
          <div key={s.title} className="flex items-start gap-3">
            <div
              className="h-6 w-6 shrink-0 rounded-full grid place-items-center text-[11px] font-semibold"
              style={{
                background: s.done ? 'color-mix(in srgb, var(--green) 20%, transparent)' : 'var(--bg-input)',
                color: s.done ? 'var(--green)' : 'var(--text-dim)',
                border: '1px solid var(--border)',
              }}
            >
              {s.done ? <MIcon name="check" size={14} /> : i + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>{s.title}</div>
              <div className="text-xs break-all" style={{ color: 'var(--text-muted)' }}>{s.body}</div>
            </div>
            {s.action && (
              <button className="btn btn-ghost shrink-0" onClick={s.action.run}>
                <MIcon name={s.action.icon} size={14} /> {s.action.label}
              </button>
            )}
          </div>
        ))}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-1">
          <button
            className="btn btn-primary"
            disabled={!funded || docker !== 'running'}
            title={!funded ? 'Fund the wallet first' : docker !== 'running' ? 'Docker is not running on this computer' : undefined}
            onClick={() => navigate({ name: 'deploy-local' })}
          >
            <MIcon name="computer" size={14} /> Host on this computer
          </button>
          <button
            className="btn btn-primary"
            disabled={!funded}
            title={!funded ? 'Fund the wallet first' : undefined}
            onClick={() => navigate({ name: 'deploy-ssh' })}
          >
            <MIcon name="cloud" size={14} /> Host on a server (SSH)
          </button>
        </div>
        {docker === 'off' && (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" onClick={() => void window.api.docker.start().then(() => setTimeout(() => void checkDocker(), 15_000))}>
              <MIcon name="play_arrow" size={14} /> Start Docker Desktop
            </button>
            <a className="btn btn-ghost" href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer">
              <MIcon name="download" size={14} /> Get Docker Desktop
            </a>
            <button className="btn btn-ghost" onClick={() => void checkDocker()}>
              <MIcon name="refresh" size={14} /> Check again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
