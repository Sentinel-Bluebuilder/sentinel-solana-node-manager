import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { MIcon } from './MIcon';
import type { AdoptHostResultView, RecoveryServerView } from '../../../shared/types';

/**
 * NM032 "Reconnect servers" (design: claude.ai/artifact/7UDp99AbBmwxeJ4VZyVPq6, screen 2).
 * One login, tried on every selected server in turn. Each server shows its own result; servers
 * with a different login show "Wrong login" and can be retried on their own. Nothing on a server
 * is changed: the app reads the node key and settings there and rebuilds its list.
 */

type RowState = { kind: 'waiting' } | { kind: 'checking' } | { kind: 'done'; result: AdoptHostResultView };

const OUTCOME_LABEL: Record<AdoptHostResultView['outcome'], { label: string; chip: string }> = {
  reconnected: { label: 'Reconnected', chip: 'chip-success' },
  'wrong-login': { label: 'Wrong login', chip: 'chip-danger' },
  'not-answering': { label: 'Not answering', chip: 'chip-warn' },
  'host-key-changed': { label: 'Server key changed', chip: 'chip-danger' },
  'no-node-found': { label: 'No node found', chip: 'chip-muted' },
  error: { label: 'Failed', chip: 'chip-danger' },
};

export function ReconnectServersModal({
  open,
  servers,
  initialHost,
  onClose,
  onFinished,
}: {
  open: boolean;
  servers: RecoveryServerView[];
  initialHost?: string;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState('22');
  const [method, setMethod] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyName, setKeyName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [applyAll, setApplyAll] = useState(true);
  const [remember, setRemember] = useState(true);
  const [extraHosts, setExtraHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);

  const list = useMemo(() => {
    const seen = new Set(servers.map((s) => s.host.toLowerCase()));
    const extra = extraHosts.filter((h) => !seen.has(h.toLowerCase())).map((host) => ({ host, port: 22, listedWaiting: 0, discovered: 0, connected: false }));
    return [...servers.filter((s) => !s.connected), ...extra];
  }, [servers, extraHosts]);

  useEffect(() => {
    if (!open) return;
    setRows({});
    setSelected(new Set(initialHost ? [initialHost] : list.map((s) => s.host)));
    setApplyAll(!initialHost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialHost]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !running && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  if (!open) return null;

  const toggle = (host: string) => {
    setSelected((prev) => {
      if (!applyAll) return new Set([host]);
      const next = new Set(prev);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });
  };
  const allSelected = list.length > 0 && list.every((s) => selected.has(s.host));
  const counts = Object.values(rows).reduce(
    (acc, r) => {
      if (r.kind === 'done') acc[r.result.outcome === 'reconnected' ? 'ok' : 'bad'] += 1;
      else if (r.kind === 'waiting') acc.waiting += 1;
      return acc;
    },
    { ok: 0, bad: 0, waiting: 0 },
  );
  const loginReady = username.trim() && (method === 'password' ? password.length > 0 : privateKey.trim().length > 0);
  const targets = list.filter((s) => selected.has(s.host));

  const run = async () => {
    if (!loginReady || targets.length === 0) return;
    setRunning(true);
    setRows((prev) => {
      const next = { ...prev };
      for (const s of targets) next[s.host] = { kind: 'waiting' };
      return next;
    });
    for (const s of targets) {
      setRows((prev) => ({ ...prev, [s.host]: { kind: 'checking' } }));
      const creds = {
        host: s.host,
        port: Number(port) || s.port || 22,
        username: username.trim(),
        ...(method === 'password' ? { password } : { privateKey, ...(passphrase ? { passphrase } : {}) }),
      };
      let result: AdoptHostResultView;
      try {
        result = await window.api.nodes.adoptHost(creds, { remember });
      } catch (err) {
        result = { host: s.host, outcome: 'error', message: (err as Error).message, adopted: [], alreadyListed: [], skipped: [] };
      }
      setRows((prev) => ({ ...prev, [s.host]: { kind: 'done', result } }));
    }
    setRunning(false);
    onFinished();
  };

  const selectFailed = () => {
    setApplyAll(true);
    setSelected(new Set(Object.entries(rows).filter(([, r]) => r.kind === 'done' && r.result.outcome !== 'reconnected').map(([h]) => h)));
  };

  const addHost = () => {
    const h = newHost.trim();
    if (!/^[A-Za-z0-9.\-:]{1,253}$/.test(h)) return;
    setExtraHosts((prev) => (prev.includes(h) ? prev : [...prev, h]));
    setSelected((prev) => new Set([...(applyAll ? prev : []), h]));
    setNewHost('');
  };

  const readKeyFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 32 * 1024) return;
    setPrivateKey(await file.text());
    setKeyName(file.name);
  };

  // A portal: the page wrapper animates with a transform, which would make this fixed overlay
  // position itself inside the page instead of the window (cut off on the right at 1024 px).
  return createPortal(
    <div
      className="fixed inset-0 z-40 grid place-items-center no-drag"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div
        role="dialog"
        aria-label="Reconnect servers"
        className="flex flex-col w-[900px] max-w-[94vw] h-[640px] max-h-[90vh]"
        style={{ background: 'var(--bg-card-solid)', border: '1px solid var(--border-hover)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-elev)' }}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <div className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Reconnect servers</div>
            <div className="text-[13px] mt-1" style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
              Enter the login you use for your servers. The app checks each one, finds the nodes already running there and gives you full
              control again. Nothing on the server is changed.
            </div>
          </div>
          <button className="btn btn-ghost" aria-label="Close" onClick={onClose} disabled={running}>
            <MIcon name="close" size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 flex-wrap">
          <form
            className="flex flex-col gap-3 px-6 py-5 overflow-auto"
            style={{ flex: '1 1 300px', maxWidth: 340, borderRight: '1px solid var(--border)' }}
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 flex-1">
                <span className="field-label">Username</span>
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
              </label>
              <label className="flex flex-col gap-1" style={{ width: 80 }}>
                <span className="field-label">Port</span>
                <input className="input" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" />
              </label>
            </div>
            <div className="flex flex-col gap-1">
              <span className="field-label">Sign in with</span>
              <div className="flex gap-1 p-1" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                {(['password', 'key'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={method === m ? 'btn btn-primary flex-1' : 'btn btn-ghost flex-1'}
                    onClick={() => setMethod(m)}
                  >
                    {m === 'password' ? 'Password' : 'SSH key file'}
                  </button>
                ))}
              </div>
            </div>
            {method === 'password' ? (
              <label className="flex flex-col gap-1">
                <span className="field-label">Password</span>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="field-label">Key file</span>
                  <input className="input" type="file" onChange={(e) => void readKeyFile(e.target.files?.[0])} />
                  {keyName ? <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{keyName} loaded</span> : null}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="field-label">Key passphrase (if any)</span>
                  <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                </label>
              </>
            )}
            <label className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--text)', lineHeight: 1.4 }}>
              <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} className="mt-0.5" />
              <span>
                Use this login for all {selected.size} selected server{selected.size === 1 ? '' : 's'}
                <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  Servers with a different login show "Wrong login": select just those and try again.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--text)', lineHeight: 1.4 }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5" />
              <span>
                Remember logins on this computer
                <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  Encrypted by your operating system. You won't be asked again after a restart.
                </span>
              </span>
            </label>
            <div className="flex-1" />
            <button type="submit" className="btn btn-primary" disabled={!loginReady || targets.length === 0 || running} style={{ height: 42, fontSize: 14 }}>
              <MIcon name={running ? 'hourglass_top' : 'link'} size={16} />
              {running ? 'Reconnecting…' : `Reconnect ${targets.length} server${targets.length === 1 ? '' : 's'}`}
            </button>
          </form>

          <div className="flex flex-col min-w-0" style={{ flex: '999 1 420px' }}>
            <div className="flex items-center justify-between gap-2 px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
              <label className="flex items-center gap-2 font-medium text-[13px]" style={{ color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={!applyAll}
                  onChange={(e) => setSelected(e.target.checked ? new Set(list.map((s) => s.host)) : new Set())}
                />
                {selected.size} server{selected.size === 1 ? '' : 's'} selected
              </label>
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {counts.ok} reconnected · {counts.bad} need attention · {counts.waiting} waiting
              </span>
            </div>
            <ul className="flex-1 overflow-auto m-0 p-0" style={{ listStyle: 'none' }}>
              {list.length === 0 ? (
                <li className="px-5 py-6 text-[13px]" style={{ color: 'var(--text-dim)' }}>
                  No servers known yet. Add your server's address below.
                </li>
              ) : null}
              {list.map((s) => {
                const r = rows[s.host];
                const done = r?.kind === 'done' ? r.result : null;
                const chip = done ? OUTCOME_LABEL[done.outcome] : r?.kind === 'checking' ? { label: 'Checking…', chip: 'chip-accent' } : r?.kind === 'waiting' ? { label: 'Waiting', chip: 'chip-muted' } : null;
                return (
                  <li key={s.host} className="flex items-center gap-3 px-5 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
                    <input type="checkbox" checked={selected.has(s.host)} onChange={() => toggle(s.host)} aria-label={`Select ${s.host}`} disabled={running} />
                    <div className="flex-1 min-w-0">
                      <div className="mono-inline text-[12px]" style={{ color: 'var(--text)' }}>{s.host}</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                        {done
                          ? done.message
                          : s.discovered + s.listedWaiting > 0
                            ? `${s.discovered + s.listedWaiting} node${s.discovered + s.listedWaiting === 1 ? '' : 's'} expected`
                            : 'Server used before'}
                        {done?.saveError ? ` · login not saved: ${done.saveError}` : ''}
                      </div>
                    </div>
                    {chip ? <span className={`chip ${chip.chip}`}>{chip.label}</span> : null}
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center gap-2 px-5 py-3 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
              <input
                className="input"
                style={{ flex: '1 1 160px' }}
                placeholder="Add a server address (e.g. 203.0.113.7)"
                value={newHost}
                onChange={(e) => setNewHost(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addHost())}
                disabled={running}
              />
              <button type="button" className="btn btn-secondary" onClick={addHost} disabled={running || !newHost.trim()}>
                <MIcon name="add" size={14} />
                Add
              </button>
              {counts.bad > 0 && !running ? (
                <button type="button" className="btn btn-secondary" onClick={selectFailed}>
                  <MIcon name="replay" size={14} />
                  Select the ones that failed
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
