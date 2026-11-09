import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import type { UpdaterState } from '../../../shared/updater-types';

// ─── Help content ──────────────────────────────────────────────────────────
//
// Sections render in order. Each section gets an entry in the left rail.
// Copy lives here so it stays close to the layout — easier to keep tight,
// human, and consistent than scattering it across components.

type HelpSection = {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  topics: HelpTopic[];
};

type HelpTopic = {
  icon: string;
  title: string;
  body: string;
  bullets?: string[];
};

const SECTIONS: HelpSection[] = [
  {
    id: 'start',
    label: 'Get started',
    icon: 'rocket_launch',
    blurb: 'What you need before your first node goes online on Solana devnet.',
    topics: [
      {
        icon: 'account_balance_wallet',
        title: 'The app wallet',
        body: 'A Solana keypair — a 24-word phrase (Phantom-compatible path) or an imported solana-keygen key file. It funds each node (0.05 SOL for rent and fees + the 1 tDVPN bond) and receives revenue you withdraw. The secret is encrypted with the OS keychain.',
        bullets: ['Needs ≥ 0.06 SOL and ≥ 1 tDVPN per node you deploy', 'tDVPN is a Token-2022 mint on devnet; SOL pays every fee', 'A key-file wallet has no phrase — keep the file safe'],
      },
      {
        icon: 'laptop_mac',
        title: 'Run a node on this machine',
        body: 'Hosting locally is the fastest way to try the network. The deploy preflight checks each requirement for you.',
        bullets: [
          'Docker Desktop running (Windows / macOS) or Docker Engine (Linux)',
          'Five consecutive ports (TCP+UDP) — default 20000–20004 — forwarded to this machine',
          'First deploy builds the node image from source (10–20 min); later deploys reuse it',
        ],
      },
      {
        icon: 'cloud',
        title: 'Deploy to a remote VPS',
        body: 'Point the app at any Ubuntu/Debian box you can SSH into. It installs Docker, builds the node image there, funds and writes the node key, opens the node on chain and starts it — no manual shell work.',
        bullets: [
          'Paste the IP, SSH user, and a key or password; root or passwordless sudo',
          'Open the node\u2019s five ports in the provider firewall — clients dial them directly',
          'SSH credentials are never stored: after an app restart, use Reconnect on the node page',
        ],
      },
      {
        icon: 'price_change',
        title: 'Set your prices',
        body: 'Three prices in tDVPN (per GB, per hour, per lease-hour) are set at deploy and editable from Node Details → Edit pricing. The node restarts and pushes them on chain (update_node). All three must be above 0; there is no cap.',
      },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    icon: 'tune',
    blurb: 'Day-to-day controls for your running nodes.',
    topics: [
      {
        icon: 'swap_horiz',
        title: 'Switch protocol',
        body: 'Each node serves one of six protocols (WireGuard, AmneziaWG, V2Ray, Xray, OpenVPN, Hysteria2). Ports for all six are pinned at deploy, so switching only rewrites the config and restarts; the on-chain protocol bit follows.',
      },
      {
        icon: 'science',
        title: 'Test node',
        body: 'Runs a real paid session from a throwaway client container on the node\u2019s host: your wallet opens a voucher channel (0.2 tDVPN escrow), 1 MB is pulled through the tunnel, the node redeems and the revenue delta is checked on chain. Sweep test channels later returns the unspent escrow.',
      },
      {
        icon: 'account_balance_wallet',
        title: 'Withdraw revenue',
        body: 'Clients pay with signed vouchers; the node redeems them on chain into its revenue (the protocol keeps 2%). Withdraw moves the revenue to the node key (withdraw_node_revenue) and then to your wallet — signed locally from the encrypted backup, no SSH needed.',
      },
      {
        icon: 'campaign',
        title: 'Listing, re-list, redeem, inspect',
        body: 'A listing lasts 24 h and the daemon renews it hourly. Re-list extends it now; Redeem now settles outstanding vouchers; Inspect verifies the node\u2019s signed metadata and TLS pin from this machine the way a client does, and tells you which ports to open if it is unreachable.',
      },
      {
        icon: 'delete',
        title: 'Remove a node',
        body: 'Remove redeems, stops the container, delists and closes the node on chain. The 1 tDVPN bond unbonds for 1 hour; the app then withdraws it and sweeps every lamport and tDVPN on the node key back to your wallet. Each step is saved, so it resumes after a restart.',
      },
      {
        icon: 'memory',
        title: 'On-chain specs',
        body: 'After a deploy the node key signs an SPL Memo (specs:v1) with CPU, cores and RAM. Publish again from the CLI (nodes.publishSpecs --force) if the hardware changes; read it back with nodes.specs.',
      },
    ],
  },
  {
    id: 'security',
    label: 'Keys & security',
    icon: 'shield_lock',
    blurb: 'Where secrets live and how to recover them.',
    topics: [
      {
        icon: 'vpn_key',
        title: 'How keys are stored',
        body: 'The app wallet secret (phrase or key file) is encrypted with the OS keychain (Electron safeStorage → Windows DPAPI / macOS Keychain / libsecret). Each node has its own 24-word key, which is the node\u2019s on-chain owner; it is encrypted the same way and also written into the node home so the daemon can sign.',
      },
      {
        icon: 'visibility',
        title: 'Reveal a node\u2019s recovery phrase',
        body: 'Node Details → Recovery phrase decrypts the node key on demand. Anyone with it controls the node, its bond and its revenue. Copy it to paper, then close the dialog.',
      },
      {
        icon: 'restart_alt',
        title: 'Recover on a new machine',
        body: 'Wallet Setup accepts a 12–24-word phrase or a solana-keygen key file. Node keys live only in this app\u2019s encrypted store: without the store or the node\u2019s phrase, a node cannot be managed or removed from another machine.',
      },
      {
        icon: 'delete_forever',
        title: 'Wipe everything',
        body: 'Remove every node first so bonds and keys are swept back. Then quit the app and delete the sentinel-node-manager-solana folder under your user data directory (%APPDATA% on Windows). Once the encrypted backups are gone, node keys are unrecoverable by design.',
      },
    ],
  },
  {
    id: 'trouble',
    label: 'Troubleshoot',
    icon: 'healing',
    blurb: 'When something looks off.',
    topics: [
      {
        icon: 'cloud_off',
        title: '"Docker not reachable"',
        body: 'The app needs Docker running. On Windows/macOS, open Docker Desktop and wait for it to settle. On Linux, sudo systemctl start docker. The Manage Docker screen can start, quit or force-restart it.',
      },
      {
        icon: 'hourglass_empty',
        title: 'Deploy stuck on a step',
        body: 'The first image build compiles dvpnd, dvpnctl and the protocol binaries (10–20 min). Everything else should land within a few minutes; the Progress screen streams every Docker and chain step. Cancel is safe at any point: funds already sent to the node key are swept back automatically.',
      },
      {
        icon: 'wifi_off',
        title: 'Listed but unreachable',
        body: 'Inspect on the node page dials the node like a client. If it is listed but unreachable, the five ports are blocked between the internet and the node — open them in your router or the provider firewall. The node still earns nothing until clients can reach it.',
      },
      {
        icon: 'link_off',
        title: 'Remote node after an app restart',
        body: 'SSH credentials are kept in memory only. The node page shows a Reconnect prompt; paste the key again (or run nodes.reconnect from the CLI) and any paused removal continues.',
      },
      {
        icon: 'bug_report',
        title: 'Export a diagnostic bundle',
        body: 'Export diagnostics builds a sanitized zip — logs, settings (RPC keys redacted), node list. No wallet secrets, node keys or SSH credentials are included.',
      },
    ],
  },
];

const QUICK_LINKS: { label: string; icon: string; href: string }[] = [
  {
    label: 'dvpn program on Solana Explorer (devnet)',
    icon: 'code',
    href: 'https://explorer.solana.com/address/J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs?cluster=devnet',
  },
  {
    label: 'Sentinel Discord',
    icon: 'forum',
    href: 'https://discord.gg/sentinel',
  },
  {
    label: 'Sentinel docs',
    icon: 'menu_book',
    href: 'https://docs.sentinel.co/',
  },
];

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Ctrl + R', action: 'Refresh balances and node list' },
  { keys: 'Ctrl + ,', action: 'Open Settings' },
  { keys: 'Esc', action: 'Close any open confirmation' },
];

// ─── Screen ────────────────────────────────────────────────────────────────

export function Help() {
  const { pushToast } = useApp();
  const [updater, setUpdater] = useState<UpdaterState>({ stage: 'idle' });
  const [activeId, setActiveId] = useState<string>(SECTIONS[0]!.id);
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    void window.api.updater.status().then(setUpdater);
    const unsub = window.api.updater.onChanged(setUpdater);
    return unsub;
  }, []);

  const exportDiagnostics = async () => {
    const res = await window.api.system.exportDiagnostics();
    if (res.cancelled) return;
    if (res.ok)
      pushToast({ title: 'Diagnostics exported', body: res.path, tone: 'success' });
    else pushToast({ title: 'Export failed', body: res.error, tone: 'error' });
  };

  const checkUpdates = async () => {
    const s = await window.api.updater.check();
    setUpdater(s);
  };

  const installUpdate = async () => {
    const res = await window.api.updater.install();
    if (!res.ok && res.error)
      pushToast({ title: 'Update install failed', body: res.error, tone: 'error' });
  };

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.map((s) => ({
      ...s,
      topics: s.topics.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.body.toLowerCase().includes(q) ||
          (t.bullets ?? []).some((b) => b.toLowerCase().includes(q)),
      ),
    })).filter((s) => s.topics.length > 0);
  }, [query]);

  // Scroll-spy: which section is closest to the top of the viewport.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScroll = () => {
      const top = root.scrollTop + 24;
      let best = SECTIONS[0]!.id;
      for (const s of SECTIONS) {
        const el = sectionRefs.current[s.id];
        if (el && el.offsetTop <= top) best = s.id;
      }
      setActiveId(best);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => root.removeEventListener('scroll', onScroll);
  }, [filteredSections]);

  const jumpTo = (id: string) => {
    const root = scrollRef.current;
    const el = sectionRefs.current[id];
    if (!root || !el) return;
    root.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
  };

  return (
    <div className="flex flex-col gap-3" style={{ height: 'calc(100vh - 96px)' }}>
      <PageHeader
        title="Help"
        subtitle="Guides, shortcuts, and diagnostics for running a Sentinel dVPN node."
        right={
          <>
            <UpdaterBadge state={updater} />
            <button
              className="btn btn-secondary"
              onClick={checkUpdates}
              disabled={updater.stage === 'checking'}
            >
              <MIcon name="refresh" size={14} />
              {updater.stage === 'checking' ? 'Checking…' : 'Check updates'}
            </button>
            {updater.stage === 'ready' && (
              <button className="btn btn-primary" onClick={installUpdate}>
                <MIcon name="download_done" size={14} />
                Install v{updater.version}
              </button>
            )}
            <button className="btn btn-secondary" onClick={exportDiagnostics}>
              <MIcon name="download" size={14} />
              Export diagnostics
            </button>
          </>
        }
      />

      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0">
        {/* Left rail */}
        <aside className="col-span-12 md:col-span-3 lg:col-span-3 flex flex-col gap-3 overflow-auto min-h-0">
          <div className="card">
            <div className="card-body p-2.5 flex flex-col gap-1">
              <div
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-md"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                }}
              >
                <MIcon name="search" size={14} style={{ color: 'var(--text-dim)' }} />
                <input
                  className="bg-transparent outline-none text-xs flex-1 min-w-0"
                  placeholder="Search help…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ color: 'var(--text)' }}
                />
                {query && (
                  <button
                    className="text-[10px] uppercase tracking-wider opacity-60 hover:opacity-100"
                    onClick={() => setQuery('')}
                    style={{ color: 'var(--text-muted)' }}
                  >
                    clear
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-0.5 mt-1">
                {SECTIONS.map((s) => {
                  const active = s.id === activeId && !query;
                  return (
                    <button
                      key={s.id}
                      onClick={() => jumpTo(s.id)}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors"
                      style={{
                        background: active ? 'var(--bg-input)' : 'transparent',
                        color: active ? 'var(--text)' : 'var(--text-muted)',
                        borderLeft: active
                          ? '2px solid var(--accent)'
                          : '2px solid transparent',
                      }}
                    >
                      <MIcon
                        name={s.icon}
                        size={14}
                        style={{
                          color: active ? 'var(--accent)' : 'var(--text-dim)',
                        }}
                      />
                      <span className="text-[13px] font-medium">{s.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header py-2">
              <div className="card-title text-sm flex items-center gap-1.5">
                <MIcon name="link" size={13} style={{ color: 'var(--accent)' }} />
                Quick links
              </div>
            </div>
            <div className="card-body p-2 flex flex-col gap-0.5">
              {QUICK_LINKS.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] transition-colors hover:bg-[var(--bg-input)]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <MIcon name={l.icon} size={13} style={{ color: 'var(--text-dim)' }} />
                  <span className="flex-1">{l.label}</span>
                  <MIcon
                    name="open_in_new"
                    size={11}
                    style={{ color: 'var(--text-dim)' }}
                  />
                </a>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header py-2">
              <div className="card-title text-sm flex items-center gap-1.5">
                <MIcon name="keyboard" size={13} style={{ color: 'var(--accent)' }} />
                Shortcuts
              </div>
            </div>
            <div className="card-body p-2 flex flex-col gap-1">
              {SHORTCUTS.map((s) => (
                <div
                  key={s.keys}
                  className="flex items-center justify-between gap-2 px-1"
                >
                  <span
                    className="text-[12px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {s.action}
                  </span>
                  <Kbd>{s.keys}</Kbd>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Main content */}
        <div
          ref={scrollRef}
          className="col-span-12 md:col-span-9 lg:col-span-9 flex flex-col gap-4 overflow-auto min-h-0"
          style={{ paddingRight: 4 }}
        >
          {filteredSections.length === 0 && (
            <div className="card">
              <div className="card-body p-6 flex flex-col items-center text-center gap-2">
                <MIcon
                  name="search_off"
                  size={28}
                  style={{ color: 'var(--text-dim)' }}
                />
                <div className="text-sm" style={{ color: 'var(--text)' }}>
                  No help topics match "{query}".
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() => setQuery('')}
                >
                  Clear search
                </button>
              </div>
            </div>
          )}

          {filteredSections.map((section) => (
            <section
              key={section.id}
              ref={(el) => {
                sectionRefs.current[section.id] = el;
              }}
              className="flex flex-col gap-2.5"
            >
              <div className="flex items-baseline gap-2">
                <MIcon
                  name={section.icon}
                  size={18}
                  style={{ color: 'var(--accent)' }}
                />
                <h2
                  className="text-[15px] font-semibold tracking-tight"
                  style={{ color: 'var(--text)' }}
                >
                  {section.label}
                </h2>
                <span
                  className="text-[11px]"
                  style={{ color: 'var(--text-dim)' }}
                >
                  {section.blurb}
                </span>
              </div>
              <div className="grid grid-cols-12 gap-3">
                {section.topics.map((topic) => (
                  <TopicCard key={topic.title} topic={topic} />
                ))}
              </div>
            </section>
          ))}

          <div className="text-[10px] text-center pt-2 pb-1" style={{ color: 'var(--text-dim)' }}>
            Need something that's not here? Use the search above, or open an
            issue from the GitHub link in the sidebar.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Atoms ─────────────────────────────────────────────────────────────────

function TopicCard({ topic }: { topic: HelpTopic }) {
  return (
    <div className="card col-span-12 lg:col-span-6">
      <div className="card-body" style={{ padding: '12px 14px' }}>
        <div className="flex items-start gap-2.5">
          <div
            className="flex items-center justify-center rounded-md flex-shrink-0"
            style={{
              width: 28,
              height: 28,
              background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
            }}
          >
            <MIcon name={topic.icon} size={15} style={{ color: 'var(--accent)' }} />
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div
              className="text-[13px] font-semibold leading-tight"
              style={{ color: 'var(--text)' }}
            >
              {topic.title}
            </div>
            <p
              className="text-[12px] leading-snug"
              style={{ color: 'var(--text-muted)' }}
            >
              {topic.body}
            </p>
            {topic.bullets && (
              <ul className="flex flex-col gap-1 mt-1">
                {topic.bullets.map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-1.5 text-[12px] leading-snug"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <MIcon
                      name="check_circle"
                      size={12}
                      style={{
                        color: 'var(--accent)',
                        marginTop: 2,
                        flexShrink: 0,
                      }}
                    />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums"
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        color: 'var(--text-muted)',
        boxShadow: 'inset 0 -1px 0 0 var(--border)',
      }}
    >
      {children}
    </span>
  );
}

function UpdaterBadge({ state }: { state: UpdaterState }) {
  const label =
    state.stage === 'idle'
      ? 'Idle'
      : state.stage === 'checking'
        ? 'Checking…'
        : state.stage === 'downloading'
          ? `Downloading ${state.percent ?? 0}%`
          : state.stage === 'ready'
            ? `v${state.version} ready`
            : state.stage === 'up-to-date'
              ? 'Up to date'
              : state.stage === 'error'
                ? 'Error'
                : state.stage;
  const cls =
    state.stage === 'ready'
      ? 'chip chip-success'
      : state.stage === 'error'
        ? 'chip chip-danger'
        : state.stage === 'downloading' || state.stage === 'checking'
          ? 'chip chip-warn'
          : 'chip';
  return <span className={cls}>{label}</span>;
}
