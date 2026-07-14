export function isNotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('not found') || msg.includes('no such file') || msg.includes('notfound');
  }
  if (typeof err === 'string') {
    const msg = err.toLowerCase();
    return msg.includes('not found') || msg.includes('no such file');
  }
  return false;
}
