import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import { GROUP_LABEL, type CliCommand } from '../lib/cli';

// Local helper: detect poll-y commands typed inline in the renderer
// fallback path. The store owns the same set for stream events.
const RENDERER_POLL_COMMANDS = new Set([
  'deploy.status',
  'nodes.list',
  'nodes.get',
  'nodes.status',
  'system.report',
  'wallet.refreshBalance',
  'wallet.get',
  'settings.chainHealth',
  'cli.status',
  'updater.status',
  'events.list',
  'docker.overview',
]);
function rendererCommandFromInput(text: string): string | null {
  const stripped = text.startsWith('$ ') ? text.slice(2) : text;
  const tok = stripped.trim().split(/\s+/)[0];
  return tok || null;
}
function rendererIsPollInput(text: string): boolean {
  const cmd = rendererCommandFromInput(text);
  return cmd != null && RENDERER_POLL_COMMANDS.has(cmd);
}

export function CLI() {
  const {
    pushToast,
    cliOutput: output,
    cliHistory: history,
    cliServerState: serverState,
    appendCliOutput,
    clearCliOutput,
    pushCliHistory,
    setCliServerState,
  } = useApp();
  const [filter, setFilter] = useState('');
  const [input, setInput] = useState('');
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [running, setRunning] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [hidePollSpam, setHidePollSpam] = useState(true);
  // The registry lives in main; fetch its metadata once.
  const [COMMANDS, setCommands] = useState<CliCommand[]>([]);
  useEffect(() => {
    void window.api.cli
      .commands()
      .then((c) => setCommands(c as CliCommand[]))
      .catch((err: unknown) => pushToast({ title: 'Could not load CLI commands', body: (err as Error).message, tone: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const outRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Preload may be missing in dev after HMR on preload-side edits. Surface a
  // synthetic state so the screen renders something useful instead of crashing.
  useEffect(() => {
    if (!window.api?.cli && !serverState) {
      setCliServerState({
        status: 'off',
        endpoint: null,
        sessionStartedAt: null,
        discoveryPath: null,
        error: 'Preload bridge missing window.api.cli — reload the app window.',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = serverState?.status ?? 'off';
  const promptEnabled = status === 'off' || status === 'app-active';
  const isRemoteHolder = status === 'shell-active' || status === 'agent-active';

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? COMMANDS.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.summary.toLowerCase().includes(q) ||
            c.group.includes(q),
        )
      : COMMANDS;
    const out = new Map<CliCommand['group'], CliCommand[]>();
    for (const c of filtered) {
      const arr = out.get(c.group) ?? [];
      arr.push(c);
      out.set(c.group, arr);
    }
    return out;
  }, [filter, COMMANDS]);

  const visibleOutput = useMemo(
    () => (hidePollSpam ? output.filter((e) => !e.poll) : output),
    [output, hidePollSpam],
  );
  const hiddenPollCount = output.length - visibleOutput.length;

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [visibleOutput.length]);

  const startServer = async () => {
    setServerBusy(true);
    try {
      const s = await window.api.cli.start();
      setCliServerState(s);
      if (s.error) {
        pushToast({ title: 'CLI server failed to start', body: s.error, tone: 'error' });
      } else {
        pushToast({ title: 'CLI server started', tone: 'success' });
      }
    } catch (err) {
      pushToast({
        title: 'CLI server failed to start',
        body: (err as Error).message,
        tone: 'error',
      });
    } finally {
      setServerBusy(false);
    }
  };

  const stopServer = async () => {
    setServerBusy(true);
    try {
      const s = await window.api.cli.stop();
      setCliServerState(s);
      pushToast({ title: 'CLI server stopped', tone: 'info' });
    } finally {
      setServerBusy(false);
    }
  };

  const openInPowerShell = async () => {
    if (status === 'off') {
      pushToast({
        title: 'Start the CLI server first',
        body: 'PowerShell connects to the same server the in-app CLI uses.',
        tone: 'warn',
      });
      return;
    }
    setServerBusy(true);
    try {
      const r = await window.api.cli.openPowerShell();
      if (!r.ok) {
        pushToast({
          title: 'Could not open PowerShell',
          body: r.error,
          tone: 'error',
        });
      }
    } finally {
      setServerBusy(false);
    }
  };

  // ─── command execution ─────────────────────────────────────────────────────

  const runLocally = async (line: string, trimmed: string) => {
    // Path used when the CLI server is off — keeps the screen functional
    // even before the user starts the server.
    const poll = RENDERER_POLL_COMMANDS.has(trimmed.split(/\s+/)[0]);
    setRunning(true);
    try {
      const r = await window.api.cli.exec(trimmed);
      appendCliOutput(r.ok ? { kind: 'ok', text: r.text, poll } : { kind: 'err', text: r.error ?? 'Unknown error', poll });
    } catch (err) {
      appendCliOutput({ kind: 'err', text: (err as Error).message, poll });
    } finally {
      setRunning(false);
    }
    void line;
  };

  const runViaServer = async (line: string) => {
    setRunning(true);
    try {
      // Output is streamed via cli.onStream — we don't need to append here
      // for input/ok/err; the stream event arrives for both this client and
      // any other watcher.
      // The server broadcasts input/ok/err events for this run; nothing to append here.
      await window.api.cli.run(line);
    } catch (err) {
      appendCliOutput({ kind: 'err', text: (err as Error).message });
    } finally {
      setRunning(false);
    }
  };

  const run = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    pushCliHistory(trimmed);
    setHistoryIdx(-1);

    if (trimmed === 'clear' || trimmed === 'cls') {
      clearCliOutput();
      return;
    }
    if (trimmed === 'help') {
      appendCliOutput({ kind: 'input', text: `$ ${trimmed}` });
      const lines = [
        'Available commands:',
        ...COMMANDS.map((c) => `  ${c.name.padEnd(28)} ${c.summary}`),
        '',
        'Built-in:',
        '  help                         Print this help.',
        '  clear, cls                   Clear the output.',
        '',
        'Tip: click any command on the left to insert its usage; ↑/↓ recalls history.',
      ].join('\n');
      appendCliOutput({ kind: 'info', text: lines });
      return;
    }

    if (status === 'app-active') {
      // The server will broadcast input/ok/err events back to us — no local append.
      await runViaServer(trimmed);
      return;
    }

    // Server off → run in renderer (legacy fallback path).
    const poll = rendererIsPollInput(`$ ${trimmed}`);
    appendCliOutput({ kind: 'input', text: `$ ${trimmed}`, poll });
    await runLocally(line, trimmed);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (running || !promptEnabled) return;
    void run(input);
    setInput('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setInput(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx === -1) return;
      const next = historyIdx + 1;
      if (next >= history.length) {
        setHistoryIdx(-1);
        setInput('');
      } else {
        setHistoryIdx(next);
        setInput(history[next]);
      }
    }
  };

  const insertCommand = (c: CliCommand) => {
    setInput(c.usage);
    inputRef.current?.focus();
  };

  const copyCommand = async (c: CliCommand) => {
    try {
      await navigator.clipboard.writeText(c.usage);
      pushToast({ title: 'Copied to clipboard', body: c.name, tone: 'success' });
    } catch {
      pushToast({ title: 'Could not copy', tone: 'error' });
    }
  };

  const runCommand = (c: CliCommand) => {
    if (running || !promptEnabled) return;
    void run(c.name);
  };

  // ─── server status display ────────────────────────────────────────────────

  const statusLabel =
    status === 'off'
      ? 'Server off'
      : status === 'app-active'
        ? 'Active in app'
        : status === 'shell-active'
          ? 'Active in PowerShell — read-only here'
          : 'Active in AI agent — read-only here';

  const statusTone =
    status === 'off'
      ? { color: 'var(--text-dim)', dot: 'var(--text-dim)' }
      : status === 'app-active'
        ? { color: 'var(--green)', dot: 'var(--green)' }
        : { color: 'var(--yellow)', dot: 'var(--yellow)' };

  return (
    <div className="flex flex-col gap-4" style={{ height: 'calc(100vh - 96px)' }}>
      <PageHeader
        title="CLI"
        subtitle="Every IPC handler the GUI uses, callable from here, PowerShell, or an AI agent."
        right={
          <span
            className="text-[11px]"
            style={{ color: 'var(--text-dim)' }}
          >
            {COMMANDS.length} commands
          </span>
        }
      />

      {/* Server control bar */}
      <div
        className="card flex items-center justify-between gap-3 px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="h-2 w-2 rounded-full shrink-0"
            style={{ background: statusTone.dot }}
          />
          <div className="flex flex-col min-w-0">
            <div
              className="text-[12px] font-medium"
              style={{ color: statusTone.color }}
            >
              {statusLabel}
            </div>
            <div
              className="text-[11px] truncate"
              style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
              title={serverState?.endpoint ?? ''}
            >
              {serverState?.endpoint
                ? serverState.endpoint
                : 'Start the server to allow PowerShell or AI agents to share this session.'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status === 'off' ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void startServer()}
              disabled={serverBusy}
            >
              <MIcon name="play_arrow" size={12} />
              Start server
            </button>
          ) : (
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void openInPowerShell()}
                disabled={serverBusy}
                title="Launch a PowerShell window connected to this server"
              >
                <MIcon name="terminal" size={12} />
                Open in PowerShell
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void stopServer()}
                disabled={serverBusy}
              >
                <MIcon name="stop" size={12} />
                Stop server
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
        {/* Reference panel */}
        <div className="col-span-12 lg:col-span-5 flex flex-col min-h-0">
          <div className="card flex flex-col overflow-hidden flex-1 min-h-0">
            <div className="card-header">
              <div className="card-title flex items-center gap-2">
                <MIcon name="menu_book" size={14} />
                Command reference
              </div>
              <div
                className="flex items-center gap-1 px-2 py-1 rounded"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  minWidth: 180,
                }}
              >
                <MIcon name="search" size={12} />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  className="flex-1 bg-transparent text-xs outline-none"
                  style={{ color: 'var(--text)' }}
                />
              </div>
            </div>
            <div className="overflow-auto flex-1 min-h-0">
              {[...groups.entries()].map(([group, cmds]) => (
                <div key={group}>
                  <div
                    className="text-[10px] uppercase tracking-wider px-4 py-2 sticky top-0"
                    style={{
                      color: 'var(--text-dim)',
                      background: 'var(--bg)',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {GROUP_LABEL[group]}
                  </div>
                  <ul>
                    {cmds.map((c) => (
                      <li
                        key={c.name}
                        className="px-4 py-3 flex flex-col gap-1.5"
                        style={{ borderBottom: '1px solid var(--border)' }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <code
                            className="text-[12px] font-semibold"
                            style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}
                          >
                            {c.name}
                          </code>
                          <div className="flex items-center gap-1">
                            <button
                              className="btn btn-ghost btn-sm"
                              title="Insert into prompt"
                              onClick={() => insertCommand(c)}
                              disabled={!promptEnabled}
                            >
                              <MIcon name="edit" size={12} />
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              title="Copy usage line"
                              onClick={() => void copyCommand(c)}
                            >
                              <MIcon name="content_copy" size={12} />
                            </button>
                            {c.args.length === 0 && (
                              <button
                                className="btn btn-ghost btn-sm"
                                title="Run now"
                                onClick={() => runCommand(c)}
                                disabled={running || !promptEnabled}
                              >
                                <MIcon name="play_arrow" size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                        <div
                          className="text-[11px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {c.summary}
                        </div>
                        <pre
                          className="text-[11px] px-2 py-1 overflow-x-auto whitespace-pre"
                          style={{
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            color: 'var(--text)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {c.usage}
                        </pre>
                        {c.args.length > 0 && (
                          <ul className="flex flex-col gap-0.5 pl-1">
                            {c.args.map((a) => (
                              <li
                                key={a.name}
                                className="text-[10px] flex items-start gap-2"
                                style={{ color: 'var(--text-dim)' }}
                              >
                                <code
                                  style={{
                                    color: a.required
                                      ? 'var(--text)'
                                      : 'var(--text-muted)',
                                    fontFamily: 'var(--font-mono)',
                                  }}
                                >
                                  {a.kind === 'positional'
                                    ? `<${a.name}>`
                                    : `--${a.name}`}
                                </code>
                                <span>
                                  {a.required ? '' : '(optional) '}
                                  {a.describe}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {groups.size === 0 && (
                <div
                  className="text-xs text-center py-8"
                  style={{ color: 'var(--text-dim)' }}
                >
                  No commands match "{filter}".
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Terminal panel */}
        <div className="col-span-12 lg:col-span-7 flex flex-col min-h-0">
          <div className="card flex flex-col overflow-hidden flex-1 min-h-0">
            <div className="card-header">
              <div className="card-title flex items-center gap-2">
                <MIcon name="terminal" size={14} />
                Terminal
                {isRemoteHolder && (
                  <span
                    className="text-[10px] px-2 py-0.5 rounded"
                    style={{
                      background: 'rgba(245, 200, 66, 0.15)',
                      color: 'var(--yellow)',
                      border: '1px solid var(--yellow)',
                    }}
                  >
                    READ-ONLY
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`chip ${running ? 'chip-warn' : 'chip-success'}`}
                  style={{ fontSize: 10 }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: running ? 'var(--yellow)' : 'var(--green)' }}
                  />
                  {running ? 'Running…' : 'Ready'}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  title={
                    hidePollSpam
                      ? 'Show every command, including repeated polling reads.'
                      : 'Hide repeated polling reads (deploy.status, system.report, nodes.list, etc.) plus shell connect/disconnect chatter.'
                  }
                  onClick={() => setHidePollSpam((v) => !v)}
                  aria-pressed={hidePollSpam}
                  style={
                    hidePollSpam
                      ? { color: 'var(--accent)', borderColor: 'var(--accent)' }
                      : undefined
                  }
                >
                  <MIcon
                    name={hidePollSpam ? 'visibility_off' : 'visibility'}
                    size={12}
                  />
                  {hidePollSpam ? 'Polls hidden' : 'Hide polls'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  title="Clear output"
                  onClick={() => clearCliOutput()}
                >
                  <MIcon name="cleaning_services" size={12} />
                  Clear
                </button>
              </div>
            </div>
            <div
              ref={outRef}
              className="overflow-auto px-4 py-3 flex-1 min-h-0"
              style={{
                background: 'var(--bg-input)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: 1.55,
              }}
            >
              {visibleOutput.map((e) => (
                <pre
                  key={e.id}
                  className="whitespace-pre-wrap"
                  style={{
                    color:
                      e.kind === 'input'
                        ? 'var(--accent)'
                        : e.kind === 'err'
                          ? 'var(--red)'
                          : e.kind === 'info'
                            ? 'var(--text-muted)'
                            : 'var(--text)',
                    margin: '4px 0',
                  }}
                >
                  {e.source && e.source !== 'app' && e.source !== 'system'
                    ? `[${e.source}] ${e.text}`
                    : e.text}
                </pre>
              ))}
              {hidePollSpam && hiddenPollCount > 0 && (
                <div
                  className="text-[10px] mt-2 italic"
                  style={{ color: 'var(--text-dim)' }}
                >
                  {hiddenPollCount} poll line{hiddenPollCount === 1 ? '' : 's'} hidden ·
                  click "Polls hidden" above to show them.
                </div>
              )}
            </div>
            <form
              onSubmit={onSubmit}
              className="flex items-center gap-2 px-4 py-3"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <span
                style={{
                  color: 'var(--accent)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                }}
              >
                $
              </span>
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={running || !promptEnabled}
                placeholder={
                  isRemoteHolder
                    ? `Locked — ${status === 'shell-active' ? 'PowerShell' : 'AI agent'} is the active client`
                    : running
                      ? 'Running…'
                      : 'Type a command, e.g. nodes.list'
                }
                className="flex-1 bg-transparent outline-none"
                style={{
                  color: 'var(--text)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                }}
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={running || !promptEnabled || !input.trim()}
              >
                <MIcon name="send" size={12} />
                Run
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
