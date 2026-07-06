const UNREACHABLE_MESSAGE = "Could not reach server — check the URL and make sure it's running";

/**
 * Desktop sync goes through Tauri `invoke()` → Rust reqwest, which rejects
 * with the PLAIN STRING Display of the Rust error, not a TypeError. Transport
 * failures surface as `E2eeHttpError::Transport` → "transport error: {reqwest}"
 * (crates/futo-notes-sync/src/client.rs), where the reqwest part reads like
 * "error sending request for url (…)", "error trying to connect: … Connection
 * refused …", "dns error: …", or "operation timed out".
 *
 * Keep this narrowly scoped to network-layer wording: real server responses
 * ("HTTP 401: …" bodies, "invalid password", …) must surface verbatim.
 */
const RUST_TRANSPORT_ERROR =
  /^transport error:|error sending request|error trying to connect|connection refused|dns error|operation timed out|network is unreachable/i;

/**
 * Human-readable message for a sync failure. `fetch` throws opaque
 * `TypeError`s when the server is unreachable, and the desktop invoke() path
 * rejects with equally opaque Rust reqwest strings — rewrite both to
 * something a user can act on (sync.md). Everything else (real HTTP error
 * bodies, auth/crypto errors) passes through verbatim.
 */
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
