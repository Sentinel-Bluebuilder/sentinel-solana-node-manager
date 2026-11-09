import { useEffect, useState } from 'react';

interface Props {
  value: string;
  size?: number;
}

/**
 * Renders an SVG QR code. The SVG is produced by the `qrcode` package in the
 * main process (via window.api.wallet.qrSvg) so we never pull the lib into
 * the renderer bundle. The inner SVG is inlined via dangerouslySetInnerHTML
 * — the main process is the trust boundary, and the input is a known app
 * address, not user-controlled HTML.
 */
export function QRCode({ value, size = 160 }: Props) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setSvg(null);
      return;
    }
    void window.api.wallet.qrSvg(value).then((s) => {
      if (!cancelled) setSvg(s);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!svg) {
    return (
      <div
        className="rounded-lg bg-bg-input border border-border grid place-items-center"
        style={{ width: size, height: size }}
      >
        <span className="text-[10px] text-text-dim">Rendering…</span>
      </div>
    );
  }

  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-lg overflow-hidden bg-white p-2"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
