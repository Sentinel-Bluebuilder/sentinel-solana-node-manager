import { useEffect, useState } from 'react';
import { MIcon } from './MIcon';
import { InfoTip } from './InfoTip';
import { useApp } from '../store/app';

const HELP =
  'Withdrawing a bond, removing a node and getting test escrow back are signed by a small helper that normally runs ' +
  'in Docker on this computer. If this computer has no Docker (or it is stopped), any Linux server you can SSH into ' +
  'can run it instead. The app copies the node key there only for the one command and deletes it right after. ' +
  'The connection is kept in memory only, until the app closes.';

/** Settings → Chain-call server (fix A, 0.3.1). */
export function ChainHostCard() {
  const { pushToast } = useApp();
  const [label, setLabel] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('root');
  const [mode, setMode] = useState<'key' | 'password'>('key');
  const [key, setKey] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.nodes.chainHost().then(setLabel);
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.nodes.setChainHost({
        host: host.trim(),
        port: Number(port) || 22,
        username: user.trim() || 'root',
        privateKey: mode === 'key' ? key : undefined,
        password: mode === 'password' ? password : undefined,
      });
      if (!r.ok) throw new Error(r.error ?? 'The server could not be used.');
      setLabel(r.label);
      setKey('');
      setPassword('');
      pushToast({ title: 'Chain-call server connected', body: `${r.label}. Waiting removals continue now.`, tone: 'success' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    const r = await window.api.nodes.setChainHost(null);
    setLabel(r.label);
  };

  const ready = host.trim().length > 0 && (mode === 'key' ? key.trim().length > 0 : password.length > 0);

  return (
    <div className="card" id="chain-call-server">
      <div className="card-header">
        <div className="card-title flex items-center gap-2">
          Chain-call server <InfoTip text={HELP} label="What is the chain-call server?" />
        </div>
        {label ? <span className="chip chip-ok">Connected</span> : <span className="chip chip-muted">Not set</span>}
      </div>
      <div className="card-body flex flex-col gap-2 text-xs">
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Only needed when this computer has no Docker. Any Linux server with SSH works, for example one of your nodes.
        </p>
        {label ? (
          <div className="flex items-center justify-between gap-2">
            <span className="mono-inline">{label}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => void forget()}>
              Forget
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-12 gap-2">
              <input className="field-input mono-inline col-span-6" placeholder="Server address" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Server address" />
              <input className="field-input mono-inline col-span-2" placeholder="22" value={port} onChange={(e) => setPort(e.target.value)} aria-label="SSH port" />
              <input className="field-input mono-inline col-span-4" placeholder="root" value={user} onChange={(e) => setUser(e.target.value)} aria-label="SSH user" />
            </div>
            <div className="flex gap-2">
              <button className={`btn btn-sm flex-1 ${mode === 'key' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('key')}>
                <MIcon name="key" size={12} /> Key
              </button>
              <button className={`btn btn-sm flex-1 ${mode === 'password' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('password')}>
                <MIcon name="password" size={12} /> Password
              </button>
            </div>
            {mode === 'key' ? (
              <textarea className="field-input mono-inline" rows={3} placeholder="Paste the private key" value={key} onChange={(e) => setKey(e.target.value)} aria-label="SSH private key" />
            ) : (
              <input className="field-input" type="password" placeholder="SSH password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="SSH password" />
            )}
            <button className="btn btn-primary btn-sm" disabled={!ready || busy} onClick={() => void connect()}>
              {busy ? 'Checking the server…' : 'Connect'}
            </button>
          </>
        )}
        {error && (
          <div role="alert" style={{ color: 'var(--red)' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
