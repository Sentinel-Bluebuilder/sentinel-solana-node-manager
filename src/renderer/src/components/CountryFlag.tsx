interface Props {
  /** ISO-3166-1 alpha-2 country code (e.g. 'US', 'DE'). */
  code?: string;
  className?: string;
}

/**
 * Render a flag emoji from an ISO-3166-1 alpha-2 country code by mapping
 * each letter to its regional-indicator symbol. Returns a neutral globe
 * when the code is missing or malformed so the caller does not have to
 * branch on undefined.
 */
export function CountryFlag({ code, className }: Props) {
  const cc = (code ?? '').trim().toUpperCase();
  const flag =
    cc.length === 2 && /^[A-Z]{2}$/.test(cc)
      ? String.fromCodePoint(
          0x1f1e6 + (cc.charCodeAt(0) - 65),
          0x1f1e6 + (cc.charCodeAt(1) - 65),
        )
      : '\u{1F310}';
  return (
    <span
      className={className}
      aria-label={cc || 'unknown country'}
      style={{
        fontFamily:
          '"Twemoji Mozilla", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
        lineHeight: 1,
      }}
    >
      {flag}
    </span>
  );
}
