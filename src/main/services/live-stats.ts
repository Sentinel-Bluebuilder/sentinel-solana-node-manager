import os from 'node:os';
import { BrowserWindow } from 'electron';
import { IPC, type LiveSystemStats } from '../../shared/types';

const SAMPLE_INTERVAL_MS = 1000;

let timer: NodeJS.Timeout | null = null;
let subscriberCount = 0;
let prevCpuTimes: ReturnType<typeof readCpuTimes> | null = null;

interface CoreTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CoreTimes[] {
  return os.cpus().map((c) => {
    const t = c.times;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total };
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function sampleAndBroadcast(): void {
  const now = readCpuTimes();
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));

  let perCore: number[];
  if (prevCpuTimes && prevCpuTimes.length === now.length) {
    perCore = now.map((cur, i) => {
      const prev = prevCpuTimes![i]!;
      const idleDiff = cur.idle - prev.idle;
      const totalDiff = cur.total - prev.total;
      if (totalDiff <= 0) return 0;
      return Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
    });
  } else {
    // First sample: no previous baseline, report 0 rather than a misleading
    // since-boot average.
    perCore = now.map(() => 0);
  }
  prevCpuTimes = now;

  const avg =
    perCore.length > 0
      ? perCore.reduce((a, b) => a + b, 0) / perCore.length
      : 0;

  const sample: LiveSystemStats = {
    ts: Date.now(),
    freeMemoryMb: freeMb,
    usedMemoryMb: Math.max(0, totalMb - freeMb),
    totalMemoryMb: totalMb,
    cpuLoadPct: avg,
    cpuPerCorePct: perCore,
  };
  broadcast(IPC.SYSTEM_LIVE_STATS, sample);
}

export function startLiveStats(): void {
  subscriberCount += 1;
  if (timer) return;
  // Prime the baseline so the first user-visible sample is real, not 0.
  prevCpuTimes = readCpuTimes();
  timer = setInterval(sampleAndBroadcast, SAMPLE_INTERVAL_MS);
}

export function stopLiveStats(): void {
  subscriberCount = Math.max(0, subscriberCount - 1);
  if (subscriberCount > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
  prevCpuTimes = null;
}

export function stopAllLiveStats(): void {
  subscriberCount = 0;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  prevCpuTimes = null;
}
