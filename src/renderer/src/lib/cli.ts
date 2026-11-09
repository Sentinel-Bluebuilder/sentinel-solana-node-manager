/**
 * In-app CLI — renderer side.
 *
 * The command registry lives ONLY in the main process
 * (src/main/services/cli-registry.ts). The renderer fetches its metadata over
 * IPC (`window.api.cli.commands()`) and executes through it
 * (`window.api.cli.exec()` when the server is off, `window.api.cli.run()` when
 * the app holds the server). One registry means the in-app prompt, PowerShell,
 * agents and the e2e suite can never drift apart.
 */

export interface CliArg {
  name: string;
  kind: 'positional' | 'flag' | 'bool';
  required?: boolean;
  describe: string;
}

export type CliGroup =
  | 'system'
  | 'docker'
  | 'settings'
  | 'wallet'
  | 'events'
  | 'updater'
  | 'ssh'
  | 'deploy'
  | 'nodes'
  | 'cli';

export interface CliCommand {
  name: string;
  group: CliGroup;
  summary: string;
  usage: string;
  args: CliArg[];
}

export const GROUP_LABEL: Record<CliGroup, string> = {
  system: 'System',
  docker: 'Docker',
  settings: 'Settings',
  wallet: 'Wallet',
  events: 'Events',
  updater: 'Updater',
  ssh: 'SSH',
  deploy: 'Deploy',
  nodes: 'Nodes',
  cli: 'CLI',
};
