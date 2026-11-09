import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import { fmtDVPN, relativeTime, shortAddr } from '../lib/format';
import { KIND_ICON, KIND_TONE } from '../lib/events';
import type { AppEvent, EventKind } from '../../../shared/types';

const KIND_GROUPS: { id: string; label: string; kinds: EventKind[] }[] = [
  {
    id: 'deploy',
    label: 'Deployments',
    kinds: ['deploy-started', 'deploy-succeeded', 'deploy-failed'],
  },
  {
    id: 'node',
    label: 'Node lifecycle',
    kinds: [
      'node-started',
      'node-stopped',
      'node-restarted',
      'node-removed',
      'node-online',
      'node-unreachable',
      'node-registered',
      'specs-reported',
      'specs-publish-failed',
    ],
  },
  {
    id: 'wallet',
    label: 'Wallet',
    kinds: ['wallet-created', 'wallet-restored', 'wallet-logout', 'balance-refreshed'],
  },
  {
    id: 'chain',
    label: 'On chain',
    kinds: ['node-repriced', 'node-protocol-changed', 'node-redeemed', 'node-delisted', 'node-closed', 'bond-withdrawn', 'funds-swept'],
  },
  {
    id: 'withdraw',
    label: 'Withdrawals',
    kinds: ['withdraw-sent', 'withdraw-failed'],
  },
  {
    id: 'test',
    label: 'Test sessions',
    kinds: ['node-test-passed', 'node-test-failed'],
  },
];

const KIND_LABEL: Record<EventKind, string> = {
  'wallet-created': 'Wallet created',
  'wallet-restored': 'Wallet restored',
  'wallet-logout': 'Wallet logout',
  'deploy-started': 'Deploy started',
  'deploy-succeeded': 'Deploy succeeded',
  'deploy-failed': 'Deploy failed',
  'node-started': 'Node started',
  'node-stopped': 'Node stopped',
  'node-restarted': 'Node restarted',
  'node-removed': 'Node removed',
  'node-unreachable': 'Node unreachable',
  'node-online': 'Node online',
  'node-registered': 'Node registered',
  'specs-reported': 'Specs reporting',
  'specs-publish-failed': 'Specs publish failed',
  'withdraw-sent': 'Withdraw sent',
  'withdraw-failed': 'Withdraw failed',
  'balance-refreshed': 'Balance refreshed',
  'node-repriced': 'Prices updated',
  'node-protocol-changed': 'Protocol changed',
  'node-redeemed': 'Vouchers redeemed',
  'node-delisted': 'Node delisted',
  'node-closed': 'Node closed (unbonding)',
  'bond-withdrawn': 'Bond returned',
  'funds-swept': 'Node key swept',
  'node-test-passed': 'Test session passed',
  'node-test-failed': 'Test session failed',
};

const TONE_COLOR: Record<'ok' | 'err' | 'warn' | 'accent', string> = {
  ok: 'var(--green)',
  err: 'var(--red)',
  warn: 'var(--yellow)',
  accent: 'var(--accent)',
};

export function Activity() {
  const { nodes, navigate, route } = useApp();
  const initial =
    route.name === 'activity'
      ? { kinds: route.kinds, nodeId: route.nodeId }
      : { kinds: undefined, nodeId: undefined };
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [nodeId, setNodeId] = useState<'all' | string>(initial.nodeId ?? 'all');
  const [enabledKinds, setEnabledKinds] = useState<Set<EventKind>>(
    () =>
      new Set(
        initial.kinds && initial.kinds.length > 0
          ? initial.kinds
          : KIND_GROUPS.flatMap((g) => g.kinds),
      ),
  );

  const firstLoadRef = useRef(true);
  const cancelledRef = useRef(false);
  const load = useCallback(async () => {
    if (firstLoadRef.current) setLoading(true);
    try {
      const next = await window.api.events.list(500);
      if (!cancelledRef.current) setEvents(next);
    } finally {
      if (firstLoadRef.current && !cancelledRef.current) setLoading(false);
      firstLoadRef.current = false;
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void load();
    const off = window.api.events.onChanged(() => void load());
    return () => {
      cancelledRef.current = true;
      off();
    };
  }, [load]);

  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.moniker);
    return m;
  }, [nodes]);

  const allKinds = useMemo(() => KIND_GROUPS.flatMap((g) => g.kinds), []);
  const allOn = enabledKinds.size === allKinds.length;
  const noneOn = enabledKinds.size === 0;

  const toggleKind = (k: EventKind) => {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleGroup = (groupId: string) => {
    const group = KIND_GROUPS.find((g) => g.id === groupId);
    if (!group) return;
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      const allInGroupOn = group.kinds.every((k) => next.has(k));
      if (allInGroupOn) for (const k of group.kinds) next.delete(k);
      else for (const k of group.kinds) next.add(k);
      return next;
    });
  };

  const setAll = (on: boolean) => {
    setEnabledKinds(on ? new Set(allKinds) : new Set());
  };

  const kindCounts = useMemo(() => {
    const m = new Map<EventKind, number>();
    const q = search.trim().toLowerCase();
    for (const e of events) {
      if (nodeId !== 'all' && e.relatedNodeId !== nodeId) continue;
      if (q) {
        const moniker = e.relatedNodeId ? nodeNameById.get(e.relatedNodeId) ?? '' : '';
        const haystack = [
          e.title,
          e.subtitle,
          e.kind,
          KIND_LABEL[e.kind],
          e.txHash ?? '',
          moniker,
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    }
    return m;
  }, [events, search, nodeId, nodeNameById]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (!enabledKinds.has(e.kind)) return false;
      if (nodeId !== 'all' && e.relatedNodeId !== nodeId) return false;
      if (!q) return true;
      const moniker = e.relatedNodeId ? nodeNameById.get(e.relatedNodeId) ?? '' : '';
      const haystack = [
        e.title,
        e.subtitle,
        e.kind,
        KIND_LABEL[e.kind],
        e.txHash ?? '',
        moniker,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [events, search, nodeId, enabledKinds, nodeNameById]);

  const totalShown = filtered.length;
  const totalAll = events.length;

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Activity"
        subtitle="Every wallet, deploy, node, on-chain and test event from this device. Search by node, filter by type."
        right={
          <button className="btn btn-secondary" onClick={() => void load()} disabled={loading}>
            <MIcon name="refresh" size={14} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      />

      <div className="grid grid-cols-12 gap-3" style={{ height: 'calc(100vh - 180px)' }}>
        {/* Filters */}
        <div className="col-span-12 lg:col-span-4 card flex flex-col overflow-hidden">
          <div className="card-header">
            <div className="card-title flex items-center gap-2">
              <MIcon name="filter_alt" size={14} />
              Filters
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
              {totalShown} / {totalAll}
            </div>
          </div>
          <div className="card-body flex flex-col gap-4 overflow-auto flex-1 min-h-0">
            <div>
              <div className="field-label">Search</div>
              <div className="relative">
                <input
                  className="field-input mono-inline pr-7"
                  placeholder="moniker, tx hash, title…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                    style={{ color: 'var(--text-dim)' }}
                    onClick={() => setSearch('')}
                    title="Clear search"
                  >
                    <MIcon name="close" size={14} />
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="field-label">Node</div>
              <select
                className="field-input"
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
              >
                <option value="all">All nodes</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.moniker}
                  </option>
                ))}
              </select>
              <div
                className="text-[10px] mt-1"
                style={{ color: 'var(--text-dim)' }}
              >
                Filters events tagged with a specific node. Wallet-level events
                (created, restored, balance) are not node-scoped.
              </div>
            </div>

            {(() => {
              const hasSpecsEvent = events.some((e) => e.kind === 'specs-reported');
              const publishPending = nodes.some((n) => n.specsPublishPending);
              const onlySpecs =
                enabledKinds.size === 1 && enabledKinds.has('specs-reported');
              const disabled = !hasSpecsEvent;
              const showSpinner = publishPending && !hasSpecsEvent;
              const toggle = () => {
                if (disabled) return;
                if (onlySpecs) setEnabledKinds(new Set(allKinds));
                else setEnabledKinds(new Set(['specs-reported']));
              };
              return (
                <button
                  type="button"
                  onClick={toggle}
                  disabled={disabled}
                  aria-disabled={disabled}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors"
                  style={{
                    background: disabled
                      ? 'var(--bg-input)'
                      : onlySpecs
                        ? 'color-mix(in srgb, var(--accent) 18%, transparent)'
                        : 'color-mix(in srgb, var(--accent) 10%, transparent)',
                    border: disabled
                      ? '1px solid var(--border)'
                      : `1px solid color-mix(in srgb, var(--accent) ${onlySpecs ? 55 : 38}%, transparent)`,
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text)',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.7 : 1,
                  }}
                  title={
                    showSpinner
                      ? 'Broadcasting specs:v1 memo — this toggle will unlock the moment the tx lands.'
                      : disabled
                        ? 'No on-chain specs reporting yet — deploy a node so the app broadcasts a specs:v1 memo, then this toggle unlocks.'
                        : onlySpecs
                          ? 'Click to restore all transaction-type filters'
                          : 'Show only on-chain specs reporting events (specs:v1 memos signed by node keys)'
                  }
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {showSpinner ? (
                      <span
                        aria-hidden
                        className="ring-spin"
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          border: '2px solid var(--border)',
                          borderTopColor: 'var(--accent)',
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <MIcon name={disabled ? 'lock' : 'memory'} size={14} />
                    )}
                    <span className="flex flex-col items-start min-w-0">
                      <span
                        className="text-[11px] uppercase tracking-wider font-semibold"
                        style={{
                          color:
                            showSpinner || !disabled ? 'var(--accent)' : 'var(--text-muted)',
                        }}
                      >
                        View Specs Reporting
                      </span>
                      <span
                        className="text-[11px] leading-snug"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {showSpinner
                          ? 'Posting on-chain…'
                          : disabled
                            ? 'Unlocks after the first specs:v1 broadcast'
                            : 'On-chain specs:v1 memos only'}
                      </span>
                    </span>
                  </span>
                  {showSpinner ? (
                    <span
                      className="text-[10px] uppercase tracking-wider font-semibold flex-shrink-0"
                      style={{ color: 'var(--accent)' }}
                    >
                      Posting
                    </span>
                  ) : disabled ? (
                    <span
                      className="text-[10px] uppercase tracking-wider font-semibold flex-shrink-0"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      Locked
                    </span>
                  ) : (
                    <span
                      className="grid place-items-center flex-shrink-0"
                      aria-hidden
                      style={{
                        width: 30,
                        height: 18,
                        borderRadius: 999,
                        background: onlySpecs ? 'var(--accent)' : 'var(--bg-input)',
                        border: `1px solid ${onlySpecs ? 'var(--accent)' : 'var(--border)'}`,
                        transition: 'background 120ms, border-color 120ms',
                        position: 'relative',
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          top: 1,
                          left: onlySpecs ? 13 : 1,
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          background: onlySpecs ? 'var(--bg)' : 'var(--text-dim)',
                          transition: 'left 120ms',
                        }}
                      />
                    </span>
                  )}
                </button>
              );
            })()}

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div
                  className="text-[11px] uppercase tracking-wider font-semibold"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Transaction types
                </div>
                <div className="flex gap-2 text-[10px] uppercase tracking-wider">
                  <button
                    type="button"
                    onClick={() => setAll(true)}
                    disabled={allOn}
                    style={{
                      color: allOn ? 'var(--text-dim)' : 'var(--accent)',
                      cursor: allOn ? 'default' : 'pointer',
                    }}
                  >
                    All
                  </button>
                  <span style={{ color: 'var(--text-dim)' }}>·</span>
                  <button
                    type="button"
                    onClick={() => setAll(false)}
                    disabled={noneOn}
                    style={{
                      color: noneOn ? 'var(--text-dim)' : 'var(--accent)',
                      cursor: noneOn ? 'default' : 'pointer',
                    }}
                  >
                    None
                  </button>
                </div>
              </div>
              <div
                className="flex flex-col overflow-hidden"
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                {KIND_GROUPS.map((g, gi) => {
                  const allInGroupOn = g.kinds.every((k) => enabledKinds.has(k));
                  const someOn = g.kinds.some((k) => enabledKinds.has(k));
                  return (
                    <div key={g.id}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.id)}
                        className="w-full flex items-center justify-between px-3 py-2 text-left transition-colors"
                        style={{
                          background: 'var(--bg-input)',
                          borderTop: gi === 0 ? 'none' : '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                        title={allInGroupOn ? 'Hide all in group' : 'Show all in group'}
                      >
                        <span
                          className="text-[10px] uppercase tracking-wider font-semibold"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {g.label}
                        </span>
                        <span
                          className="text-[10px]"
                          style={{
                            color: allInGroupOn
                              ? 'var(--text)'
                              : someOn
                                ? 'var(--text-muted)'
                                : 'var(--text-dim)',
                          }}
                        >
                          {g.kinds.filter((k) => enabledKinds.has(k)).length}/
                          {g.kinds.length}
                        </span>
                      </button>
                      {g.kinds.map((k) => {
                        const on = enabledKinds.has(k);
                        const Icon = KIND_ICON[k];
                        const count = kindCounts.get(k) ?? 0;
                        return (
                          <button
                            key={k}
                            type="button"
                            onClick={() => toggleKind(k)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                            style={{
                              borderTop: '1px solid var(--border)',
                              background: 'transparent',
                              cursor: 'pointer',
                            }}
                          >
                            <span
                              className="grid place-items-center flex-shrink-0"
                              style={{
                                height: 14,
                                width: 14,
                                borderRadius: 3,
                                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                                background: on ? 'var(--accent)' : 'transparent',
                                color: 'var(--bg)',
                              }}
                            >
                              {on && <MIcon name="check" size={10} />}
                            </span>
                            <Icon
                              size={13}
                              weight="regular"
                              style={{
                                color: on ? 'var(--text-muted)' : 'var(--text-dim)',
                                flexShrink: 0,
                              }}
                            />
                            <span
                              className="text-xs flex-1 truncate"
                              style={{ color: on ? 'var(--text)' : 'var(--text-muted)' }}
                            >
                              {KIND_LABEL[k]}
                            </span>
                            {count > 0 && (
                              <span
                                className="text-[10px] mono-inline flex-shrink-0"
                                style={{ color: 'var(--text-dim)' }}
                              >
                                {count}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Feed */}
        <div className="col-span-12 lg:col-span-8 card flex flex-col overflow-hidden">
          <div className="card-header">
            <div className="card-title flex items-center gap-2">
              <MIcon name="history" size={14} />
              Feed
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
              {totalShown === 0
                ? 'no matches'
                : `${totalShown} event${totalShown === 1 ? '' : 's'}`}
            </div>
          </div>
          <div className="overflow-auto flex-1 min-h-0">
            {loading && events.length === 0 ? (
              <div className="loading-state">Loading activity…</div>
            ) : totalShown === 0 ? (
              <div className="empty-state" style={{ padding: '56px 16px' }}>
                <MIcon name="inbox" size={28} />
                <div className="font-semibold" style={{ color: 'var(--text)' }}>
                  No matching events
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {totalAll === 0
                    ? 'Deploy a node, sign a withdraw, or refresh your balance to start a trail here.'
                    : 'Adjust the search, node, or transaction-type filters on the left.'}
                </div>
              </div>
            ) : (
              <ul className="flex flex-col">
                {filtered.map((e, idx) => {
                  const Icon = KIND_ICON[e.kind];
                  const tone = KIND_TONE[e.kind];
                  const tint = TONE_COLOR[tone];
                  const moniker = e.relatedNodeId
                    ? nodeNameById.get(e.relatedNodeId)
                    : null;
                  const ts = new Date(e.timestamp);
                  const tsAbs = ts.toLocaleString();
                  return (
                    <li
                      key={e.id}
                      className="flex items-start gap-3 px-4 py-3"
                      style={{
                        borderTop:
                          idx === 0 ? 'none' : '1px solid var(--border)',
                      }}
                    >
                      <div
                        className="h-8 w-8 rounded-md grid place-items-center flex-shrink-0"
                        style={{
                          background: `color-mix(in srgb, ${tint} 15%, transparent)`,
                          color: tint,
                        }}
                      >
                        <Icon size={16} weight="regular" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span
                            className="text-sm font-medium"
                            style={{ color: 'var(--text)' }}
                          >
                            {e.title}
                          </span>
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{
                              background: 'var(--bg-input)',
                              border: '1px solid var(--border)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            {KIND_LABEL[e.kind]}
                          </span>
                        </div>
                        {e.subtitle && (
                          <div
                            className="text-xs mt-0.5"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {e.subtitle}
                          </div>
                        )}
                        <div
                          className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px]"
                          style={{ color: 'var(--text-dim)' }}
                        >
                          <span title={tsAbs}>
                            <MIcon name="schedule" size={11} /> {relativeTime(e.timestamp)}
                          </span>
                          <span className="mono-inline" style={{ color: 'var(--text-muted)' }}>
                            {tsAbs}
                          </span>
                          {moniker && e.relatedNodeId && (
                            <button
                              type="button"
                              onClick={() =>
                                navigate({
                                  name: 'node-details',
                                  id: e.relatedNodeId!,
                                })
                              }
                              style={{ color: 'var(--accent)', cursor: 'pointer' }}
                              title="Open node"
                            >
                              <MIcon name="dns" size={11} /> {moniker}
                            </button>
                          )}
                          {typeof e.amountDVPN === 'number' && (
                            <span
                              className="mono-inline"
                              style={{
                                color:
                                  e.amountDVPN >= 0
                                    ? 'var(--green)'
                                    : 'var(--red)',
                              }}
                            >
                              {e.amountDVPN >= 0 ? '+' : ''}
                              {fmtDVPN(e.amountDVPN)} tDVPN
                            </span>
                          )}
                          {e.txHash && (
                            <>
                              <span
                                className="mono-inline"
                                title={e.txHash}
                                style={{ color: 'var(--text-muted)' }}
                              >
                                tx {shortAddr(e.txHash, 8, 6)}
                              </span>
                              <a
                                href={`https://explorer.solana.com/tx/${e.txHash}?cluster=devnet`}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open on Solana Explorer (devnet)"
                                style={{ color: 'var(--accent)' }}
                              >
                                <MIcon name="open_in_new" size={11} /> View TX
                              </a>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
