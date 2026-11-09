import { BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import { readStore, writeStore } from './store';
import { IPC, type AppEvent } from '../../shared/types';

/**
 * Event log powering the UI's "Recent Activity" cards.
 *
 * Anyone appending to this log should go through {@link addEvent} so that
 * the renderer gets a broadcast push immediately (EVENTS_CHANGED).
 */

const MAX_EVENTS = 200;

export async function addEvent(
  partial: Omit<AppEvent, 'id' | 'timestamp'>,
): Promise<AppEvent> {
  const event: AppEvent = {
    ...partial,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  const store = await readStore();
  store.events = [event, ...store.events].slice(0, MAX_EVENTS);
  await writeStore(store);
  broadcast(IPC.EVENTS_CHANGED, event);
  return event;
}

export async function listEvents(limit = 50): Promise<AppEvent[]> {
  const store = await readStore();
  return store.events.slice(0, limit);
}

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
