import { listPendingCrashLogs, readCrashLog, deleteCrashLog, type CrashReport } from './crashHandler';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

const CRASH_API_URL = import.meta.env.DEV
  ? `http://${Capacitor.getPlatform() === 'android' ? '10.0.2.2' : 'localhost'}:5100/api/crash`
  : 'https://notes-crashlog.futo.org/api/crash';

const CRASH_BATCH_API_URL = import.meta.env.DEV
  ? `http://${Capacitor.getPlatform() === 'android' ? '10.0.2.2' : 'localhost'}:5100/api/crashes`
  : 'https://notes-crashlog.futo.org/api/crashes';

async function post(url: string, data: unknown): Promise<{ ok: boolean; status: number }> {
  if (Capacitor.isNativePlatform()) {
    // Use native HTTP to avoid mixed-content blocking in the WebView
    const res = await CapacitorHttp.post({
      url,
      headers: { 'Content-Type': 'application/json' },
      data: data as Record<string, unknown>,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { ok: res.ok, status: res.status };
}

export async function sendCrashReport(
  report: CrashReport,
  userDescription?: string,
): Promise<boolean> {
  try {
    const body: Record<string, unknown> = { ...report };
    if (userDescription) body.user_description = userDescription;
    const res = await post(CRASH_API_URL, body);
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendAllPendingReports(
  userDescription?: string,
): Promise<{ sent: number; failed: number }> {
  const filenames = await listPendingCrashLogs();
  let sent = 0;
  let failed = 0;

  if (filenames.length === 0) return { sent, failed };

  // Try batch send first
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
  } catch {
    // Batch failed, fall through to individual sends
  }

  // Fallback: send individually
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
    } catch {
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
      // Corrupted file, skip
    }
  }
  return reports;
}
