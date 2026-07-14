const UNREACHABLE_MESSAGE = "Could not reach server — check the URL and make sure it's running";

const RUST_TRANSPORT_ERROR =
  /^transport error:|error sending request|error trying to connect|connection refused|dns error|operation timed out|network is unreachable/i;

export function getSyncErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(msg)) {
    return UNREACHABLE_MESSAGE;
  }
  if (RUST_TRANSPORT_ERROR.test(msg)) {
    return UNREACHABLE_MESSAGE;
  }
  return msg;
}
