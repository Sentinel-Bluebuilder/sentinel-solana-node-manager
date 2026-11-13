import { useEffect, useState } from 'react';
import { MIcon } from './MIcon';
import { ProtocolTiles } from '../screens/DeployLocal';
import { fmtDVPN, shortAddr } from '../lib/format';
import { useApp } from '../store/app';
import type { DeployedNode, NodeLiveStatus, NodeTestResult, VpnServiceType } from '../../../shared/types';

const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

const STAGE_LABEL: Record<string, string> = {
  redeem: 'Redeeming outstanding vouchers',
  stop: 'Stopping the node',
  delist: 'Delisting on chain',
  close: 'Closing the node (bond → unbonding)',
  unbonding: 'Bond unbonding',
  'withdraw-bond': 'Withdrawing the bond',
  sweep: 'Sweeping the node key to your wallet',
  done: 'Removed',
};

/**
 * Solana-specific node controls: chain state, protocol switch, paid self-test,
 * redeem / re-list / inspect, live sessions, and the removal stage machine.
 */
export function SolanaNodePanel({ node, status }: { node: DeployedNode; status: NodeLiveStatus | null }) {
  const { pushToast, refreshNodes, refreshStatus, confirm, navigate } = useApp();
  const [busy, setBusy] = useState<'' | 'test' | 'protocol' | 'redeem' | 'relist' | 'inspect' | 'bond' | 'session' | 'specs'>('');
  const [protocol, setProtocol] = useState<VpnServiceType>(node.serviceType);
  const [test, setTest] = useState<NodeTestResult | null>(null);
  const [inspect, setInspect] = useState<{ reachable: boolean; tlsPinMatches?: boolean; discoverable: boolean; blockedUpstream?: boolean; guidance?: string } | null>(null);
  const [sessions, setSessions] = useState<Array<Record<string, unknown>>>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => setProtocol(node.serviceType), [node.serviceType]);
  const [sshOk, setSshOk] = useState(true);
  const [sshUser, setSshUser] = useState(node.sshUser ?? 'root');
  const [sshPort, setSshPort] = useState(String(node.sshPort ?? 22));
  const [sshKey, setSshKey] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  useEffect(() => {
    if (node.target !== 'remote') return;
    void window.api.nodes.sshConnected(node.id).then(setSshOk).catch(() => setSshOk(false));
  }, [node.id, node.target, busy]);
  const forgetServer = async () => {
    const ok = await confirm({
      title: 'Finish without the server?',
      body: `Use this only if ${node.host ?? 'the server'} no longer exists. The app forgets this node; the firewall rules and node folder it made on that server are not cleaned up.`,
      tone: 'danger',
      confirmLabel: 'Server is gone',
    });
    if (!ok) return;
    const r = await window.api.nodes.forgetServer(node.id);
    if (r.ok) {
      pushToast({ title: 'Node removed', body: 'Server cleanup skipped.', tone: 'success' });
      void refreshNodes();
    } else pushToast({ title: 'Could not finish', body: r.error, tone: 'error' });
  };
  const [retrying, setRetrying] = useState(false);
  const retryRemoval = async () => {
    setRetrying(true);
    try {
      const r = await window.api.nodes.retryRemoval(node.id);
      pushToast(r.ok ? { title: 'Removal step done', body: 'The removal moved on.', tone: 'success' } : { title: 'Still failing', body: r.error, tone: 'error' });
      void refreshNodes();
    } finally {
      setRetrying(false);
    }
  };
  const reconnectCard =
    node.target === 'remote' && !sshOk ? (
      <div className="callout callout-warn text-xs flex flex-col gap-2">
        <div>
          The app restarted, so it no longer holds SSH access to <b>{node.host}</b> (credentials are never stored). Reconnect to
          manage this node{node.removalStage ? ' and let its removal continue' : ''}.
        </div>
        <div className="flex gap-2 flex-wrap">
          <input className="field-input" style={{ maxWidth: 120 }} value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="user" />
          <input className="field-input" style={{ maxWidth: 80 }} value={sshPort} onChange={(e) => setSshPort(e.target.value)} placeholder="22" title="SSH port" />
          <textarea className="field-input mono-inline" rows={2} value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="Paste the private key (PEM) — or use a password" />
          <input className="field-input" type="password" style={{ maxWidth: 160 }} value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} placeholder="password (if no key)" />
          <button
            className="btn btn-primary btn-sm"
            disabled={!sshKey.trim() && !sshPassword}
            onClick={async () => {
              const r = await window.api.nodes.reconnect({
                host: node.host ?? '',
                port: Number(sshPort) || 22,
                username: sshUser,
                privateKey: sshKey.trim() || undefined,
                password: sshPassword || undefined,
              });
              if (r.ok) {
                setSshOk(true);
                setSshKey('');
                setSshPassword('');
                pushToast({ title: 'Reconnected', body: `${r.nodes.length} node(s) on ${node.host}`, tone: 'success' });
              } else pushToast({ title: 'Reconnect failed', body: r.error, tone: 'error' });
            }}
          >
            Reconnect
          </button>
        </div>
        {node.removalStage === 'sweep' && node.pendingHostCleanup ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span>
              Last cleanup attempt failed: {node.pendingHostCleanup.reason}. Deleted that server already? The bond and node key are back in
              your wallet, so the app can finish without it.
            </span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void forgetServer()}
            >
              Server is gone
            </button>
          </div>
        ) : null}
      </div>
    ) : null;
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (node.removalStage || node.status === 'offline') return;
    let alive = true;
    const load = () =>
      window.api.nodes
        .sessions(node.id)
        .then((s) => alive && setSessions(s as Array<Record<string, unknown>>))
        .catch(() => alive && setSessions([]));
    void load();
    const iv = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [node.id, node.removalStage, node.status]);

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(kind);
    try {
      return await fn();
    } catch (e) {
      pushToast({ title: 'Action failed', body: (e as Error).message, tone: 'error' });
      return undefined;
    } finally {
      setBusy('');
      void refreshNodes();
      void refreshStatus(node.id).catch(() => undefined);
    }
  };

  // ── removal in progress ──
  if (node.removalStage) {
    const due = node.unbondsAt ? Date.parse(node.unbondsAt) : 0;
    const left = Math.max(0, due - now);
    const mm = Math.floor(left / 60_000);
    const ss = Math.floor((left % 60_000) / 1000);
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title flex items-center gap-2">
            <MIcon name="hourglass_top" size={14} /> Removing node
          </div>
          <span className="chip chip-warn">{STAGE_LABEL[node.removalStage] ?? node.removalStage}</span>
        </div>
        <div className="card-body flex flex-col gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          {reconnectCard}
          {node.removalError && (
            <div className="flex items-start gap-1" style={{ color: 'var(--red)' }} role="alert">
              <MIcon name="error" size={12} />
              <span>
                Last attempt ({new Date(node.removalError.at).toLocaleTimeString()}) failed: {node.removalError.message} The app
                keeps retrying.
              </span>
            </div>
          )}
          {node.pendingHostCleanup && sshOk && (
            // T1: host cleanup failing with SSH connected used to show only "Working…": no reason, no action.
            <div className="flex flex-col gap-2" role="alert">
              <div style={{ color: 'var(--red)' }}>
                The bond and node key are back in your wallet. Cleaning up {node.host ?? 'the server'} failed: {node.pendingHostCleanup.reason}
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary btn-sm" disabled={retrying} onClick={() => void retryRemoval()}>
                  <MIcon name="refresh" size={12} /> {retrying ? 'Retrying…' : 'Retry cleanup now'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => void forgetServer()}>
                  Server is gone
                </button>
              </div>
            </div>
          )}
          {node.removalError && (
            <div>
              <button className="btn btn-secondary btn-sm" disabled={retrying} onClick={() => void retryRemoval()}>
                <MIcon name="refresh" size={12} /> {retrying ? 'Retrying…' : 'Retry now'}
              </button>
            </div>
          )}
          {node.removalError && /Docker|chain-call server|Chain-call server/i.test(node.removalError.message) && (
            // Never a dead end (T1): the two ways out of "no Docker here" are one click away.
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  void window.api.docker.start().then((r) =>
                    pushToast(
                      r.started
                        ? { title: 'Starting Docker Desktop', body: 'The removal continues once Docker is up (about 30 s).', tone: 'info' }
                        : { title: 'Could not start Docker Desktop', body: r.error ?? 'Start it by hand, or use a server instead.', tone: 'error' },
                    ),
                  )
                }
              >
                <MIcon name="play_arrow" size={12} /> Start Docker Desktop
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'settings' })}>
                <MIcon name="dns" size={12} /> Use a server instead
              </button>
            </div>
          )}
          {node.removalStage === 'unbonding' || node.removalStage === 'withdraw-bond' ? (
            <>
              <div>
                The node is closed on chain. Its 1 tDVPN bond unlocks{' '}
                <b style={{ color: 'var(--text)' }}>{left > 0 ? `in ${mm}m ${String(ss).padStart(2, '0')}s` : 'now'}</b>
                {node.unbondsAt ? ` (${new Date(node.unbondsAt).toLocaleTimeString()})` : ''}. The app withdraws it and
                sweeps the node key back to your wallet automatically; you can also do it now once it unlocks.
              </div>
              <div>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={left > 0 || !!busy}
                  onClick={() =>
                    void run('bond', async () => {
                      const r = await window.api.nodes.withdrawBond(node.id);
                      if (!r.ok) throw new Error(r.error);
                      pushToast({ title: 'Bond withdrawn', body: 'Node key swept to your wallet.', tone: 'success' });
                    })
                  }
                >
                  <MIcon name="savings" size={12} /> {busy === 'bond' ? 'Withdrawing…' : 'Withdraw bond'}
                </button>
              </div>
            </>
          ) : (
            <div>Working through the removal steps. This resumes automatically if the app restarts.</div>
          )}
          {node.unbondingPda && (
            <a href={explorerAddr(node.unbondingPda)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
              Unbonding account {shortAddr(node.unbondingPda, 6, 6)} <MIcon name="open_in_new" size={10} />
            </a>
          )}
        </div>
      </div>
    );
  }

  const expires = status?.listingExpiresAt ? Date.parse(status.listingExpiresAt) : 0;
  const hoursLeft = expires ? Math.max(0, (expires - now) / 3_600_000) : 0;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title flex items-center gap-2">
          <MIcon name="link" size={14} /> On chain (Solana devnet)
        </div>
        <span className={`chip ${status?.chainStatus === 'listed' ? 'chip-success' : 'chip-warn'}`}>
          {status?.chainStatus ?? 'checking…'}
        </span>
      </div>
      <div className="card-body flex flex-col gap-3">
        {reconnectCard}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          <Fact label="Node account">
            {node.nodePda ? (
              <a href={explorerAddr(node.nodePda)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                {shortAddr(node.nodePda, 6, 6)} <MIcon name="open_in_new" size={10} />
              </a>
            ) : (
              '—'
            )}
          </Fact>
          <Fact label="Revenue (unwithdrawn)">{fmtDVPN(status?.revenueDVPN ?? 0, 6)} tDVPN</Fact>
          <Fact label="Listing">{expires ? `${hoursLeft.toFixed(1)} h left` : '—'}{status?.lastStatusAt ? ` · listed ${new Date(status.lastStatusAt).toLocaleTimeString()}` : ''}</Fact>
          <Fact label="Node key SOL">{(node.balanceSOL ?? 0).toFixed(4)} SOL</Fact>
          <Fact label="Protocol fees accrued">{fmtDVPN(status?.feesAccruedDVPN ?? 0, 6)} tDVPN</Fact>
          <Fact label="On-chain URI">{status?.chainUri ?? '—'}</Fact>
          <Fact label="Node id">{node.chainNodeId ? `${node.chainNodeId.slice(0, 10)}…` : '—'}</Fact>
          <Fact label="open_node tx">{node.openTx ? <a href={`https://explorer.solana.com/tx/${node.openTx}?cluster=devnet`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{shortAddr(node.openTx, 6, 6)}</a> : '—'}</Fact>
        </div>

        <div>
          <div className="field-label">Protocol (one per node — switching restarts it and updates the chain)</div>
          <ProtocolTiles value={protocol} onChange={setProtocol} />
          {protocol !== node.serviceType && (
            <div className="flex gap-2 mt-2">
              <button
                className="btn btn-primary btn-sm"
                disabled={!!busy}
                onClick={() =>
                  void run('protocol', async () => {
                    const r = await window.api.nodes.setProtocol({ nodeId: node.id, serviceType: protocol });
                    if (!r.ok) throw new Error(r.error);
                    pushToast({ title: `Now serving ${protocol}`, body: 'On-chain protocol updated.', tone: 'success' });
                  })
                }
              >
                {busy === 'protocol' ? 'Switching…' : `Switch to ${protocol}`}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setProtocol(node.serviceType)} disabled={!!busy}>
                Cancel
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-secondary btn-sm"
            disabled={!!busy}
            title="Pay a real voucher channel from your wallet and pull 1 MB through this node"
            onClick={async () => {
              const ok = await confirm({
                title: 'Run a paid test session?',
                body: 'A throwaway client on the node\u2019s host opens a voucher channel from your app wallet (0.2 tDVPN escrow), pulls 1 MB through the node and the node redeems. The unspent escrow comes back when you sweep test channels (2 h grace).',
                tone: 'info',
                confirmLabel: 'Run test',
              });
              if (!ok) return;
              void run('test', async () => {
                setTest(null);
                const r = await window.api.nodes.test(node.id);
                setTest(r);
                pushToast({
                  title: r.ok ? 'Test session passed' : 'Test session failed',
                  body: r.ok ? `${r.downloadedBytes} B through the tunnel` : r.error?.split('\n')[0],
                  tone: r.ok ? 'success' : 'error',
                });
              });
            }}
          >
            <MIcon name="science" size={12} /> {busy === 'test' ? 'Testing… (≈1 min)' : 'Test node'}
          </button>
          {node.target === 'remote' && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={!!busy}
              title="Pay a voucher channel from your wallet and connect from THIS machine — proves the node is reachable from outside its host"
              onClick={async () => {
                const ok = await confirm({
                  title: 'Run a paid test session from this machine?',
                  body: 'A client container on this computer dials the node\u2019s public address exactly like a real user (0.2 tDVPN escrow from your wallet, refunded when you sweep test channels).',
                  tone: 'info',
                  confirmLabel: 'Run outside test',
                });
                if (!ok) return;
                void run('test', async () => {
                  setTest(null);
                  const r = await window.api.nodes.test(node.id, { clientOn: 'here' });
                  setTest(r);
                  pushToast({
                    title: r.ok ? 'Outside client connected and paid' : r.blockedUpstream ? 'Blocked upstream of the host (nothing spent)' : 'Outside test failed',
                    body: r.ok ? `${r.downloadedBytes} B through the tunnel from this machine` : r.error?.split('\n')[0],
                    tone: r.ok ? 'success' : r.blockedUpstream ? 'warn' : 'error',
                  });
                });
              }}
            >
              <MIcon name="public" size={12} /> {busy === 'test' ? 'Testing…' : 'Test from here'}
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            disabled={!!busy}
            onClick={() =>
              void run('redeem', async () => {
                const r = await window.api.nodes.redeem(node.id);
                if (!r.ok) throw new Error(r.error);
                pushToast({ title: 'Vouchers redeemed', tone: 'success' });
              })
            }
          >
            <MIcon name="payments" size={12} /> {busy === 'redeem' ? 'Redeeming…' : 'Redeem now'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={!!busy}
            onClick={() =>
              void run('relist', async () => {
                const r = await window.api.nodes.relist(node.id);
                if (!r.ok) throw new Error(r.error);
                pushToast({ title: 'Listing extended 24 h', tone: 'success' });
              })
            }
          >
            <MIcon name="campaign" size={12} /> {busy === 'relist' ? 'Re-listing…' : 'Re-list'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={!!busy}
            onClick={() =>
              void run('inspect', async () => {
                const r = await window.api.nodes.inspect(node.id);
                setInspect(r);
              })
            }
          >
            <MIcon name="verified" size={12} /> {busy === 'inspect' ? 'Inspecting…' : 'Inspect'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={!!busy}
            title="Publish a fresh specs:v1 hardware memo signed by the node key"
            onClick={() =>
              void run('specs', async () => {
                const r = await window.api.nodes.publishSpecs(node.id, { force: true });
                if (!r.ok) throw new Error(r.error);
                pushToast({ title: 'Specs published', body: r.txHash, tone: 'success' });
              })
            }
          >
            <MIcon name="memory" size={12} /> {busy === 'specs' ? 'Publishing…' : 'Publish specs'}
          </button>
        </div>

        {inspect && (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Discoverable by clients: <b style={{ color: inspect.discoverable ? 'var(--green)' : 'var(--red)' }}>{inspect.discoverable ? 'yes' : 'no'}</b>
            {' · '}Reachable: <b style={{ color: inspect.reachable ? 'var(--green)' : 'var(--red)' }}>{inspect.reachable ? 'yes' : 'no'}</b>
            {inspect.reachable && (
              <>
                {' · '}TLS pin: <b style={{ color: inspect.tlsPinMatches === false ? 'var(--red)' : 'var(--green)' }}>{inspect.tlsPinMatches === false ? 'MISMATCH' : 'verified'}</b>
              </>
            )}
            {inspect.guidance && <div className="mt-1" style={{ color: inspect.blockedUpstream ? 'var(--yellow)' : 'var(--red)' }}>{inspect.blockedUpstream ? 'Blocked upstream (not the node): ' : ''}{inspect.guidance}</div>}
          </div>
        )}

        {test && (
          <div
            className="text-[11px] px-3 py-2 mono-inline"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', maxHeight: 160, overflowY: 'auto' }}
          >
            {test.steps.map((s, i) => (
              <div key={i}>{s}</div>
            ))}
          </div>
        )}

        <div>
          <div className="field-label">Live sessions ({sessions.length})</div>
          {sessions.length === 0 ? (
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
              No sessions right now.
            </div>
          ) : (
            sessions.slice(0, 20).map((s) => {
              const sid = String(s.id ?? '');
              return (
                <div key={sid} className="flex items-center justify-between text-xs py-1">
                  <span className="mono-inline">{shortAddr(sid, 8, 4)}</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!!busy}
                    title="Close this session (also frees a stuck peer slot)"
                    onClick={() =>
                      void run('session', async () => {
                        const r = await window.api.nodes.closeSession(node.id, sid);
                        if (!r.ok) throw new Error(r.error);
                        setSessions((prev) => prev.filter((x) => String(x.id) !== sid));
                      })
                    }
                  >
                    Close
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-2.5 py-2" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
        {label}
      </div>
      <div className="mt-0.5" style={{ color: 'var(--text)' }}>
        {children}
      </div>
    </div>
  );
}
