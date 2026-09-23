import { getFS, hasFileSystem, platformName } from '$lib/platform';

const CRASHLOGS_DIR = '.crashlogs';
const LS_QUEUE_KEY = 'futo_crash_queue';

export interface CrashReport {
  error: string;
  stack?: string;
  app_version: string;
  platform: string;
  device_info: string;
  timestamp: string;
  type: 'js_error' | 'unhandled_rejection' | 'rust_panic';
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

function buildReport(
  error: string,
  stack: string | undefined,
  type: CrashReport['type'],
): CrashReport {
  return {
    error,
    stack,
    app_version: appVersion,
    platform: platformName,
    device_info: `${navigator.userAgent} | ${screen.width}x${screen.height}`,
    timestamp: new Date().toISOString(),
    type,
    route: window.location.hash.slice(1) || '/',
    session_id: sessionId,
  };
}

// Browser-noise messages that are never worth a crash report: they describe
// the browser skipping a ResizeObserver notification for a frame, not an app
// error. #007 — reported through the in-app crash reporter on first open of
// the Linux AppImage.
const IGNORED_ERROR_MESSAGES = [
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded',
];

function isIgnoredError(errorStr: string): boolean {
  return IGNORED_ERROR_MESSAGES.some((ignored) => errorStr.includes(ignored));
}

function queueToLocalStorage(report: CrashReport): void {
  try {
    const existing = window.localStorage.getItem(LS_QUEUE_KEY);
    const queue: CrashReport[] = existing ? JSON.parse(existing) : [];
    queue.push(report);
    window.localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* Intentionally ignored: the operation is best-effort. */
  }
}

// One fault thrown from a loop (an effect, a timer, a retry) fires the global
// handlers every time; reporting each occurrence turned one bug into hundreds
// of identical reports.
const reportedThisSession = new Set<string>();

function captureError(
  errorStr: string,
  stack: string | undefined,
  type: CrashReport['type'],
): void {
  if (isIgnoredError(errorStr)) return;
  const fingerprint = `${type}\n${errorStr}\n${stack ?? ''}`;
  if (reportedThisSession.has(fingerprint)) return;
  reportedThisSession.add(fingerprint);
  const report = buildReport(errorStr, stack, type);
  queueToLocalStorage(report);
  if (hasFileSystem) {
    try {
      writeCrashReport(report).catch(() => {});
    } catch {
      /* FS not ready */
    }
  }
}

export function installGlobalHandlers(): void {
  const existingErrorHandler = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    captureError(
      error?.message || String(message),
      error?.stack || `${source}:${lineno}:${colno}`,
      'js_error',
    );
    if (existingErrorHandler) {
      existingErrorHandler.call(window, message, source, lineno, colno, error);
    }
  };

  const existingRejectionHandler = window.onunhandledrejection;
  window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    captureError(
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : undefined,
      'unhandled_rejection',
    );
    if (existingRejectionHandler) {
      existingRejectionHandler.call(window, event);
    }
  };
}

export async function flushCrashQueue(): Promise<void> {
  const raw = window.localStorage.getItem(LS_QUEUE_KEY);
  if (!raw) return;

  let queue: CrashReport[];
  try {
    queue = JSON.parse(raw);
  } catch {
    window.localStorage.removeItem(LS_QUEUE_KEY);
    return;
  }

  if (queue.length === 0) {
    window.localStorage.removeItem(LS_QUEUE_KEY);
    return;
  }

  if (hasFileSystem) {
    const remaining: CrashReport[] = [];
    for (const report of queue) {
      try {
        await writeCrashReport(report);
      } catch {
        remaining.push(report);
      }
    }
    if (remaining.length > 0) {
      window.localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(remaining));
    } else {
      window.localStorage.removeItem(LS_QUEUE_KEY);
    }
  } else {
    window.localStorage.removeItem(LS_QUEUE_KEY);
  }
}

function crashFilename(report: CrashReport): string {
  const ts = new Date(report.timestamp).getTime();
  const sid = (report.session_id || 'nosession').slice(0, 8);
  let h = 0;
  for (let i = 0; i < report.error.length; i++) {
    h = ((h << 5) - h + report.error.charCodeAt(i)) | 0;
  }
  const eh = (h >>> 0).toString(36).slice(0, 4);
  return `crash-${ts}-${sid}-${eh}.json`;
}

export async function writeCrashReport(report: CrashReport): Promise<void> {
  if (!hasFileSystem) return;
  const filename = crashFilename(report);
  await getFS().writeAppData(`${CRASHLOGS_DIR}/${filename}`, JSON.stringify(report));
}

export async function listPendingCrashLogs(): Promise<string[]> {
  if (!hasFileSystem) return [];
  try {
    const files = await getFS().listAppData(CRASHLOGS_DIR);
    return files.filter((f) => f.endsWith('.json'));
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
