export interface UpdateInfo {
  version: string;
  releaseDate?: string;
}

export type UpdaterStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'up-to-date';

export interface UpdaterState {
  stage: UpdaterStage;
  version?: string;
  percent?: number;
  error?: string;
  checkedAt?: number;
}

export const IPC_UPDATER = {
  STATUS: 'updater:status',
  CHECK: 'updater:check',
  INSTALL: 'updater:install',
  CHANGED: 'updater:changed', // main -> renderer push
} as const;
