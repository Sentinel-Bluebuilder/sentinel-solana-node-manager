import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { MIcon } from './MIcon';

/**
 * Single global confirm-modal. The app's Zustand store holds at most one
 * `confirmPrompt` at a time; any component can call `confirm({...})` and
 * await the user's answer. Supports:
 *   • yes/no mode
 *   • "type MONIKER to confirm" gate (for destructive actions on nodes)
 */
export function ConfirmModal() {
  const { confirmPrompt, resolveConfirm } = useApp();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    setTyped('');
    const onKey = (e: KeyboardEvent) => {
      if (!confirmPrompt) return;
      if (e.key === 'Escape') resolveConfirm(false);
      // Enter confirms only harmless prompts: a destructive action needs a deliberate click (or the typed phrase).
      if (e.key === 'Enter' && !confirmPrompt.requireType && confirmPrompt.tone !== 'danger') resolveConfirm(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmPrompt, resolveConfirm]);

  if (!confirmPrompt) return null;
  const requireMatch = confirmPrompt.requireType?.trim();
  const canConfirm = !requireMatch || typed.trim() === requireMatch;

  const toneColor =
    confirmPrompt.tone === 'danger'
      ? 'var(--red)'
      : confirmPrompt.tone === 'warning'
        ? 'var(--yellow)'
        : 'var(--accent)';
  const iconName =
    confirmPrompt.tone === 'danger'
      ? 'delete_forever'
      : confirmPrompt.tone === 'warning'
        ? 'warning'
        : 'help';
  const confirmBtnClass =
    confirmPrompt.tone === 'danger'
      ? 'btn btn-danger'
      : confirmPrompt.tone === 'warning'
        ? 'btn btn-secondary'
        : 'btn btn-primary';

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center no-drag"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => e.target === e.currentTarget && resolveConfirm(false)}
    >
      <div
        className="w-[440px] max-w-[90vw] p-6"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-elev)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="h-10 w-10 rounded-lg grid place-items-center flex-shrink-0 mt-0.5"
            style={{
              background: `color-mix(in srgb, ${toneColor} 15%, transparent)`,
              color: toneColor,
            }}
          >
            <MIcon name={iconName} size={22} />
          </div>
          <div className="flex-1 min-w-0 pt-1">
            <div className="text-base font-semibold leading-6" style={{ color: 'var(--text)' }}>
              {confirmPrompt.title}
            </div>
            {confirmPrompt.body && (
              <div className="mt-1.5 text-sm leading-relaxed break-words whitespace-pre-line" style={{ color: 'var(--text-dim)' }}>
                {confirmPrompt.body}
              </div>
            )}
          </div>
        </div>

        {requireMatch && (
          <div className="mt-4">
            <div className="field-label">
              Type{' '}
              <span className="font-mono" style={{ color: 'var(--text)' }}>
                {requireMatch}
              </span>{' '}
              to confirm
            </div>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="field-input font-mono"
            />
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button className="btn btn-secondary" onClick={() => resolveConfirm(false)}>
            {confirmPrompt.cancelLabel ?? 'Cancel'}
          </button>
          <button
            className={confirmBtnClass}
            disabled={!canConfirm}
            onClick={() => resolveConfirm(true)}
          >
            {confirmPrompt.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
