const RUST_TRANSPORT_ERROR =
  /^transport error:|error sending request|error trying to connect|connection refused|dns error|operation timed out|network is unreachable/i;
const HTTP_STATUS_ERROR = /\bHTTP\s+\d{3}\b/i;

export type SyncErrorClass = 'transient' | 'actionable';

/** rustls prefixes every certificate rejection this way, whatever the
 * verifier's reason (sync.md). The connection worked; trust did not, so it is
 * never a transport blip to wait out. */
export function isCertificateRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('invalid peer certificate');
}

function isTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (HTTP_STATUS_ERROR.test(message) || isCertificateRejection(message)) return false;
  return (
    (error instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(message)) ||
    RUST_TRANSPORT_ERROR.test(message)
  );
}

export function classifySyncError(error: unknown): SyncErrorClass {
  return isTransportError(error) ? 'transient' : 'actionable';
}

export function syncErrorDedupeKey(error: unknown): string {
  if (isTransportError(error)) return 'transport';
  return error instanceof Error ? error.message : String(error);
}
