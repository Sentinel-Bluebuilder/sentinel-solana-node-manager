import { useEffect, useId, useRef, useState } from 'react';
import { MIcon } from './MIcon';

// ─── Recover nodes explainer ───
// The "?" beside the Recover nodes button. Opens on hover, keyboard focus or click (click pins it
// open until a click outside or Escape), so it works with a mouse, a keyboard and a touch screen.

const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: 'manage_search',
    title: 'Scan your wallet',
    body: 'Reads your wallet’s history on Solana for every node it funded. Nothing is sent and nothing costs a fee.',
  },
  {
    icon: 'visibility',
    title: 'See them, view only',
    body: 'Each node it finds comes back with its prices and status from the chain, even if this list was lost.',
  },
  {
    icon: 'dns',
    title: 'Reconnect servers',
    body: 'One login for all your servers gives you full control again: restart, prices, withdraw, remove.',
  },
];

export function RecoverNodesHelp({ align = 'right' }: { align?: 'left' | 'right' | 'center' }) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  return (
    <span ref={root} className={`recover-help recover-help-${align}${pinned ? ' is-open' : ''}`}>
      <button
        type="button"
        className="recover-help-badge"
        aria-label="How does Recover nodes work?"
        aria-describedby={id}
        aria-expanded={pinned}
        onClick={() => setPinned((v) => !v)}
      >
        ?
      </button>
      <span role="tooltip" id={id} className="recover-help-card">
        <span className="recover-help-head">
          <span className="recover-help-icon">
            <MIcon name="restore" size={16} />
          </span>
          <span>
            <span className="recover-help-title">Recover nodes</span>
            <span className="recover-help-sub">Lost your node list? Your wallet still knows them.</span>
          </span>
        </span>
        <span className="recover-help-steps">
          {STEPS.map((s, i) => (
            <span key={s.title} className="recover-help-step">
              <span className="recover-help-num">{i + 1}</span>
              <span>
                <span className="recover-help-step-title">
                  <MIcon name={s.icon} size={13} /> {s.title}
                </span>
                <span className="recover-help-step-body">{s.body}</span>
              </span>
            </span>
          ))}
        </span>
        <span className="recover-help-foot">
          <MIcon name="verified_user" size={13} />
          Safe to run any time: it never changes or removes a node, and skips the ones already here.
        </span>
      </span>
    </span>
  );
}
