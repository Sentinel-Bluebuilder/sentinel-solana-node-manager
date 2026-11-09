import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  private reload = () => window.location.reload();

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className="h-full w-full grid place-items-center p-6"
        style={{ background: 'var(--bg)' }}
      >
        <div
          className="max-w-lg w-full card"
          style={{ border: '1px solid var(--border)' }}
        >
          <div className="card-header">
            <div className="card-title" style={{ color: 'var(--red)' }}>
              Something went wrong
            </div>
          </div>
          <div className="card-body flex flex-col gap-3">
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              The UI hit an unexpected error. Your node keeps running in Docker, this is
              only the manager window.
            </div>
            <pre
              className="text-[11px] mono-inline p-2 overflow-auto max-h-40"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text)',
              }}
            >
              {error.message}
              {error.stack ? `\n\n${error.stack.split('\n').slice(0, 6).join('\n')}` : ''}
            </pre>
            <div className="flex gap-2">
              <button className="btn btn-secondary flex-1" onClick={this.reset}>
                Try again
              </button>
              <button className="btn btn-primary flex-1" onClick={this.reload}>
                Reload window
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
