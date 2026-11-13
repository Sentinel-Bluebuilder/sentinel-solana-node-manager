import { useCallback, useEffect, useState } from 'react';
import { MIcon } from './MIcon';
import { InfoTip } from './InfoTip';
import { useApp } from '../store/app';

type Status = Awaited<ReturnType<typeof window.api.nodes.testEscrow>>;

const HELP =
  '"Test node" pays a small escrow into a session channel. After the test the app closes that channel: the node gets ' +
  '2 hours to collect what it earned, then the rest comes back to this wallet. The app does this by itself every few ' +
  'minutes; the button only does it now.';

/** Wallet → Test escrow (fix B, 0.3.1). Hidden when no test escrow is out. */
export function TestEscrowCard() {
  const { pushToast } = useApp();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void window.api.nodes.testEscrow().then(setSt, (err: unknown) => console.warn('test escrow status failed', err));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!st || (st.channels === 0 && !st.refundPending && !st.lastError)) return null;

  const reclaim = async () => {
    setBusy(true);
    try {
      const r = await window.api.nodes.reclaimTestEscrow();
      if (!r) pushToast({ title: 'Nothing to do yet', body: 'The closing channels are still in their 2-hour grace period.', tone: 'info' });
      else if (r.errors.length) pushToast({ title: 'Reclaim partly failed', body: r.errors[0].slice(0, 200), tone: 'error' });
      else pushToast({ title: 'Test escrow', body: `${r.startedClose.length} closing · ${r.closed.length} closed · ${r.withdrawnBase} base units back`, tone: 'success' });
    } catch (e) {
      pushToast({ title: 'Reclaim failed', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
      load();
    }
  };

  const waitText = st.nextMaturesAt
    ? Date.parse(st.nextMaturesAt) > Date.now()
      ? `next one comes back after ${new Date(st.nextMaturesAt).toLocaleTimeString()}`
      : 'ready to come back now'
    : st.open
      ? 'closing starts now'
      : '';

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title flex items-center gap-2">
          <MIcon name="savings" size={14} /> Test escrow <InfoTip text={HELP} label="What is test escrow?" />
        </div>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void reclaim()}>
          {busy ? 'Working…' : 'Reclaim test escrow'}
        </button>
      </div>
      <div className="card-body text-xs flex flex-col gap-1">
        <div>
          {st.channels} test channel{st.channels === 1 ? '' : 's'} out{waitText ? ` · ${waitText}` : ''}
          {st.refundPending ? ' · refund to this wallet pending' : ''}
        </div>
        {st.lastError && (
          <div role="alert" style={{ color: 'var(--red)' }}>
            Last try ({new Date(st.lastError.at).toLocaleTimeString()}) failed: {st.lastError.message}
          </div>
        )}
      </div>
    </div>
  );
}
