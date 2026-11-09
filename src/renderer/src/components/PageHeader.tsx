interface Props {
  title: string;
  /** One line under the title (host:port, counts, what the screen does). */
  subtitle?: string;
  right?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}

export function PageHeader({ title, subtitle, right, breadcrumb }: Props) {
  return (
    <div className="page-header">
      <div>
        {breadcrumb && (
          <div className="mb-1 text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            {breadcrumb}
          </div>
        )}
        <h1 className="page-title">{title}</h1>
        {subtitle && (
          <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {subtitle}
          </div>
        )}
      </div>
      {right && <div className="flex items-center gap-2 flex-wrap justify-end">{right}</div>}
    </div>
  );
}
