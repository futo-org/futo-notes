import { getFS, hasFileSystem } from './platform';

const CRASHLOGS_DIR = '.crashlogs';
const LS_QUEUE_KEY = 'futo_crash_queue';

export interface CrashReport {
  error: string;
  stack?: string;
  app_version: string;
  platform: string;
  device_info: string;
  timestamp: string;
  type: 'js_error' | 'unhandled_rejection' | 'native_crash';
  route?: string;
  os_version?: string;
  session_id?: string;
}

let appVersion = '0.0.0';
const sessionId = crypto.randomUUID();

export function setAppVersion(version: string): void {
  appVersion = version;
}

export function getAppVersion(): string {
  return appVersion;
}

export function getSessionId(): string {
  return sessionId;
}

function buildReport(
  error: string,
  stack: string | undefined,
  type: CrashReport['type'],
): CrashReport {
  let platform = 'web';
  try {
    platform = getFS().getPlatformName();
  } catch { /* FS not initialized yet */ }

  return {
    error,
    stack,
    app_version: appVersion,
    platform,
    device_info: `${navigator.userAgent} | ${screen.width}x${screen.height}`,
    timestamp: new Date().toISOString(),
    type,
    route: window.location.hash.slice(1) || '/',
    session_id: sessionId,
  };
}

function queueToLocalStorage(report: CrashReport): void {
  try {
    const existing = localStorage.getItem(LS_QUEUE_KEY);
    const queue: CrashReport[] = existing ? JSON.parse(existing) : [];
    queue.push(report);
    localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // localStorage full or unavailable — drop the report
  }
}

export function installGlobalHandlers(): void {
  const existingErrorHandler = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    const errorStr = error?.message || String(message);
    const stack = error?.stack || `${source}:${lineno}:${colno}`;
    queueToLocalStorage(buildReport(errorStr, stack, 'js_error'));
    if (existingErrorHandler) {
      existingErrorHandler.call(window, message, source, lineno, colno, error);
    }
  };

  const existingRejectionHandler = window.onunhandledrejection;
  window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const errorStr = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    queueToLocalStorage(buildReport(errorStr, stack, 'unhandled_rejection'));
    if (existingRejectionHandler) {
      existingRejectionHandler.call(window, event);
    }
  };
}

export async function flushCrashQueue(): Promise<void> {
  const raw = localStorage.getItem(LS_QUEUE_KEY);
  if (!raw) return;

  let queue: CrashReport[];
  try {
    queue = JSON.parse(raw);
  } catch {
    localStorage.removeItem(LS_QUEUE_KEY);
    return;
  }

  if (queue.length === 0) {
    localStorage.removeItem(LS_QUEUE_KEY);
    return;
  }

  if (hasFileSystem) {
    for (const report of queue) {
      await writeCrashReport(report);
    }
  }

  localStorage.removeItem(LS_QUEUE_KEY);
}

export async function writeCrashReport(report: CrashReport): Promise<void> {
  if (!hasFileSystem) return;
  const filename = `crash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  await getFS().writeAppData(`${CRASHLOGS_DIR}/${filename}`, JSON.stringify(report));
}

export async function listPendingCrashLogs(): Promise<string[]> {
  if (!hasFileSystem) return [];
  try {
    const files = await getFS().listAppData(CRASHLOGS_DIR);
    return files.filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

export async function readCrashLog(filename: string): Promise<CrashReport> {
  const data = await getFS().readAppData(`${CRASHLOGS_DIR}/${filename}`);
  if (!data) throw new Error(`Crash log not found: ${filename}`);
  return JSON.parse(data);
}

export async function deleteCrashLog(filename: string): Promise<void> {
  await getFS().deleteAppData(`${CRASHLOGS_DIR}/${filename}`);
}
