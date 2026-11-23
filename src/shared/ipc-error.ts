// ─── IPC error text ───
// Electron rejects a failed handler with "Error invoking remote method '<channel>': Error: <message>".
// That prefix reached every error banner and toast (v0.3.2: Reconnect servers, wallet create). The
// preload strips it once, so the renderer only ever sees the message the main process wrote.
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/;

export function cleanIpcError(err: unknown): unknown {
  if (err instanceof Error && IPC_ERROR_PREFIX.test(err.message)) {
    const clean = new Error(err.message.replace(IPC_ERROR_PREFIX, ''));
    clean.name = err.name;
    return clean;
  }
  return err;
}
