import { useState } from 'react';
import { Switch } from './Switch';
import { InfoTip } from './InfoTip';
import { useApp } from '../store/app';
import type { DeployedNode, NodeLiveStatus } from '../../../shared/types';

/** Plain-words explanation shown behind the "?" next to every HNS switch. */
export const HNS_HELP =
  'Handshake (HNS) is a decentralized naming system: domain names that no single company or government controls. ' +
  'Turning this on runs an HNS resolver (hnsd) next to your node, and people connected to your node can then open ' +
  'HNS names. Normal websites (.com, .org, country domains…) keep resolving through 1.1.1.1 as before. ' +
  'Apps that use their own encrypted DNS (DNS over HTTPS) skip it. It downloads about 210 MB once to sync (about a minute and a half), then uses about 10 MB of memory and about 1 MB of traffic an hour. ' +
  'Off by default; you can turn it on or off later on the node’s page.';

/** Deploy-page switch: "HNS Resolver" + the "?" help. */
export function HnsDeploySwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Switch checked={checked} onChange={onChange} label="HNS Resolver" />
      <InfoTip text={HNS_HELP} label="What is the HNS Resolver?" />
    </span>
  );
}

/** What the node's HNS resolver is doing right now, from the record + the last live probe. */
export function hnsState(node: DeployedNode, status: NodeLiveStatus | null): {
  label: string;
  tone: 'ok' | 'warn' | 'err' | 'muted';
} {
  if (!node.handshakeDns) return { label: 'Off', tone: 'muted' };
  if (node.hnsdError) return { label: 'Not running', tone: 'err' };
  // A restart or protocol switch recreates the container: the last probe is stale until it settles.
  if (status?.configChange) return { label: 'Restarting…', tone: 'warn' };
  // 0.3.1 images route users' DNS through the node; older images run hnsd for the node only.
  if (status?.hnsdRunning === true && status.hnsRouting === true) {
    // 0.3.5+: "running" alone doesn't mean HNS names resolve; the chain must be synced.
    const s = status.hnsSync;
    if (s?.state === 'stalled')
      return {
        label:
          s.height === undefined
            ? 'Not syncing · hnsd reached no Handshake peer (allow outbound TCP from the node: peers use 12038, 44806 and other ports)'
            : `Not syncing · no new block for ${Math.floor((s.ageSec ?? 0) / 60)} min (hnsd lost its Handshake peers: allow outbound TCP from the node)`,
        tone: 'err',
      };
    if (s?.state === 'starting') return { label: 'Starting · connecting to Handshake peers', tone: 'warn' };
    if (s?.state === 'syncing') return { label: `Syncing the Handshake chain · ${s.percent ?? 0}%`, tone: 'warn' };
    // NM-C9-4: older image: works, but misses later HNS fixes (Hysteria2 users, sync status).
    if (status.hnsImageOutdated) return { label: 'Routing users’ DNS · Restart to update the node image (HNS fixes)', tone: 'warn' };
    return { label: 'Routing users’ DNS', tone: 'ok' };
  }
  if (status?.hnsdRunning === true) return { label: 'Running · users not routed (Restart to update the node image)', tone: 'warn' };
  if (status?.hnsdRunning === false) return { label: 'Not running', tone: 'err' };
  return { label: 'On', tone: 'warn' }; // enabled, not probed yet (node stopped or first poll)
}

const CHIP: Record<'ok' | 'warn' | 'err' | 'muted', string> = {
  ok: 'chip chip-ok',
  warn: 'chip chip-warn',
  err: 'chip chip-err',
  muted: 'chip chip-muted',
};

/** Small chip for headers: shown only while the resolver is on. */
export function HnsChip({ node, status }: { node: DeployedNode; status: NodeLiveStatus | null }) {
  if (!node.handshakeDns) return null;
  const s = hnsState(node, status);
  return (
    <span className={CHIP[s.tone]} title={`HNS resolver: ${s.label}`} style={{ fontSize: 10, padding: '2px 7px' }}>
      HNS · {s.label}
    </span>
  );
}

/**
 * HNS resolver row for the node page: status + a switch that turns hnsd on or off.
 * The change edits the node config and restarts the daemon, so it asks first.
 */
export function HnsResolverControl({ node, status }: { node: DeployedNode; status: NodeLiveStatus | null }) {
  const { pushToast, refreshNodes, confirm } = useApp();
  const [busy, setBusy] = useState(false);
  const s = hnsState(node, status);
  const enabled = Boolean(node.handshakeDns);
  const blocked = Boolean(node.removalStage);

  const toggle = async (next: boolean) => {
    const ok = await confirm({
      title: next ? 'Turn on the HNS resolver?' : 'Turn off the HNS resolver?',
      body: next
        ? 'The app enables hnsd (Handshake resolver) in this node’s config and restarts the node daemon. Active sessions drop for a few seconds and reconnect.'
        : 'The app disables hnsd in this node’s config and restarts the node daemon. Active sessions drop for a few seconds and reconnect.',
      tone: 'info',
      confirmLabel: next ? 'Turn on' : 'Turn off',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await window.api.nodes.setHandshakeDns({ nodeId: node.id, enabled: next });
      if (!r.ok) throw new Error(r.error);
      pushToast({ title: `HNS resolver ${next ? 'on' : 'off'}`, body: next ? 'hnsd is running in the node container.' : 'hnsd stopped.', tone: 'success' });
    } catch (e) {
      pushToast({ title: 'HNS resolver change failed', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
      await refreshNodes();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Switch
          checked={enabled}
          onChange={(v) => void toggle(v)}
          disabled={busy || blocked}
          label={busy ? 'Applying…' : enabled ? 'On' : 'Off'}
          title={blocked ? 'This node is being removed.' : undefined}
        />
        {enabled && <span className={CHIP[s.tone]} style={{ fontSize: 10, padding: '2px 7px' }}>{s.label}</span>}
        <InfoTip text={HNS_HELP} label="What is the HNS Resolver?" align="left" />
      </div>
      {enabled && node.hnsdError && (
        <div className="text-[11px] whitespace-pre-wrap" style={{ color: 'var(--red)' }} role="alert">
          {node.hnsdError}
        </div>
      )}
    </div>
  );
}
