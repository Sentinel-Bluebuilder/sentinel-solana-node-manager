import type { CSSProperties } from 'react';

/**
 * Material Symbols wrapper.
 *
 * We ship Google's outlined icon set via the `material-symbols` npm
 * package (CSS import in styles/index.css). Rendering is a plain <span>
 * with the `material-symbols-outlined` class — icon names are provided
 * as inner text (that's how Material Symbols work).
 *
 * Pros: zero SVG duplication, all ~3k icons available, crisp at any size.
 */

export type MIconVariant = 'outlined' | 'rounded' | 'sharp';

export interface MIconProps {
  name: string;
  size?: number; // pixels
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700;
  grade?: -25 | 0 | 200;
  filled?: boolean;
  className?: string;
  style?: CSSProperties;
  variant?: MIconVariant;
  title?: string;
  'aria-hidden'?: boolean;
}

export function MIcon({
  name,
  size = 20,
  weight = 400,
  grade = 0,
  filled = false,
  className = '',
  style,
  variant = 'outlined',
  title,
  'aria-hidden': ariaHidden = true,
}: MIconProps) {
  const axes = [
    `'FILL' ${filled ? 1 : 0}`,
    `'wght' ${weight}`,
    `'GRAD' ${grade}`,
    `'opsz' ${Math.max(20, Math.min(48, size))}`,
  ].join(', ');
  return (
    <span
      className={`material-symbols-${variant} select-none inline-block leading-none ${className}`}
      aria-hidden={ariaHidden}
      title={title}
      style={{
        fontSize: `${size}px`,
        width: `${size}px`,
        height: `${size}px`,
        lineHeight: `${size}px`,
        fontVariationSettings: axes,
        ...style,
      }}
    >
      {name}
    </span>
  );
}
