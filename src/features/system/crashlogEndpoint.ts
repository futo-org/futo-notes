const STORAGE_KEY = 'futo_crashlog_staging';

const PRODUCTION_BASE_URL = 'https://notes-crashlog.futo.org';
const STAGING_BASE_URL = 'https://staging-notes-crashlog.futo.org';
const LOCAL_BASE_URL = 'http://localhost:5100';

export function usingStagingCrashlog(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setUsingStagingCrashlog(useStaging: boolean): void {
  if (!import.meta.env.DEV) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(useStaging));
  } catch {
    return;
  }
}

export function devCrashlogBaseUrl(useStaging: boolean): string {
  return useStaging ? STAGING_BASE_URL : LOCAL_BASE_URL;
}

export function crashlogBaseUrl(): string {
  if (!import.meta.env.DEV) return PRODUCTION_BASE_URL;
  return devCrashlogBaseUrl(usingStagingCrashlog());
}
