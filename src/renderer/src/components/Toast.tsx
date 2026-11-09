import { useEffect, useRef } from 'react';
import { useApp } from '../store/app';
import { MIcon } from './MIcon';

/**
 * Toast stack, rendered as a fixed-position portal in the top-right.
 * Toasts are pushed onto the Zustand store from anywhere in the app via
 * `useApp.getState().pushToast(...)`.
 */
export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  // Each toast gets its own timer once; pushing or dismissing a sibling must not restart the others.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id));
    for (const t of toasts) {
      if (!timers.current.has(t.id)) {
        timers.current.set(t.id, setTimeout(() => dismissToast(t.id), t.durationMs ?? 5000));
      }
    }
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
  }, [toasts, dismissToast]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-[360px]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            'toast no-drag card-elev px-4 py-3 flex items-start gap-3 text-sm',
            t.tone === 'success' && 'border-success/40',
            t.tone === 'error' && 'border-danger/40',
            t.tone === 'warn' && 'border-warning/40',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <MIcon
            name={
              t.tone === 'success'
                ? 'check_circle'
                : t.tone === 'error'
                ? 'error'
                : t.tone === 'warn'
                ? 'warning'
                : 'info'
            }
            size={20}
            className={
              t.tone === 'success'
                ? 'text-success'
                : t.tone === 'error'
                ? 'text-danger'
                : t.tone === 'warn'
                ? 'text-warning'
                : 'text-accent'
            }
          />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-text">{t.title}</div>
            {t.body && <div className="text-text-muted text-xs mt-0.5 break-words">{t.body}</div>}
          </div>
          <button
            onClick={() => dismissToast(t.id)}
            className="text-text-dim hover:text-text"
            aria-label="Dismiss"
          >
            <MIcon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
