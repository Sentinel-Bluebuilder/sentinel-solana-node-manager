import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import type { AppSettings, ChainHealth } from '../../../shared/types';

export function Settings() {
  const {
    settings,
    refreshSettings,
    saveSettings,
    chainHealth,
    refreshChainHealth,
    pushToast,
  } = useApp();
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) void refreshSettings();
    void refreshChainHealth();
  }, [settings, refreshSettings, refreshChainHealth]);

  useEffect(() => {
    const id = setInterval(() => {
      void refreshChainHealth();
    }, 60_000);
    return () => clearInterval(id);
  }, [refreshChainHealth]);

  // Re-sync the draft from saved settings only while nothing is being edited here,
  // so a save from another screen does not throw away unsaved changes.
  useEffect(() => {
    setDraft((d) => (d && settings && JSON.stringify(d) !== JSON.stringify(settings) && dirtyRef.current ? d : settings));
  }, [settings]);
  const dirtyRef = useRef(false);

  if (!draft) {
    return (
      <div className="flex flex-col h-full min-h-0 gap-3">
        <PageHeader title="Settings" />
        <div className="card flex-1 min-h-0">
          <div className="card-body">
            <div className="loading-state">Loading…</div>
          </div>
        </div>
      </div>
    );
  }

  const update = (patch: Partial<AppSettings>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings(draft);
      dirtyRef.current = false;
      pushToast({ title: 'Settings saved', tone: 'success' });
      await refreshChainHealth();
    } catch (err) {
      // The main process refuses a bad value (wrong folder, bad RPC URL) instead of storing it.
      pushToast({ title: 'Settings not saved', body: (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const gasPriceValid = Number.isInteger(Number(draft.priorityFeeMicroLamports)) && Number(draft.priorityFeeMicroLamports) >= 0;
  const trimmedRpc = draft.rpcUrls.map((u) => u.trim()).filter((u) => u.length > 0);
  const rpcInvalid = trimmedRpc.filter((u) => !/^https?:\/\/[^\s]+$/.test(u));
  const rpcAllValid = trimmedRpc.length > 0 && rpcInvalid.length === 0;
  const canSave = dirty && !saving && gasPriceValid && rpcAllValid;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <PageHeader
        title="Settings"
        subtitle="Solana devnet RPC endpoints, transaction fees, the node image source, and application preferences."
        right={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => void refreshChainHealth()}
            >
              <MIcon name="network_check" size={14} />
              Probe RPC pool
            </button>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={!canSave}
              title={
                !gasPriceValid
                  ? 'Priority fee must be a whole number ≥ 0'
                  : !rpcAllValid
                  ? 'Every RPC endpoint must be a valid http(s) URL'
                  : undefined
              }
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </>
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 lg:col-span-8 card flex flex-col">
          <div className="card-header">
            <div className="card-title">Chain</div>
          </div>
          <div className="card-body flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="field-label">Network</div>
                <input className="field-input mono-inline" value="Solana devnet · program J52dyXW3…TBXs" readOnly />
              </div>
              <div>
                <div className="field-label">Node image</div>
                <select
                  className="field-input"
                  value={draft.nodeImageSource}
                  onChange={(e) => update({ nodeImageSource: e.target.value as AppSettings['nodeImageSource'] })}
                >
                  <option value="prebuilt">Download the prebuilt image (recommended)</option>
                  <option value="source">Build from source (developers)</option>
                </select>
                <div className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
                  {draft.nodeImageSource === 'source'
                    ? 'Each host builds the image from the folder below (10–20 min, needs Docker buildx).'
                    : 'Each host downloads the published image once and checks its checksum. No source needed.'}
                </div>
              </div>
              {draft.nodeImageSource === 'source' && (
                <div>
                  <div className="field-label">Source folder (sentinel-solana tree)</div>
                  <input
                    className="field-input mono-inline"
                    value={draft.upstreamDir}
                    onChange={(e) => update({ upstreamDir: e.target.value })}
                  />
                </div>
              )}
              <div>
                <div className="field-label">Priority fee (micro-lamports per compute unit)</div>
                <input
                  className="field-input mono-inline"
                  value={String(draft.priorityFeeMicroLamports)}
                  onChange={(e) => update({ priorityFeeMicroLamports: Number(e.target.value.replace(/[^0-9]/g, '') || 0) })}
                  aria-invalid={!gasPriceValid}
                  style={
                    gasPriceValid
                      ? undefined
                      : { borderColor: 'var(--red)' }
                  }
                />
                <div
                  className="text-[10px] mt-1"
                  style={{ color: gasPriceValid ? 'var(--text-dim)' : 'var(--red)' }}
                >
                  {gasPriceValid
                    ? '0 = no priority fee (devnet default). Each transaction also pays the 5,000-lamport base fee.'
                    : 'Enter a whole number ≥ 0.'}
                </div>
              </div>
            </div>
            <RpcEndpointsTable
              urls={draft.rpcUrls}
              onChange={(rpcUrls) => update({ rpcUrls })}
              chainHealth={chainHealth}
              rpcAllValid={rpcAllValid}
              trimmedCount={trimmedRpc.length}
              invalidUrls={rpcInvalid}
            />

            <div className="flex flex-col">
              <div
                className="text-[11px] uppercase tracking-wider font-semibold mb-2"
                style={{ color: 'var(--text-muted)' }}
              >
                Refresh cadence
              </div>
              <p
                className="text-[11px] mb-3"
                style={{ color: 'var(--text-muted)' }}
              >
                How often the app re-queries the chain in the background. Lower
                values keep the UI fresher but issue more RPC calls — pick longer
                intervals on metered or rate-limited endpoints.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <RefreshIntervalField
                  label="Wallet balance"
                  hint="Re-queries the app wallet's SOL and tDVPN balances and pushes them to every screen. 10–600 seconds."
                  min={10}
                  max={600}
                  step={5}
                  value={draft.walletRefreshIntervalSec}
                  onChange={(v) => update({ walletRefreshIntervalSec: v })}
                />
                <RefreshIntervalField
                  label="Node status"
                  hint="Samples each deployed node (sessions, earnings, reachability). 15–600 seconds."
                  min={15}
                  max={600}
                  step={5}
                  value={draft.nodeRefreshIntervalSec}
                  onChange={(v) => update({ nodeRefreshIntervalSec: v })}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4 flex flex-col gap-3">
          <div className="card">
            <div className="card-header">
              <div className="card-title">Docker</div>
            </div>
            <div className="card-body flex flex-col gap-2">
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Leave blank to auto-detect. Override only when running Colima, Podman, or rootless Docker.
              </p>
              <div>
                <div className="field-label">Socket path</div>
                <input
                  value={draft.dockerSocket}
                  onChange={(e) => update({ dockerSocket: e.target.value })}
                  placeholder="/var/run/docker.sock"
                  className="field-input mono-inline text-xs"
                />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">App</div>
            </div>
            <div className="card-body space-y-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.minimizeToTrayOnClose}
                  onChange={(e) => update({ minimizeToTrayOnClose: e.target.checked })}
                  className="mt-[2px]"
                />
                <span className="text-xs">
                  <span className="block" style={{ color: 'var(--text)' }}>
                    Minimize to tray on close
                  </span>
                  <span className="block" style={{ color: 'var(--text-muted)' }}>
                    Closing the window will hide it to the system tray so the application can
                    continue polling your nodes. Use the tray menu to quit fully.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.stopNodesOnQuit}
                  onChange={(e) => update({ stopNodesOnQuit: e.target.checked })}
                  className="mt-[2px]"
                />
                <span className="text-xs">
                  <span className="block" style={{ color: 'var(--text)' }}>
                    Stop running nodes on exit
                  </span>
                  <span className="block" style={{ color: 'var(--text-muted)' }}>
                    Disabled by default. Nodes continue running in Docker after the application
                    exits, so they keep earning rewards. Enable only when a full shutdown is required.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.stopCliServerOnQuit}
                  onChange={(e) => update({ stopCliServerOnQuit: e.target.checked })}
                  className="mt-[2px]"
                />
                <span className="text-xs">
                  <span className="block" style={{ color: 'var(--text)' }}>
                    Stop the local CLI server on exit
                  </span>
                  <span className="block" style={{ color: 'var(--text-muted)' }}>
                    The CLI server lets PowerShell sessions and AI agents share this app's
                    commands over a local pipe. Disable to leave the listener up across app
                    restarts (only meaningful if the server is started but the app crashes).
                  </span>
                </span>
              </label>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RpcEndpointsTableProps {
  urls: string[];
  onChange: (next: string[]) => void;
  chainHealth: ChainHealth[];
  rpcAllValid: boolean;
  trimmedCount: number;
  invalidUrls: string[];
}

function RpcEndpointsTable({
  urls,
  onChange,
  chainHealth,
  rpcAllValid,
  trimmedCount,
  invalidUrls,
}: RpcEndpointsTableProps) {
  const healthByUrl = new Map(
    chainHealth.map((h) => [h.rpcUrl.trim(), h]),
  );
  const updateUrl = (idx: number, value: string) => {
    const next = [...urls];
    next[idx] = value;
    onChange(next);
  };
  const removeUrl = (idx: number) => {
    if (urls.length <= 1) return;
    const next = urls.filter((_, i) => i !== idx);
    onChange(next);
  };
  const addUrl = () => onChange([...urls, '']);

  return (
    <div className="flex flex-col">
      <div className="field-label">
        RPC endpoints (one per line; requests use the first reachable endpoint)
      </div>
      <div
        className="card flex flex-col overflow-hidden"
        style={{
          border: `1px solid ${rpcAllValid ? 'var(--border)' : 'var(--red)'}`,
        }}
      >
        <div className="card-header flex items-center justify-between py-2">
          <div className="card-title flex items-center gap-2">
            <MIcon name="hub" size={14} />
            Endpoints ({urls.length})
          </div>
          <div
            className="flex items-center gap-3 text-[11px]"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>
              <b style={{ color: 'var(--green)' }}>
                {urls.reduce((n, u) => {
                  const h = healthByUrl.get(u.trim());
                  return n + (h?.reachable ? 1 : 0);
                }, 0)}
              </b>{' '}
              reachable
            </span>
            <span>
              <b style={{ color: 'var(--red)' }}>
                {urls.reduce((n, u) => {
                  const h = healthByUrl.get(u.trim());
                  return n + (h && !h.reachable ? 1 : 0);
                }, 0)}
              </b>{' '}
              down
            </span>
            <span style={{ color: 'var(--text-dim)' }}>
              {urls.reduce((n, u) => {
                const t = u.trim();
                return n + (t && !healthByUrl.has(t) ? 1 : 0);
              }, 0)}{' '}
              unprobed
            </span>
          </div>
        </div>
        <div className="overflow-auto" style={{ maxHeight: 480 }}>
          <div
            className="grid text-[11px] uppercase tracking-wider px-2 py-1.5 sticky top-0 z-10"
            style={{
              gridTemplateColumns:
                '20px minmax(0,1fr) minmax(0,160px) 28px',
              gap: '6px',
              background: 'var(--bg-input)',
              color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div />
            <div className="truncate">RPC URL</div>
            <div className="truncate">Status</div>
            <div />
          </div>
          {urls.map((url, idx) => {
            const trimmed = url.trim();
            const valid = trimmed.length === 0 || /^https?:\/\/[^\s]+$/.test(trimmed);
            const h = healthByUrl.get(trimmed);
            return (
              <div
                key={idx}
                className="grid items-center px-2 py-1.5"
                style={{
                  gridTemplateColumns:
                    '20px minmax(0,1fr) minmax(0,160px) 28px',
                  gap: '6px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span
                  className="h-2 w-2 rounded-full justify-self-center flex-shrink-0"
                  style={{
                    background: !trimmed
                      ? 'var(--text-dim)'
                      : !valid
                        ? 'var(--red)'
                        : h
                          ? h.reachable
                            ? 'var(--green)'
                            : 'var(--red)'
                          : 'var(--text-dim)',
                  }}
                  title={
                    !trimmed
                      ? 'Empty'
                      : !valid
                        ? 'Invalid URL'
                        : h
                          ? h.reachable
                            ? 'Reachable'
                            : `Down: ${h.error ?? 'unknown'}`
                          : 'Unprobed'
                  }
                />
                <input
                  className="field-input mono-inline text-xs"
                  style={{ minWidth: 0 }}
                  value={url}
                  onChange={(e) => updateUrl(idx, e.target.value)}
                  placeholder="https://rpc.example.com:443"
                  aria-invalid={!valid}
                />
                <div
                  className="text-[11px] truncate"
                  title={
                    h?.reachable
                      ? `slot ${h.blockHeight ?? '—'} · ${h.latencyMs}ms`
                      : h?.error ?? ''
                  }
                  style={{
                    color: h?.reachable
                      ? 'var(--text-muted)'
                      : h
                        ? 'var(--red)'
                        : 'var(--text-dim)',
                  }}
                >
                  {!trimmed
                    ? '—'
                    : h?.reachable
                      ? `slot ${h.blockHeight ?? '—'} · ${h.latencyMs}ms`
                      : h
                        ? h.error ?? 'unreachable'
                        : 'not probed yet'}
                </div>
                <button
                  className="btn btn-ghost btn-sm self-center"
                  onClick={() => removeUrl(idx)}
                  disabled={urls.length === 1}
                  title={urls.length === 1 ? 'At least one endpoint required' : 'Remove'}
                  style={{ padding: 2 }}
                >
                  <MIcon name="close" size={14} />
                </button>
              </div>
            );
          })}
          <div className="px-2 py-2 flex justify-center">
            <button
              className="btn btn-secondary btn-sm"
              onClick={addUrl}
              title="Append another RPC endpoint"
            >
              <MIcon name="add" size={14} /> Add RPC endpoint
            </button>
          </div>
        </div>
      </div>
      {!rpcAllValid && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--red)' }}>
          {trimmedCount === 0
            ? 'At least one RPC endpoint is required.'
            : `Invalid URL${invalidUrls.length > 1 ? 's' : ''}: ${invalidUrls
                .slice(0, 3)
                .join(', ')}`}
        </div>
      )}
    </div>
  );
}

function RefreshIntervalField({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  return (
    <div>
      <div className="field-label">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : min}
          onChange={(e) => {
            const raw = Number(e.target.value);
            if (Number.isFinite(raw)) onChange(clamp(raw));
          }}
          className="field-input mono-inline"
          style={{ width: 110 }}
        />
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          seconds
        </span>
      </div>
      <div className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
        {hint}
      </div>
    </div>
  );
}
