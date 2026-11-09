import { useMemo } from 'react';
import {
  Bar,
  BarChart as ReBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface PeerSample {
  ts: number;
  peers: number;
}

interface Props {
  /** Time-ordered samples (ascending by ts). Empty-safe. */
  samples: PeerSample[];
  /**
   * Time window the caller wants rendered. Controls the X-axis domain so
   * a sparse history still shows a proper time range instead of only
   * spanning the bars it actually has.
   */
  windowMs: number;
  /** Inclusive upper edge of the x-axis (defaults to now). */
  endMs?: number;
  /**
   * Lower bound of meaningful data — typically the node's startedAt. When
   * provided and later than `endMs - windowMs`, the X-axis starts here
   * instead of stretching back into a period where no node existed.
   * Without this clamp a fresh node renders one bar floating in 24 h of
   * empty axis, which the user sees as a distorted chart.
   */
  minStartMs?: number;
  height?: number;
  /**
   * Minimum Y-axis headroom. With 0 samples or all-zero samples the
   * chart still renders 0→minScale so the user sees a proper scale
   * instead of a flat line.
   */
  minScale?: number;
  emptyLabel?: string;
}

/**
 * Peer-count time-series chart, backed by Recharts. The parent passes
 * real `{ts, peers}` samples plus a window width — we do not synthesize
 * bucket boundaries in the parent any more, which kept producing
 * mismatched axis labels. The chart places bars at their actual
 * timestamps on a time-based X-axis.
 */
export function BarChart({
  samples,
  windowMs,
  endMs,
  minStartMs,
  height = 160,
  minScale = 10,
  emptyLabel = 'No samples yet',
}: Props) {
  const end = endMs ?? Date.now();
  // Clamp the window's lower bound to `minStartMs` (e.g. node.startedAt)
  // so a node that's only been alive 10 minutes doesn't get rendered
  // against a 24-hour empty axis. We also pad the visible start by 5%
  // of the rendered span so the very first bar isn't pinned to the
  // axis edge — that pinning was the visible "distortion" on day one.
  const rawStart = end - windowMs;
  const clampedStart =
    typeof minStartMs === 'number' && minStartMs > rawStart ? minStartMs : rawStart;
  const span = Math.max(end - clampedStart, 60_000);
  const start = clampedStart - span * 0.05;

  const data = useMemo(() => {
    // Drop samples outside the window so the chart doesn't compress.
    return samples.filter((s) => s.ts >= start && s.ts <= end);
  }, [samples, start, end]);

  const yMax = useMemo(() => {
    const peak = data.reduce((m, s) => (s.peers > m ? s.peers : m), 0);
    return Math.max(peak, minScale);
  }, [data, minScale]);

  const renderedSpan = end - start;
  const xTickFormatter = (v: number) => {
    const d = new Date(v);
    if (renderedSpan <= 2 * 60 * 60 * 1000) {
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }
    if (renderedSpan <= 24 * 60 * 60 * 1000) {
      return `${d.getHours().toString().padStart(2, '0')}:00`;
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  if (data.length === 0) {
    // Render a framed empty state with the same dimensions so layout doesn't
    // jump when data arrives.
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-dim)',
          fontSize: 12,
          background: 'var(--bg-input)',
        }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <ReBarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <defs>
            <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.95} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.25} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--border)"
            strokeDasharray="2 3"
            vertical={false}
          />
          <XAxis
            dataKey="ts"
            type="number"
            domain={[start, end]}
            tickFormatter={xTickFormatter}
            stroke="var(--border)"
            tick={{ fill: 'var(--text-dim)', fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
            minTickGap={28}
            scale="time"
          />
          <YAxis
            domain={[0, yMax]}
            allowDecimals={false}
            stroke="var(--border)"
            tick={{ fill: 'var(--text-dim)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            cursor={{ fill: 'var(--accent)', fillOpacity: 0.08 }}
            contentStyle={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 11,
              color: 'var(--text)',
            }}
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            formatter={(v: number) => [v, 'Peers']}
          />
          <Bar
            dataKey="peers"
            fill="url(#barGrad)"
            radius={[3, 3, 0, 0]}
            maxBarSize={18}
            isAnimationActive={false}
          />
        </ReBarChart>
      </ResponsiveContainer>
    </div>
  );
}
