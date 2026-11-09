import { useEffect, useMemo, useRef } from 'react';
import { PageHeader } from '../components/PageHeader';
import { ProgressRing } from '../components/ProgressRing';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import type { DeployPhase } from '../../../shared/types';

interface Props {
  jobId: string;
  moniker: string;
  origin?: 'local' | 'ssh';
}

const PHASE_LABEL: Record<DeployPhase, string> = {
  connecting: 'Establishing secure shell',
  preflight: 'Running preflight checks',
  'docker-check': 'Verifying Docker availability',
  'image-build': 'Preparing node image',
  fund: 'Funding the node key (SOL + bond)',
  keygen: 'Initializing the node (dvpnd init)',
  configure: 'Configuring protocols · open_node on chain',
  starting: 'Starting node container',
  verifying: 'Waiting for the node to list itself on chain',
  done: 'Node online',
  error: 'Deployment failed',
  cancelled: 'Deployment cancelled',
};

const PHASE_ORDER: DeployPhase[] = [
  'preflight',
  'connecting',
  'docker-check',
  'image-build',
  'fund',
  'keygen',
  'configure',
  'starting',
  'verifying',
  'done',
];

export function Progress({ jobId, moniker, origin }: Props) {
  const { progress, navigate, setProgress, seedAck, deployLogs, pushToast, requestSeedShow, nodes } =
    useApp();
  const logRef = useRef<HTMLPreElement | null>(null);

  const rawLines = deployLogs[jobId] ?? [];
  const lines = useMemo(() => rawLines, [rawLines]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines.length]);

  const isOurJob = progress && progress.jobId === jobId;
  // The main process keeps a finished job's frame for only 60 s. Without a frame
  // the screen must not look like a deploy that never started: the log tells us
  // whether this job finished, and the node list confirms it.
  const finishedInLog = useMemo(
    () => lines.some((l) => /is listed on Solana devnet/.test(l)),
    [lines],
  );
  const failedInLog = useMemo(
    () => lines.some((l) => /Deployment failed|Deploy cancelled/.test(l)),
    [lines],
  );
  const expired = !isOurJob && lines.length > 0;
  const phase: DeployPhase = isOurJob
    ? progress.phase
    : expired
      ? finishedInLog
        ? 'done'
        : failedInLog
          ? 'error'
          : 'verifying'
      : 'connecting';
  const percent = isOurJob ? progress.percent : phase === 'done' ? 100 : 0;
  const message = isOurJob
    ? progress.message
    : expired && finishedInLog
      ? 'Node is online (this page reconnected after the deploy finished)'
      : PHASE_LABEL[phase];
  const spinning = isOurJob && !['done', 'error', 'cancelled'].includes(phase);
  // A phase may be reported again later (e.g. a preflight line during funding), so
  // the pipeline tracks the furthest step reached and never moves backwards.
  const maxIdxRef = useRef<{ jobId: string; idx: number }>({ jobId, idx: -1 });
  if (maxIdxRef.current.jobId !== jobId) maxIdxRef.current = { jobId, idx: -1 };
  const rawIdx = PHASE_ORDER.indexOf(phase);
  if (phase !== 'error' && phase !== 'cancelled' && rawIdx > maxIdxRef.current.idx) {
    maxIdxRef.current.idx = rawIdx;
  }
  const currentIdx = phase === 'done' ? PHASE_ORDER.length - 1 : maxIdxRef.current.idx;
  const seedPending = phase === 'done' && !!progress?.mnemonicForBackup && !seedAck[jobId];

  const { clearDeployLog } = useApp.getState();

  const onCancel = async () => {
    await window.api.deploy.cancel(jobId);
    setProgress(null);
    clearDeployLog(jobId);
    navigate({ name: 'nodes' });
  };

  const onDone = () => {
    if (seedPending) {
      pushToast({
        title: 'Save your recovery phrase first',
        body: 'Tick the confirmation in the recovery dialog before opening the node.',
        tone: 'warn',
      });
      return;
    }
    setProgress(null);
    clearDeployLog(jobId);
    // The frame may have expired; fall back to the node this page was opened for.
    const id = progress?.nodeId ?? nodes.find((n) => n.moniker === moniker)?.id;
    if (id) navigate({ name: 'node-details', id });
    else navigate({ name: 'nodes' });
  };

  const statusTone =
    phase === 'done'
      ? 'chip-success'
      : phase === 'error'
        ? 'chip-danger'
        : phase === 'cancelled'
          ? 'chip-warn'
          : 'chip-accent';
  const statusLabel =
    phase === 'done'
      ? 'Online'
      : phase === 'error'
        ? 'Failed'
        : phase === 'cancelled'
          ? 'Cancelled'
          : 'In progress';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={
          <>
            Deploy · <span className="mono-inline">{jobId.slice(0, 13)}</span>
          </>
        }
        title={
          phase === 'done'
            ? `${moniker} has been deployed`
            : phase === 'error'
              ? 'Deployment failed'
              : phase === 'cancelled'
                ? 'Deployment cancelled'
                : 'Installing node'
        }
        subtitle={
          phase === 'done'
            ? seedPending
              ? 'Save the recovery phrase below before opening the node.'
              : 'Node is online and reporting on-chain.'
            : `Provisioning ${moniker}`
        }
        right={
          <>
            <span
              className={`chip ${statusTone}`}
              style={{ padding: '6px 12px', fontSize: '12.5px', alignSelf: 'center' }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    phase === 'done'
                      ? 'var(--green)'
                      : phase === 'error'
                        ? 'var(--red)'
                        : phase === 'cancelled'
                          ? 'var(--yellow)'
                          : 'var(--accent)',
                }}
              />
              {statusLabel}
            </span>
            {phase === 'done' ? (
              <>
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    navigate({ name: origin === 'ssh' ? 'deploy-ssh' : 'deploy-local' })
                  }
                  title="Start another deployment"
                >
                  <MIcon name="add" size={14} />
                  Host another node
                </button>
                <button className="btn btn-primary" onClick={onDone}>
                  <MIcon name="arrow_forward" size={14} />
                  Open node
                </button>
              </>
            ) : phase === 'error' || phase === 'cancelled' ? (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setProgress(null);
                  clearDeployLog(jobId);
                  navigate({ name: 'nodes' });
                }}
              >
                <MIcon name="arrow_back" size={14} />
                Back
              </button>
            ) : (
              <>
                <button className="btn btn-secondary" onClick={() => navigate({ name: 'overview' })}>
                  Run in background
                </button>
                <button className="btn btn-danger" onClick={onCancel}>
                  <MIcon name="close" size={14} />
                  Cancel
                </button>
              </>
            )}
          </>
        }
      />

      {seedPending && (
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{
            background: 'color-mix(in srgb, var(--yellow) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--yellow) 38%, transparent)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <MIcon name="key" size={18} />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
              {moniker} has been deployed — save your recovery phrase
            </div>
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              The phrase is shown only once. Store it offline before opening the node.
            </div>
          </div>
          <button
            className="btn btn-primary btn-sm flex-shrink-0"
            onClick={() => requestSeedShow(jobId)}
          >
            <MIcon name="key" size={14} />
            Show recovery phrase
          </button>
        </div>
      )}

      {phase === 'image-build' && (
        <div
          className="flex items-start gap-3 px-4 py-3"
          style={{
            background: 'color-mix(in srgb, var(--accent) 9%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <MIcon name="schedule" size={18} />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
              First build takes 10–15 minutes
            </div>
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Compiling dvpnd, dvpnctl and the protocol binaries from source inside Docker. Subsequent
              deploys reuse the cached image and start in under a minute. Safe
              to leave the screen — progress is preserved.
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-12 gap-4">
        <div className="card col-span-12 lg:col-span-4 flex flex-col">
          <div className="card-body flex flex-col items-center gap-4">
            <ProgressRing
              percent={percent}
              spinning={Boolean(spinning)}
              label={phase === 'done' ? 'Complete' : PHASE_LABEL[phase]}
              sublabel={message !== PHASE_LABEL[phase] ? message : undefined}
            />
          </div>

          <div
            className="px-[22px] py-4"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <div
              className="text-[11px] uppercase tracking-wider mb-3"
              style={{ color: 'var(--text-muted)' }}
            >
              Pipeline
            </div>
            <ol className="flex flex-col gap-2">
              {PHASE_ORDER.slice(0, -1).map((p, idx) => {
                const state =
                  phase === 'error' && idx === currentIdx
                    ? 'error'
                    : idx < currentIdx || phase === 'done'
                      ? 'done'
                      : idx === currentIdx
                        ? 'active'
                        : 'pending';
                const dot =
                  state === 'done'
                    ? 'var(--green)'
                    : state === 'active'
                      ? 'var(--accent)'
                      : state === 'error'
                        ? 'var(--red)'
                        : 'var(--border-strong)';
                const textColor =
                  state === 'pending' ? 'var(--text-dim)' : 'var(--text)';
                return (
                  <li key={p} className="flex items-center gap-3 text-xs">
                    <span
                      className="h-2 w-2 rounded-full flex-shrink-0"
                      style={{
                        background: dot,
                        boxShadow:
                          state === 'active' ? '0 0 0 4px var(--accent-glow)' : 'none',
                      }}
                    />
                    <span style={{ color: textColor }}>{PHASE_LABEL[p]}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        <div className="card col-span-12 lg:col-span-8 flex flex-col min-h-0 overflow-hidden">
          <div className="card-header">
            <div className="card-title flex items-center gap-2">
              <MIcon name="terminal" size={14} />
              Live deploy log
            </div>
            <span className="mono-tag">deploy.log</span>
          </div>
          <div className="p-[22px]" style={{ height: '60vh', minHeight: 320 }}>
            <pre
              ref={logRef}
              className="h-full w-full overflow-auto text-[12px] leading-[1.65] whitespace-pre-wrap"
              style={{
                fontFamily: 'var(--font-mono)',
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-muted)',
                padding: '14px 16px',
              }}
            >
              {lines.length ? lines.join('\n') : '[waiting for output…]'}
            </pre>
          </div>
        </div>
      </div>

    </div>
  );
}
