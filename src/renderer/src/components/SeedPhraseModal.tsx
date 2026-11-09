import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { MIcon } from './MIcon';

/**
 * Global seed-phrase save dialog. Mounted in Layout so it stays visible when
 * the user switches tabs after the deploy finishes. Renders only when:
 *   1. the live deploy frame carries `mnemonicForBackup`,
 *   2. the deploy has reached `phase === 'done'`, and
 *   3. a brief grace window (~3.3 s) has elapsed after 100 % so the user
 *      sees the progress ring complete cleanly before the dialog pops.
 *
 * Once the user ticks "I've stored it" for this jobId the dialog disappears
 * and never re-opens for that deploy.
 */
const POST_DONE_DELAY_MS = 3300;

interface CapturedDeploy {
  jobId: string;
  nodeId?: string;
  mnemonic: string;
}

export function SeedPhraseModal() {
  const {
    progress,
    seedAck,
    acknowledgeSeed,
    pushToast,
    seedShowRequested,
    clearSeedShowRequest,
  } = useApp();
  const [visible, setVisible] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [delayElapsed, setDelayElapsed] = useState(false);
  const [securityInfoOpen, setSecurityInfoOpen] = useState(false);
  // Once a 'done' frame arrives we cache the mnemonic locally so the modal
  // keeps rendering even if `progress` later becomes null (user cancels mid-
  // verify, navigates away, or starts another deploy that clears the frame).
  const [captured, setCaptured] = useState<CapturedDeploy | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDoneFrame =
    !!progress && progress.phase === 'done' && !!progress.mnemonicForBackup;

  useEffect(() => {
    if (!isDoneFrame) return;
    // Already armed for this exact deploy — don't reset the clock.
    if (captured?.jobId === progress!.jobId) return;
    setCaptured({
      jobId: progress!.jobId,
      nodeId: progress!.nodeId,
      mnemonic: progress!.mnemonicForBackup!,
    });
    setDelayElapsed(false);
    setVisible(false);
    setConfirmed(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDelayElapsed(true), POST_DONE_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [isDoneFrame, progress, captured?.jobId]);

  // User clicked "Show recovery phrase" on the Progress banner — bypass the
  // post-done grace delay and pop the modal immediately. We also consume the
  // request flag so the modal won't auto-reopen after they close it.
  useEffect(() => {
    if (!seedShowRequested) return;
    if (!captured || captured.jobId !== seedShowRequested) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDelayElapsed(true);
    clearSeedShowRequest();
  }, [seedShowRequested, captured, clearSeedShowRequest]);

  // If the user has acknowledged the captured deploy, drop our cache so a
  // future deploy starts from a clean slate.
  useEffect(() => {
    if (captured && seedAck[captured.jobId]) {
      setCaptured(null);
      setDelayElapsed(false);
      setVisible(false);
      setConfirmed(false);
    }
  }, [captured, seedAck]);

  if (!captured) return null;
  if (seedAck[captured.jobId]) return null;
  if (!delayElapsed) return null;

  // If a different deploy is now in flight (user kicked off another node
  // before acking this one), don't cover its Progress screen with this
  // modal — the new deploy needs the screen real estate. The captured
  // mnemonic stays in memory; once the new job lands at done we'll show
  // a stack of unsaved phrases on the Progress page itself.
  if (
    progress &&
    progress.jobId !== captured.jobId &&
    progress.phase !== 'done' &&
    progress.phase !== 'error' &&
    progress.phase !== 'cancelled'
  ) {
    return null;
  }

  const mnemonic = captured.mnemonic;

  const onContinue = () => {
    if (!confirmed) {
      pushToast({
        title: 'Record the recovery phrase before continuing',
        body: 'Tick the checkbox once you have it stored offline.',
        tone: 'warn',
      });
      return;
    }
    // Just dismiss the modal — leave the user on whatever screen they're on
    // (typically Progress, where they can choose Open node or Host another).
    acknowledgeSeed(captured.jobId);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(4px)',
        padding: 24,
      }}
    >
      <div
        className="flex flex-col"
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid color-mix(in srgb, var(--yellow) 35%, transparent)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
          width: 'min(640px, 100%)',
          maxHeight: '90vh',
          overflow: 'hidden',
        }}
      >
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div
            className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--green)' }}
          >
            <MIcon name="check_circle" size={14} />
            Deployment complete
          </div>
          <div className="mt-1 text-base font-semibold" style={{ color: 'var(--text)' }}>
            Node deployed — save your recovery phrase
          </div>
          <div className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            The app keeps an encrypted backup of this key on this device (it signs withdrawals and
            removal for you). Save the phrase offline as well: it is the only way to control the node
            and its bond from another machine, or if this device is lost.
          </div>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3 overflow-y-auto" style={{ flex: 1 }}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button className="btn btn-secondary btn-sm" onClick={() => setVisible((v) => !v)}>
              <MIcon name={visible ? 'visibility_off' : 'visibility'} size={12} />
              {visible ? 'Hide' : 'Reveal'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!visible}
              onClick={async () => {
                await navigator.clipboard.writeText(mnemonic);
                pushToast({ title: 'Recovery phrase copied to clipboard', tone: 'success' });
              }}
            >
              <MIcon name="content_copy" size={12} />
              Copy
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={!visible}
              title={!visible ? 'Reveal the phrase first' : 'Save the phrase to a file you choose'}
              onClick={async () => {
                if (!captured.nodeId) return;
                const res = await window.api.nodes.exportMnemonic(captured.nodeId, mnemonic);
                if (res.ok)
                  pushToast({
                    title: 'Recovery phrase exported',
                    body: res.path,
                    tone: 'success',
                  });
                else if (!res.cancelled)
                  pushToast({
                    title: 'Unable to export phrase',
                    body: res.error,
                    tone: 'error',
                  });
              }}
            >
              <MIcon name="save" size={12} />
              Export to file…
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setSecurityInfoOpen((v) => !v)}
              aria-expanded={securityInfoOpen}
              title="How are these keys stored?"
            >
              <MIcon name={securityInfoOpen ? 'expand_less' : 'shield'} size={12} />
              {securityInfoOpen ? 'Hide security info' : 'How are these keys stored?'}
            </button>
          </div>

          {securityInfoOpen && (
            <div
              className="flex flex-col gap-2 px-3 py-3 text-[12px]"
              style={{
                background: 'color-mix(in srgb, var(--accent) 8%, var(--bg-input))',
                border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text)',
                lineHeight: 1.55,
              }}
            >
              <div className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--text)' }}>
                <MIcon name="shield" size={14} />
                Where your keys live
              </div>

              <div>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>Encrypted on this device.</span>{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  The app already stored this key, encrypted with your operating system's keystore —
                  Windows DPAPI, macOS Keychain, or Linux libsecret — through Electron's
                  <span className="mono-inline"> safeStorage</span> API, in its local data folder. Only your
                  OS user account on this machine can decrypt it; it never leaves the device. Node
                  Details → Recovery phrase shows it again whenever you need it.
                </span>
              </div>

              <div>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>Export to file.</span>{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  Writes the recovery phrase to a plain-text <span className="mono-inline">.txt</span>
                  {' '}file at the path you choose, with file permissions <span className="mono-inline">0600</span>
                  {' '}(owner-read-only on macOS/Linux). Anyone who can read that file can control the
                  operator wallet — store it offline (USB, paper, hardware backup) and delete it from
                  online disks once safely archived.
                </span>
              </div>

              <div>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>Reveal / Copy.</span>{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  Shows or copies the phrase to your system clipboard. Clipboards are not secure
                  storage — paste it into your offline backup, then clear the clipboard.
                </span>
              </div>

              <div>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>App wallet vs. node keys.</span>{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  The same protections apply to your app wallet seed
                  (<span className="mono-inline">userData/wallet.secret</span>, also encrypted by safeStorage)
                  and to per-node operator keys you choose to back up
                  (<span className="mono-inline">store.nodeBackups</span> in the same encrypted form).
                  SSH credentials are never persisted to disk.
                </span>
              </div>

              <div style={{ color: 'var(--text-muted)' }}>
                <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>Off-device copy.</span> If this
                computer (or its encrypted app data) is lost, the exported or written-down phrase is the
                only way to reach the node key, its bond and its revenue.
              </div>
            </div>
          )}

          <div
            className="grid"
            style={{
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: 4,
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '10px 12px',
            }}
          >
            {mnemonic
              .trim()
              .split(/\s+/)
              .map((word, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 min-w-0"
                  style={{ padding: '4px 6px' }}
                >
                  <span
                    className="tabular-nums flex-shrink-0"
                    style={{ color: 'var(--text-dim)', fontSize: 10, width: 16 }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    className="truncate"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      color: visible ? 'var(--text)' : 'var(--text-dim)',
                      fontSize: 13,
                      fontWeight: 500,
                      letterSpacing: visible ? 'normal' : '1px',
                    }}
                    title={visible ? word : 'hidden'}
                  >
                    {visible ? word : '••••••'}
                  </span>
                </div>
              ))}
          </div>

        </div>

        <div
          className="px-5 py-4 flex items-center justify-between gap-3 flex-wrap"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <label
            className="flex items-center gap-2 text-[12px] cursor-pointer select-none"
            style={{ color: 'var(--text)' }}
          >
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="h-4 w-4"
            />
            I have securely stored this node's recovery phrase.
          </label>
          <button className="btn btn-primary" disabled={!confirmed} onClick={onContinue}>
            <MIcon name="arrow_forward" size={14} />
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
