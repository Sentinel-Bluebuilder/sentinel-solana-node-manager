import { useId } from 'react';

/**
 * A "?" badge that shows `text` on hover or keyboard focus. Pure CSS (`.info-tip`
 * in styles/index.css). The bubble opens below the badge, capped in width, lined up
 * with the edge named by `align` so it stays inside the card.
 */
export function InfoTip({
  text,
  label = 'More info',
  align = 'right',
}: {
  text: string;
  label?: string;
  /** Which badge edge the bubble lines up with: 'right' opens leftwards (for right-aligned headers). */
  align?: 'left' | 'right';
}) {
  const id = useId();
  return (
    <span className={`info-tip info-tip-${align}`}>
      <button type="button" className="info-tip-badge" aria-label={label} aria-describedby={id}>
        ?
      </button>
      <span role="tooltip" id={id} className="info-tip-bubble">
        {text}
      </span>
    </span>
  );
}
