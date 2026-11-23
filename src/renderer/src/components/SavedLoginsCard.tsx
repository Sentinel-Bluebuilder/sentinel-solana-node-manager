import { useEffect, useState } from 'react';
import { MIcon } from './MIcon';
import { useApp } from '../store/app';

type SavedLogin = Awaited<ReturnType<typeof window.api.nodes.savedLogins>>[number];

/**
 * NM032 Settings → "Saved server logins": logins kept by the "Remember logins" tick box in the
 * Reconnect window, encrypted by the OS keychain. Shows host, user and method only, never the secret.
 */
export function SavedLoginsCard() {
  const { pushToast } = useApp();
  const [logins, setLogins] = useState<SavedLogin[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      setLogins(await window.api.nodes.savedLogins());
    } catch (err) {
      console.warn('saved logins unavailable', err);
      setLogins([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const forget = async (l: SavedLogin) => {
    const k = `${l.host}:${l.port}`;
    setBusy(k);
    try {
      await window.api.nodes.forgetLogin(l.host, l.port);
      pushToast({ tone: 'success', title: `Login for ${l.host} forgotten`, body: 'Its nodes stay listed; reconnect the server to control them again.' });
      await load();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Could not forget the login', body: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Saved server logins</div>
      </div>
      <div className="card-body flex flex-col gap-2">
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Logins you chose to remember in Reconnect servers. Encrypted by your operating system and used after a restart so you
          are not asked again.
        </p>
        {logins === null ? null : logins.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-dim)' }}>No saved logins.</div>
        ) : (
          <ul className="flex flex-col gap-1 m-0 p-0" style={{ listStyle: 'none' }}>
            {logins.map((l) => {
              const k = `${l.host}:${l.port}`;
              return (
                <li key={k} className="flex items-center gap-2">
                  <MIcon name={l.method === 'key' ? 'key' : 'password'} size={14} />
                  <span className="mono-inline text-xs flex-1 truncate" style={{ color: 'var(--text)' }} title={k}>
                    {l.username}@{l.host}
                    {l.port !== 22 ? `:${l.port}` : ''}
                  </span>
                  <button className="btn btn-ghost" style={{ height: 24, padding: '0 8px', fontSize: 11 }} disabled={busy === k} onClick={() => void forget(l)}>
                    Forget
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
