import {
  listPendingCrashLogs,
  readCrashLog,
  deleteCrashLog,
  type CrashReport,
} from './crashHandler';
function getDevHost(): string {
  return 'localhost';
}

const CRASH_API_URL = import.meta.env.DEV
  ? `http://${getDevHost()}:5100/api/crash`
  : 'https://notes-crashlog.futo.org/api/crash';

const CRASH_BATCH_API_URL = import.meta.env.DEV
  ? `http://${getDevHost()}:5100/api/crashes`
  : 'https://notes-crashlog.futo.org/api/crashes';

let lastSendError: string | null = null;

export function getLastSendError(): string | null {
  return lastSendError;
}

async function post(
  url: string,
  data: unknown,
): Promise<{ ok: boolean; status: number; bodyText?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  let bodyText: string | undefined;
  if (!res.ok) {
    try {
      bodyText = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
  }
  return { ok: res.ok, status: res.status, bodyText };
}

export async function sendCrashReport(
  report: CrashReport,
  userDescription?: string,
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { ...report };
    if (userDescription) body.user_description = userDescription;
    const res = await post(CRASH_API_URL, body);
    if (!res.ok) lastSendError = `HTTP ${res.status}${res.bodyText ? `: ${res.bodyText}` : ''}`;
    return res.ok;
  } catch (e) {
    lastSendError = `network: ${(e as Error)?.message ?? String(e)}`;
    return false;
  }
}

export async function sendAllPendingReports(
  userDescription?: string,
): Promise<{ sent: number; failed: number }> {
  lastSendError = null;
  const filenames = await listPendingCrashLogs();
  let sent = 0;
  let failed = 0;

  if (filenames.length === 0) return { sent, failed };

  try {
    const reports: Array<Record<string, unknown>> = [];
    for (const filename of filenames) {
      const report = await readCrashLog(filename);
      const body: Record<string, unknown> = { ...report };
      if (userDescription) body.user_description = userDescription;
      reports.push(body);
    }

    const res = await post(CRASH_BATCH_API_URL, { crashes: reports });

    if (res.ok) {
      for (const filename of filenames) {
        await deleteCrashLog(filename);
      }
      return { sent: filenames.length, failed: 0 };
    }
    lastSendError = `batch HTTP ${res.status}${res.bodyText ? `: ${res.bodyText}` : ''}`;
  } catch (e) {
    lastSendError = `batch network: ${(e as Error)?.message ?? String(e)}`;
  }

  for (const filename of filenames) {
    try {
      const report = await readCrashLog(filename);
      const ok = await sendCrashReport(report, userDescription);
      if (ok) {
        await deleteCrashLog(filename);
        sent++;
      } else {
        failed++;
      }
    } catch (e) {
      lastSendError = `read ${filename}: ${(e as Error)?.message ?? String(e)}`;
      failed++;
    }
  }

  return { sent, failed };
}

export async function discardAllPendingReports(): Promise<void> {
  const filenames = await listPendingCrashLogs();
  for (const filename of filenames) {
    await deleteCrashLog(filename);
  }
}

export async function loadPendingReports(): Promise<CrashReport[]> {
  const filenames = await listPendingCrashLogs();
  const reports: CrashReport[] = [];
  for (const filename of filenames) {
    try {
      reports.push(await readCrashLog(filename));
    } catch {
      /* Intentionally ignored: the operation is best-effort. */
    }
  }
  return reports;
}
