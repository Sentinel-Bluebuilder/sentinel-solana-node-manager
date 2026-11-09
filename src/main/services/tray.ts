import { app, BrowserWindow, Menu, Tray, nativeImage, Notification } from 'electron';
import path from 'node:path';
import { log } from './logger';
import { listNodes, stopNode } from './node-manager';
import { getSettings, updateSettings } from './settings';

let tray: Tray | null = null;
let getWindow: () => BrowserWindow | null = () => null;
let realQuit = false;

function resolveTrayIcon(): Electron.NativeImage {
  const sizes = process.platform === 'darwin' ? [22, 32] : [16, 24, 32];
  const roots = [
    path.join(process.resourcesPath ?? '', 'build'),
    path.join(app.getAppPath(), 'build'),
    path.join(__dirname, '..', '..', 'build'),
  ];
  for (const root of roots) {
    for (const size of sizes) {
      const p = path.join(root, `tray-icon-${size}.png`);
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
    const fallback = path.join(root, 'tray-icon.png');
    const img = nativeImage.createFromPath(fallback);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function showWindow(): void {
  const win = getWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideWindow(): void {
  const win = getWindow();
  if (!win) return;
  win.hide();
}

async function quitApp(): Promise<void> {
  const settings = await getSettings();
  if (settings.stopNodesOnQuit) {
    try {
      const nodes = await listNodes();
      const running = nodes.filter((n) => (n.status === 'online' || n.status === 'loading') && !n.removalStage);
      for (const n of running) {
        try {
          await stopNode(n.id);
        } catch (err) {
          log.warn('tray quit: stopNode failed', { nodeId: n.id, err: String(err) });
        }
      }
    } catch (err) {
      log.warn('tray quit: listNodes failed', { err: String(err) });
    }
  }
  realQuit = true;
  app.quit();
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => showWindow() },
    { label: 'Hide Window', click: () => hideWindow() },
    { type: 'separator' },
    {
      label: 'Quit Sentinel Node Manager',
      click: () => {
        void quitApp();
      },
    },
  ]);
}

export function createAppTray(windowGetter: () => BrowserWindow | null): Tray | null {
  if (tray) return tray;
  getWindow = windowGetter;
  const icon = resolveTrayIcon();
  if (icon.isEmpty()) {
    log.warn('tray icon asset not found — tray disabled');
    return null;
  }
  tray = new Tray(icon);
  tray.setToolTip('Sentinel Node Manager');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) hideWindow();
    else showWindow();
  });
  tray.on('double-click', () => showWindow());
  return tray;
}

export function destroyAppTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

/**
 * Show a one-time OS notification on first close-to-tray so Windows users
 * don't think the app silently disappeared. Persisted via settings so the
 * nag doesn't repeat.
 */
export async function maybeShowTrayHint(): Promise<void> {
  const settings = await getSettings();
  if (settings.trayHintShown) return;
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Sentinel Node Manager is still running',
        body: 'Your node keeps running in the background. Right-click the tray icon to quit.',
        icon: resolveTrayIcon(),
        silent: false,
      }).show();
    }
  } catch (err) {
    log.debug('tray hint notification failed', { err: String(err) });
  }
  await updateSettings({ trayHintShown: true });
}

export function isQuittingForReal(): boolean {
  return realQuit;
}

export function markQuittingForReal(): void {
  realQuit = true;
}

export function isTrayActive(): boolean {
  return tray !== null;
}
