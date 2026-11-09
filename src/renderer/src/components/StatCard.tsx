interface Props {
  label: string;
  value: React.ReactNode;
  caption?: React.ReactNode;
  icon?: React.ReactNode;
  accent?: 'default' | 'success' | 'warning' | 'accent' | 'danger';
  className?: string;
}

export function StatCard({ label, value, caption, icon, accent = 'default', className = '' }: Props) {
  const valueColor = {
    default: 'var(--text)',
    success: 'var(--green)',
    warning: 'var(--yellow)',
    danger: 'var(--red)',
    accent: 'var(--accent)',
  }[accent];
  return (
    <div className={`stat-card text-center ${className}`}>
      <div className="flex items-center justify-center gap-2">
        <div className="stat-label">{label}</div>
        {icon && <div style={{ color: 'var(--text-dim)' }}>{icon}</div>}
      </div>
      <div className="stat-value text-center" style={{ color: valueColor }}>
        {value}
      </div>
      {caption && <div className="stat-sub text-center">{caption}</div>}
    </div>
  );
}
