export function getSyncErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(msg)) {
    return 'Could not reach server — check the URL and make sure it\'s running';
  }
  return msg;
}
