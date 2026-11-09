import { ipcMain } from 'electron';
import { IPC_UPDATER } from '../../shared/updater-types';

/**
 * Auto-update is DISABLED for this app.
 *
 * The Cosmos app this was converted from published releases to
 * sentinel-official/node-deployer-experimental; pointing electron-updater
 * there would "update" this Solana build into the Cosmos app. This app has
 * no release channel (it is built locally from a private upstream), so the
 * updater keeps its API but always reports why it is off.
 */

type Stage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'up-to-date';

interface State {
  stage: Stage;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

const DISABLED: State = { stage: 'idle', error: 'Updates are disabled: this build has no release channel.' };

export function getUpdaterState(): State {
  return DISABLED;
}

export async function checkForUpdatesNow(): Promise<State> {
  return DISABLED;
}

export function installPendingUpdate(): { ok: boolean; error?: string } {
  return { ok: false, error: DISABLED.error };
}

export function startUpdater(): void {
  ipcMain.handle(IPC_UPDATER.STATUS, () => DISABLED);
  ipcMain.handle(IPC_UPDATER.CHECK, () => DISABLED);
  ipcMain.handle(IPC_UPDATER.INSTALL, () => ({ ok: false, error: DISABLED.error }));
}
