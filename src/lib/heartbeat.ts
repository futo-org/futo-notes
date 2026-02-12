import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { writeCrashReport, type CrashReport, getSessionId, getAppVersion } from './crashHandler';

const HEARTBEAT_PATH = 'futo-notes/.heartbeat';

export async function writeHeartbeat(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Filesystem.writeFile({
    path: HEARTBEAT_PATH,
    data: new Date().toISOString(),
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });
}

export async function clearHeartbeat(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Filesystem.deleteFile({
      path: HEARTBEAT_PATH,
      directory: Directory.Documents,
    });
  } catch {
    // File doesn't exist
  }
}

export async function checkHeartbeat(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const result = await Filesystem.readFile({
      path: HEARTBEAT_PATH,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    // Stale heartbeat found — previous session didn't shut down cleanly
    const report: CrashReport = {
      error: 'App did not shut down cleanly (possible native crash or OOM kill)',
      app_version: getAppVersion(),
      platform: Capacitor.getPlatform(),
      device_info: `${navigator.userAgent} | ${screen.width}x${screen.height}`,
      timestamp: result.data as string,
      type: 'native_crash',
      route: '/',
      session_id: getSessionId(),
    };
    await writeCrashReport(report);
    await clearHeartbeat();
    return true;
  } catch {
    return false;
  }
}

let listeners: Array<() => void> = [];

export function startHeartbeat(): void {
  if (Capacitor.isNativePlatform()) {
    import('@capacitor/app').then(({ App }) => {
      const resumeHandle = App.addListener('resume', () => {
        writeHeartbeat();
      });
      const pauseHandle = App.addListener('pause', () => {
        clearHeartbeat();
      });
      listeners.push(
        () => resumeHandle.then(h => h.remove()),
        () => pauseHandle.then(h => h.remove()),
      );
    });
    // Write initial heartbeat
    writeHeartbeat();
  } else {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        writeHeartbeat();
      } else {
        clearHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', handler);
    listeners.push(() => document.removeEventListener('visibilitychange', handler));
    writeHeartbeat();
  }
}

export function stopHeartbeat(): void {
  for (const cleanup of listeners) cleanup();
  listeners = [];
  clearHeartbeat();
}
