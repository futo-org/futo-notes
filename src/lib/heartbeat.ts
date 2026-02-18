import { getFS, hasFileSystem, isMobile } from './platform';
import { writeCrashReport, type CrashReport, getSessionId, getAppVersion } from './crashHandler';

const HEARTBEAT_PATH = '.heartbeat';

export async function writeHeartbeat(): Promise<void> {
  if (!hasFileSystem) return;
  await getFS().writeAppData(HEARTBEAT_PATH, new Date().toISOString());
}

export async function clearHeartbeat(): Promise<void> {
  if (!hasFileSystem) return;
  await getFS().deleteAppData(HEARTBEAT_PATH);
}

export async function checkHeartbeat(): Promise<boolean> {
  if (!hasFileSystem) return false;
  try {
    const data = await getFS().readAppData(HEARTBEAT_PATH);
    if (!data) return false;
    // Stale heartbeat found — previous session didn't shut down cleanly
    const report: CrashReport = {
      error: 'App did not shut down cleanly (possible native crash or OOM kill)',
      app_version: getAppVersion(),
      platform: getFS().getPlatformName(),
      device_info: `${navigator.userAgent} | ${screen.width}x${screen.height}`,
      timestamp: data,
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
  if (isMobile) {
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
  } else if (hasFileSystem) {
    // Electron + web: use visibilitychange
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
