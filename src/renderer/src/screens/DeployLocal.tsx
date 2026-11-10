import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import { fmtDVPN } from '../lib/format';
import type { LocalSystemReport, VpnServiceType } from '../../../shared/types';

/** 1 tDVPN bond (returned on removal). */
const DEPLOY_MIN_DVPN = 1;
/** 0.05 SOL to the node key + 0.01 for the funding tx. */
const DEPLOY_MIN_SOL = 0.06;
const PORT_BLOCK = 5;

export function DeployLocal() {
  const { navigate, nodes, pushToast, wallet, settings, saveSettings, refreshSettings } =
    useApp();
  const [report, setReport] = useState<LocalSystemReport | null>(null);
  const [starting, setStarting] = useState(false);
  const [dockerStarting, setDockerStarting] = useState(false);
  const [moniker, setMoniker] = useState(defaultMoniker());
  const [service, setService] = useState<VpnServiceType>('wireguard');
  const [gigabytePrice, setGigabytePrice] = useState('0.002');
  const [hourlyPrice, setHourlyPrice] = useState('0.001');
  const [leasePrice, setLeasePrice] = useState('0.001');
  const [publicHost, setPublicHost] = useState('');
  const [country, setCountry] = useState('');
  const publicHostValid = publicHost.trim() === '' || /^[A-Za-z0-9.\-]{1,253}$/.test(publicHost.trim());
  const countryValid = country.trim() === '' || /^[A-Za-z]{2}$/.test(country.trim());

  const MAX_LOCAL_NODES = 3;
  // Nodes past the removal 'stop' stage no longer hold a container or ports.
  const localNodes = nodes.filter(
    (n) => n.target === 'local' && (!n.removalStage || n.removalStage === 'redeem' || n.removalStage === 'stop'),
  );
  const overlaps = (p: number) => localNodes.some((n) => Math.abs(n.port - p) < PORT_BLOCK);
  const suggestedPort = [20000, 20010, 20020, 20030, 20040, 20050].find((p) => !overlaps(p)) ?? 20100;
  const [port, setPort] = useState(suggestedPort);
  const atCap = localNodes.length >= MAX_LOCAL_NODES;
  const nearCap = localNodes.length >= MAX_LOCAL_NODES - 1 && !atCap;

  const portInUse = overlaps(port);
  const portValid =
    Number.isInteger(port) && port >= 1024 && port + PORT_BLOCK - 1 <= 65535 && !portInUse;
  const portError = !Number.isInteger(port)
    ? 'Port must be a whole number.'
    : port < 1024 || port + PORT_BLOCK - 1 > 65535
      ? `Port must be between 1024 and ${65535 - PORT_BLOCK + 1}.`
      : portInUse
        ? `Ports ${port}–${port + PORT_BLOCK - 1} overlap another local node.`
        : null;

  // The program rejects a zero price (all three are set at open_node); no price cap.
  const pricesValid = Number(gigabytePrice) > 0 && Number(hourlyPrice) > 0 && (Number(leasePrice) || Number(hourlyPrice)) > 0;

  useEffect(() => {
    void window.api.system.report().then(setReport);
  }, []);

  useEffect(() => {
    if (!settings) void refreshSettings();
  }, [settings, refreshSettings]);

  const startDocker = async () => {
    setDockerStarting(true);
    try {
      const res = await window.api.docker.start();
      if (!res.started) {
        pushToast({
          title: 'Could not start Docker Desktop',
          body: res.error ?? 'Launcher did not spawn.',
          tone: 'error',
        });
        setDockerStarting(false);
        return;
      }
      const deadline = Date.now() + 60_000;
      let attempts = 0;
      while (Date.now() < deadline && attempts < 30) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const next = await window.api.system.report();
          setReport(next);
          if (next.dockerReachable) break;
        } catch (err) {
          // transient IPC failure while the daemon is still coming up — keep polling
          console.warn('[startDocker] report failed, retrying', (err as Error).message);
        }
      }
      if (!(await window.api.system.report().catch(() => null))?.dockerReachable) {
        pushToast({
          title: 'Docker did not come up',
          body: 'The daemon is still not reachable after 60 seconds. Check Docker Desktop.',
          tone: 'warn',
        });
      }
    } finally {
      setDockerStarting(false);
    }
  };

  const startLocal = async () => {
    setStarting(true);
    try {
      const { jobId } = await window.api.deploy.start({
        target: 'local',
        moniker: moniker.trim(),
        serviceType: service,
        gigabytePriceDVPN: Number(gigabytePrice) || 0,
        hourlyPriceDVPN: Number(hourlyPrice) || 0,
        leaseHourlyPriceDVPN: Number(leasePrice) || Number(hourlyPrice) || 0,
        port,
        remoteUrl: publicHost.trim() || undefined,
        country: country.trim() ? country.trim().toUpperCase() : undefined,
      });
      navigate({ name: 'progress', jobId, moniker: moniker.trim(), origin: 'local' });
    } catch (e) {
      pushToast({ title: 'Could not start deploy', body: (e as Error).message, tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const walletBalance = wallet?.balanceDVPN ?? 0;
  const walletSol = wallet?.balanceSOL ?? 0;
  const fundsOk = walletBalance >= DEPLOY_MIN_DVPN && walletSol >= DEPLOY_MIN_SOL;

  const localReady =
    report?.osCompatible &&
    report?.memoryOk &&
    report?.dockerReachable &&
    moniker.trim().length >= 3 &&
    portValid &&
    pricesValid &&
    publicHostValid &&
    countryValid &&
    !atCap &&
    fundsOk;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <PageHeader
        title="Deploy Local"
        subtitle="Run a Sentinel dVPN node (dvpnd, Solana devnet) in a Docker container on this machine."
        right={
          <span className="mono-tag">
            {nodes.length} node{nodes.length === 1 ? '' : 's'} in inventory
          </span>
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <div className="card col-span-12 lg:col-span-8 flex flex-col overflow-hidden">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <div
                className="h-9 w-9 rounded-lg grid place-items-center flex-shrink-0"
                style={{
                  background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <MIcon name="desktop_windows" size={18} />
              </div>
              <div>
                <div className="card-title">This device</div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Deploy on the machine running this app.
                </div>
              </div>
            </div>
            <span className="chip chip-accent">Local</span>
          </div>

          <div className="card-body flex flex-col gap-2">
            <SystemChecksRow report={report} />

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-8">
                <div className="field-label">Moniker</div>
                <input
                  value={moniker}
                  onChange={(e) => setMoniker(e.target.value)}
                  className="field-input mono-inline"
                  placeholder="my-dvpn-node"
                />
              </div>
              <div className="col-span-4">
                <div className="field-label">First port (uses {port}–{port + PORT_BLOCK - 1})</div>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="field-input"
                  aria-invalid={!portValid}
                />
              </div>
              {portError && (
                <div
                  className="col-span-12 text-[11px] -mt-1"
                  style={{ color: 'var(--red)' }}
                >
                  {portError}
                </div>
              )}
            </div>

            <div>
              <div className="field-label">Protocol</div>
              <ProtocolTiles value={service} onChange={setService} />
            </div>

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-8">
                <div className="field-label">Public host or IP clients dial <span style={{ color: 'var(--text-dim)' }}>(optional — default: this machine's LAN IP)</span></div>
                <input value={publicHost} onChange={(e) => setPublicHost(e.target.value)} placeholder="e.g. your public IP or a DNS name pointing here" className="field-input mono-inline" aria-invalid={!publicHostValid} />
              </div>
              <div className="col-span-4">
                <div className="field-label">Country <span style={{ color: 'var(--text-dim)' }}>(2 letters, optional)</span></div>
                <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="auto (geoip)" className="field-input mono-inline" maxLength={2} aria-invalid={!countryValid} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <div className="field-label">tDVPN / GB</div>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  value={gigabytePrice}
                  onChange={(e) => setGigabytePrice(e.target.value)}
                  className="field-input"
                  aria-invalid={!(Number(gigabytePrice) > 0)}
                />
              </div>
              <div>
                <div className="field-label">tDVPN / hour</div>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  value={hourlyPrice}
                  onChange={(e) => setHourlyPrice(e.target.value)}
                  className="field-input"
                  aria-invalid={!(Number(hourlyPrice) > 0)}
                />
              </div>
              <div>
                <div className="field-label">tDVPN / hour (lease)</div>
                <input
                  type="number"
                  step="0.0001"
                  min="0.000001"
                  value={leasePrice}
                  onChange={(e) => setLeasePrice(e.target.value)}
                  className="field-input"
                />
              </div>
            </div>

            {!pricesValid && (
              <div className="callout callout-warn text-xs flex items-start gap-2 py-1.5">
                <MIcon name="warning" size={14} />
                <span>All three prices must be greater than 0 — the program rejects a zero price.</span>
              </div>
            )}

            {!fundsOk && wallet && (
              <div className="callout callout-warn text-xs flex items-center gap-2 py-1.5">
                <MIcon name="account_balance_wallet" size={14} />
                <span className="flex-1">
                  Your wallet has <b>{fmtDVPN(walletBalance, 4)} tDVPN</b> and <b>{walletSol.toFixed(4)} SOL</b>. A node needs{' '}
                  <b>{DEPLOY_MIN_DVPN} tDVPN</b> (its bond, returned when you remove it) and{' '}
                  <b>{DEPLOY_MIN_SOL} SOL</b> (rent and fees).
                </span>
                <button
                  type="button"
                  onClick={() => navigate({ name: 'wallet' })}
                  className="btn btn-secondary btn-sm flex-shrink-0"
                >
                  Open Wallet
                  <MIcon name="arrow_forward" size={12} />
                </button>
              </div>
            )}
            {atCap && (
              <div className="callout callout-warn py-2">
                <div className="flex items-start gap-2">
                  <MIcon name="info" size={14} style={{ marginTop: 2 }} />
                  <div className="flex-1">
                    <div className="text-xs font-semibold" style={{ color: 'var(--text)' }}>
                      Maximum {MAX_LOCAL_NODES} local nodes reached on this machine.
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      Remove one from the Nodes page before deploying another.
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate({ name: 'nodes' })}
                      className="btn btn-secondary mt-1.5"
                    >
                      Open Nodes
                      <MIcon name="arrow_forward" size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}
            {nearCap && (
              <div className="callout callout-warn py-2">
                <div className="flex items-start gap-2">
                  <MIcon name="info" size={14} style={{ marginTop: 2 }} />
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    You already host {localNodes.length} local node
                    {localNodes.length === 1 ? '' : 's'}. The chain treats nodes on the same
                    public IP as duplicates for directory ranking, and each one shares this
                    machine's CPU, disk, and bandwidth. Max {MAX_LOCAL_NODES} per host.
                  </div>
                </div>
              </div>
            )}

            {report && !report.dockerReachable && (
              <div className="callout callout-warn py-2">
                {report.dockerReason === 'desktop-not-running' ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Docker Desktop isn't running.
                    </span>
                    <button
                      type="button"
                      onClick={startDocker}
                      disabled={
                        dockerStarting || !(report.dockerDesktop?.startable ?? false)
                      }
                      className="btn btn-secondary"
                    >
                      {dockerStarting ? 'Starting…' : 'Start Docker Desktop'}
                      <MIcon
                        name={dockerStarting ? 'hourglass_top' : 'play_arrow'}
                        size={14}
                      />
                    </button>
                  </div>
                ) : report.dockerReason === 'engine-not-running' ? (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Engine not running. Start with{' '}
                    <span className="mono-inline" style={{ color: 'var(--text)' }}>
                      sudo systemctl start docker
                    </span>
                    .
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Install{' '}
                    <a
                      href="https://www.docker.com/products/docker-desktop/"
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      Docker Desktop
                    </a>{' '}
                    or Docker Engine (Linux), then reopen this page.
                  </div>
                )}
              </div>
            )}

            {settings && (
              <div
                className="flex flex-col gap-2 px-3 py-2"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.minimizeToTrayOnClose}
                    onChange={(e) =>
                      void saveSettings({ minimizeToTrayOnClose: e.target.checked })
                    }
                    style={{ marginTop: 2 }}
                  />
                  <div className="flex-1">
                    <div style={{ color: 'var(--text)' }}>Minimize to tray on close</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Closing the window hides it to the tray so the app keeps polling your
                      node.
                    </div>
                  </div>
                </label>
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.stopNodesOnQuit}
                    onChange={(e) =>
                      void saveSettings({ stopNodesOnQuit: e.target.checked })
                    }
                    style={{ marginTop: 2 }}
                  />
                  <div className="flex-1">
                    <div style={{ color: 'var(--text)' }}>Stop running nodes on exit</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Off by default. Your node keeps earning in Docker even after you exit.
                    </div>
                  </div>
                </label>
              </div>
            )}

            <div className="pt-1">
              <button
                onClick={startLocal}
                disabled={!report || starting || !localReady}
                className="btn btn-primary w-full"
              >
                {starting ? 'Starting…' : 'Initialize local node'}
                <MIcon name="arrow_forward" size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4 flex flex-col min-h-0 gap-3">
          <div className="card flex flex-col overflow-hidden">
            <div className="card-header">
              <div className="card-title">Why local?</div>
            </div>
            <div className="card-body flex flex-col gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Bullet>No hosting bill: uses your bandwidth.</Bullet>
              <Bullet>Home labs and residential IPs.</Bullet>
              <Bullet>Machine must stay online to earn.</Bullet>
            </div>
          </div>

          <CurrentRules />

          <OnChainSpecsCard />

          <a
            className="text-xs inline-flex items-center gap-1"
            style={{ color: 'var(--accent)' }}
            href="https://explorer.solana.com/address/J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs?cluster=devnet"
            target="_blank"
            rel="noreferrer"
          >
            dvpn program on Solana Explorer (devnet)
            <MIcon name="open_in_new" size={12} />
          </a>
        </div>
      </div>
    </div>
  );
}

function SystemChecksRow({ report }: { report: LocalSystemReport | null }) {
  const items: { label: string; status: 'ok' | 'warn' | 'err' | 'loading'; detail?: string }[] = [
    {
      label: 'OS',
      status: report ? (report.osCompatible ? 'ok' : 'err') : 'loading',
      detail: report?.osLabel,
    },
    {
      label: 'RAM',
      status: report ? (report.memoryOk ? 'ok' : 'warn') : 'loading',
      detail: report ? `${(report.memoryMb / 1024).toFixed(1)} GB` : undefined,
    },
    {
      label: 'Docker',
      status: report ? (report.dockerReachable ? 'ok' : 'err') : 'loading',
      detail: report
        ? report.dockerReachable
          ? (report.dockerVersion ?? 'ok')
          : 'not reachable'
        : undefined,
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((it) => (
        <CheckCompact key={it.label} {...it} />
      ))}
    </div>
  );
}

function CheckCompact({
  label,
  status,
  detail,
}: {
  label: string;
  status: 'ok' | 'warn' | 'err' | 'loading';
  detail?: string;
}) {
  const dotColor =
    status === 'ok'
      ? 'var(--green)'
      : status === 'warn'
        ? 'var(--yellow, #f5b04a)'
        : status === 'err'
          ? 'var(--red)'
          : 'var(--text-dim)';
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5"
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold" style={{ color: 'var(--text)' }}>
          {label}
        </div>
        <div
          className="text-[10px] truncate"
          style={{ color: 'var(--text-dim)', minHeight: 14 }}
          title={detail}
        >
          {status === 'loading' ? '…' : (detail ?? ' ')}
        </div>
      </div>
    </div>
  );
}

function defaultMoniker(): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `dvpn-${suffix}`;
}

type ProtocolOption = {
  id: VpnServiceType;
  label: string;
  /** Brand logo when the app ships one; otherwise a Material icon. */
  logo?: string;
  icon?: string;
  blurb: string;
};

/** All six protocols the Solana dvpn program advertises (on-chain bitmask). */
export const PROTOCOL_OPTIONS: ProtocolOption[] = [
  { id: 'wireguard', label: 'WireGuard', logo: './brand/protocols/wireguard.svg', blurb: 'Fast, UDP, kernel VPN. The default.' },
  { id: 'amneziawg', label: 'AmneziaWG', logo: './brand/protocols/amneziawg.svg', blurb: 'WireGuard with obfuscated handshakes.' },
  { id: 'v2ray', label: 'V2Ray', logo: './brand/protocols/v2ray.png', blurb: 'TLS proxy over WebSocket / gRPC.' },
  { id: 'xray', label: 'Xray', icon: 'bolt', blurb: 'Faster V2Ray fork (VLESS / VMess).' },
  { id: 'openvpn', label: 'OpenVPN', icon: 'vpn_lock', blurb: 'The classic, works almost everywhere.' },
  { id: 'hysteria2', label: 'Hysteria2', icon: 'speed', blurb: 'QUIC; built for lossy, long links.' },
];

export function ProtocolTiles({
  value,
  onChange,
}: {
  value: VpnServiceType;
  onChange: (next: VpnServiceType) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PROTOCOL_OPTIONS.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            title={opt.blurb}
            className="p-2.5 text-left transition-colors relative"
            style={{
              background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-input)',
              border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            <div className="flex items-center gap-2">
              <div
                className="h-8 w-8 rounded grid place-items-center flex-shrink-0 overflow-hidden"
                style={{ background: opt.logo ? '#ffffff' : 'var(--bg-elev)', border: '1px solid var(--border)' }}
              >
                {opt.logo ? (
                  <img src={opt.logo} alt={`${opt.label} logo`} style={{ width: '22px', height: '22px', objectFit: 'contain' }} draggable={false} />
                ) : (
                  <MIcon name={opt.icon ?? 'shield'} size={18} style={{ color: 'var(--accent)' }} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold flex items-center gap-1.5">
                  {opt.label}
                  {active && <MIcon name="check_circle" size={14} style={{ color: 'var(--accent)' }} />}
                </div>
                <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {opt.blurb}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <MIcon
        name="check_circle"
        size={14}
        style={{ marginTop: 2, color: 'var(--green)' }}
      />
      <span>{children}</span>
    </div>
  );
}

function CurrentRules() {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Current rules</div>
      </div>
      <div
        className="card-body flex flex-col gap-2 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <Bullet>Bond: 1 tDVPN, locked while the node is open; returned 1 hour after you remove it.</Bullet>
        <Bullet>Listing lasts 24 h; the daemon re-lists itself every hour while it runs.</Bullet>
        <Bullet>Five consecutive ports (TCP+UDP) must reach this machine — clients dial them directly, so no CGNAT.</Bullet>
        <Bullet>Prices are three positive numbers in tDVPN (per GB, per hour, lease per hour); the program has no price cap.</Bullet>
        <Bullet>Clients pay with signed vouchers; the node redeems them on chain and takes a 2% protocol fee.</Bullet>
      </div>
    </div>
  );
}

function OnChainSpecsCard() {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">On-chain hardware reporting</div>
      </div>
      <div
        className="card-body flex flex-col gap-2 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <Bullet>
          After deploy, the node key signs an SPL Memo transaction carrying a{' '}
          <code>specs:v1</code> hardware snapshot.
        </Bullet>
        <Bullet>
          The memo carries CPU model, total host cores and RAM, and the cores
          and RAM available to the dvpn-node container (Docker/WSL2 VM).
        </Bullet>
        <Bullet>
          Operator-reported &mdash; not consensus-validated. Surfaced in
          Activity as <em>Specs reporting</em> with the tx hash.
        </Bullet>
      </div>
    </div>
  );
}

