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
  // Empty = each server's own SSH port (from its known host or node record), else 22.
  const [port, setPort] = useState('');
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
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState('');

  // Servers still to do, plus every server already tried in this window: a server that just
  // reconnected stays visible with its result instead of vanishing from the list.
  const list = useMemo(() => {
    const seen = new Set(servers.map((s) => s.host.toLowerCase()));
    const extra = extraHosts.filter((h) => !seen.has(h.toLowerCase())).map((host) => ({ host, port: 22, listedWaiting: 0, discovered: 0, connected: false }));
    return [...servers.filter((s) => !s.connected || rows[s.host] || s.host === initialHost), ...extra];
  }, [servers, extraHosts, rows, initialHost]);

  // What to tick by default: the servers that actually have nodes waiting, not every server this
  // app ever logged in to (those stay in the list, unticked).
  const defaultSelection = (): Set<string> => {
    if (initialHost) return new Set([initialHost]);
    const wanted = list.filter((s) => !s.connected && s.listedWaiting + s.discovered > 0);
    return new Set((wanted.length ? wanted : list.filter((s) => !s.connected)).map((s) => s.host));
  };

  useEffect(() => {
    if (open) {
      setRows({});
      setTouched(false);
      setNotice('');
      setApplyAll(!initialHost);
      return;
    }
    // Closed: drop the secrets, so they are neither kept in memory nor shown again on reopen.
    setPassword('');
    setPrivateKey('');
    setKeyName('');
    setPassphrase('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialHost]);

  // The server list can arrive after the window opened (it loads with the page): select once it is
  // there, until the user picks servers themselves.
  const listKey = list.map((s) => s.host).join('|');
  useEffect(() => {
    if (!open || touched || running) return;
    setSelected(defaultSelection());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listKey, touched]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !running && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  if (!open) return null;

  const toggle = (host: string) => {
    setTouched(true);
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
  const portNum = Number(port);
  const portValid = port === '' || (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535);
  const loginReady = !!username.trim() && portValid && (method === 'password' ? password.length > 0 : privateKey.trim().length > 0);
  const targets = list.filter((s) => selected.has(s.host));
  const tried = Object.values(rows).filter((r) => r.kind === 'done').length;
  // After a run, everything still ticked reconnected (or the user unticked what is left): the main
  // button becomes Done. Before, unticking the failed ones left a disabled "Try again 0 servers".
  const allDone = !running && tried > 0 && targets.every((s) => {
    const r = rows[s.host];
    return r?.kind === 'done' && r.result.outcome === 'reconnected';
  });
  const hint = !username.trim()
    ? 'Enter the server username.'
    : !portValid
      ? 'Port must be a number from 1 to 65535.'
      : method === 'password' && !password
        ? 'Enter the server password.'
        : method === 'key' && !privateKey.trim()
          ? 'Choose your SSH key file.'
          : targets.length === 0
            ? 'Select at least one server.'
            : 'Nothing on the server is changed.';

  const run = async () => {
    if (!loginReady || targets.length === 0 || running) return;
    setTouched(true);
    setNotice('');
    setRunning(true);
    setRows((prev) => {
      const next = { ...prev };
      for (const s of targets) next[s.host] = { kind: 'waiting' };
      return next;
    });
    const failed: string[] = [];
    for (const s of targets) {
      setRows((prev) => ({ ...prev, [s.host]: { kind: 'checking' } }));
      const creds = {
        host: s.host,
        port: port ? portNum : s.port || 22,
        username: username.trim(),
        ...(method === 'password' ? { password } : { privateKey, ...(passphrase ? { passphrase } : {}) }),
      };
      let result: AdoptHostResultView;
      try {
        result = await window.api.nodes.adoptHost(creds, { remember });
      } catch (err) {
        result = { host: s.host, outcome: 'error', message: (err as Error).message, adopted: [], alreadyListed: [], skipped: [] };
      }
      if (result.outcome !== 'reconnected') failed.push(s.host);
      setRows((prev) => ({ ...prev, [s.host]: { kind: 'done', result } }));
    }
    // What is left to do is what failed: "Try again" then retries only those (a server that already
    // reconnected is not logged in to again); with none failed the button becomes Done.
    if (failed.length) setSelected(new Set(failed));
    setRunning(false);
    onFinished();
  };

  const selectFailed = () => {
    setTouched(true);
    setApplyAll(true);
    setSelected(new Set(Object.entries(rows).filter(([, r]) => r.kind === 'done' && r.result.outcome !== 'reconnected').map(([h]) => h)));
  };

  const addHost = () => {
    const h = newHost.trim();
    if (!/^[A-Za-z0-9.\-:]{1,253}$/.test(h) || h.includes('..')) {
      setNotice('That is not a server address. Use an IP address (e.g. 203.0.113.7) or a host name.');
      return;
    }
    setNotice('');
    setTouched(true);
    setExtraHosts((prev) => (prev.some((p) => p.toLowerCase() === h.toLowerCase()) ? prev : [...prev, h]));
    setSelected((prev) => new Set([...(applyAll ? prev : []), h]));
    setNewHost('');
  };

  const readKeyFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 32 * 1024) {
      setNotice(`${file.name} is too large for an SSH key (${Math.round(file.size / 1024)} KB). Choose the private key file, e.g. id_ed25519.`);
      return;
    }
    try {
      const text = await file.text();
      // OpenSSH / PEM keys say PRIVATE KEY; PuTTY keys (.ppk) start with PuTTY-User-Key-File.
      if (!/PRIVATE KEY|PuTTY-User-Key-File/.test(text)) {
        setNotice(`${file.name} does not look like a private key (choose the file without .pub).`);
        return;
      }
      setNotice('');
      setPrivateKey(text);
      setKeyName(file.name);
    } catch (err) {
      setNotice(`Could not read ${file.name}: ${(err as Error).message}`);
    }
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

        {/* Owner review (v0.3.2): on a small window the two panes stack and the dialog body did not scroll, so the
            Reconnect button was cut off. The body scrolls now and the button lives in a footer that is always shown. */}
        <div className="flex flex-1 min-h-0 flex-wrap overflow-y-auto">
          <form
            id="reconnect-servers-form"
            className="flex flex-col gap-3 px-6 py-5"
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
                <input
                  className="input"
                  value={port}
                  placeholder="22"
                  title="Leave empty to use each server's own SSH port (22 if unknown)."
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                  inputMode="numeric"
                />
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
                {targets.length === 0
                  ? 'Use this login for every selected server'
                  : `Use this login for all ${targets.length} selected server${targets.length === 1 ? '' : 's'}`}
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
          </form>

          <div className="flex flex-col min-w-0" style={{ flex: '999 1 420px' }}>
            <div className="flex items-center justify-between gap-2 px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
              <label className="flex items-center gap-2 font-medium text-[13px]" style={{ color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={!applyAll || running}
                  onChange={(e) => {
                    setTouched(true);
                    setSelected(e.target.checked ? new Set(list.map((s) => s.host)) : new Set());
                  }}
                />
                {targets.length} server{targets.length === 1 ? '' : 's'} selected
              </label>
              <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {counts.ok} reconnected · {counts.bad} need attention · {counts.waiting} waiting
              </span>
            </div>
            <ul className="flex-1 min-h-0 overflow-auto m-0 p-0" style={{ listStyle: 'none' }}>
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

        <div className="flex items-center justify-between gap-3 px-6 py-3 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
          <span
            className="text-[12px]"
            role={notice ? 'alert' : undefined}
            style={{ color: notice ? 'var(--warn)' : 'var(--text-dim)', flex: '1 1 220px', minWidth: 0 }}
          >
            {notice ||
              (running
                ? `Checking ${targets.length} server${targets.length === 1 ? '' : 's'}, one at a time…`
                : tried > 0
                  ? `${counts.ok} reconnected${counts.bad ? ` · ${counts.bad} need attention` : ''}.`
                  : hint)}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={running}>
              {tried > 0 ? 'Close' : 'Cancel'}
            </button>
            {allDone ? (
              <button type="button" className="btn btn-primary" onClick={onClose} style={{ height: 40, fontSize: 14, padding: '0 18px' }}>
                <MIcon name="check" size={16} />
                Done
              </button>
            ) : (
              <button
                type="submit"
                form="reconnect-servers-form"
                className="btn btn-primary"
                disabled={!loginReady || targets.length === 0 || running}
                title={!loginReady || targets.length === 0 ? hint : undefined}
                style={{ height: 40, fontSize: 14, padding: '0 18px' }}
              >
                <MIcon name={running ? 'hourglass_top' : 'link'} size={16} />
                {running ? 'Reconnecting…' : `${tried > 0 ? 'Try again' : 'Reconnect'} ${targets.length} server${targets.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
