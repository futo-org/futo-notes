//! An in-test stand-in for the sync server's hosted routes.
//!
//! It exists because CI has no Go toolchain and `scripts/sync-server-pin.json`
//! downloads *released* server binaries — the newest tag predates the hosted
//! service — so until the pin bumps (#185) this is the only hosted server a
//! CI run can reach. Every scenario in `hosted_scenarios` runs against this by
//! default and against a real server when `FUTO_TEST_SERVER` points at one, so
//! the two are held to the same assertions.
//!
//! It is written to `futo-notes-server/docs/API.md` and `docs/openapi.yaml`,
//! and its two `/standin/*` routes are named after the real server's stand-in
//! test mode (its ADR 0009) so the scenarios do not have to know which one
//! they are talking to.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

mod router;

/// The one identity a stand-in server signs everybody in as.
pub const STANDIN_EMAIL: &str = "person@standin.test";

/// The account every hand-off signs in as, and the one `/standin/second-identity`
/// mints instead. A real stand-in server has exactly one identity, so the second
/// exists only for the scenarios that have to prove an account cannot reach
/// another account's pairing — those run against this stub alone.
const STANDIN_USER: &str = "01a0a6a5-d217-736a-8116-d2ad1914f788";
const OTHER_USER: &str = "01a0a6a5-d217-736a-8116-d2ad1914f789";
const OTHER_EMAIL: &str = "somebody-else@standin.test";

const STORAGE_QUOTA_BYTES: u64 = 10_000_000_000;
const BLOB_MAX_BYTES: u64 = 104_857_600;

#[derive(PartialEq)]
enum Ticket {
    /// Minted; the person has not finished in the browser.
    Claimable,
    /// The browser came back; the next poll redeems it.
    Fulfilled,
}

/// One open pairing on the relay.
struct Pairing {
    /// Which account opened it. A pairing another account asks about is a
    /// `404`, byte for byte the one an unknown id gets.
    owner: String,
    /// Set by the one `POST .../key` this pairing accepts.
    ciphertext: Option<String>,
    /// Enforced when the row is read, exactly as the real relay does, so an
    /// expired pairing is unreachable rather than merely stale.
    expires_at: time::OffsetDateTime,
}

struct State {
    base: String,
    next: u64,
    /// A spent ticket is removed, not kept: unknown, expired, redeemed, and
    /// refused are one answer on this contract.
    tickets: HashMap<String, Ticket>,
    /// Token to the account it signs in as. One identity comes out of the
    /// hand-off, the way a stand-in server has one; `/standin/second-identity`
    /// mints the other, which exists only so a scenario can own a pairing this
    /// account must not be able to reach.
    tokens: HashMap<String, String>,
    pairings: HashMap<String, Pairing>,
    /// How long a pairing this stub opens lives. Five minutes like the real
    /// relay; `/standin/pairing-window` shortens it so the expiry scenario
    /// does not have to wait out a real one.
    pairing_window: Duration,
    checkouts: Vec<String>,
    entitled: bool,
    subscription_state: String,
    bytes_used: u64,
    quota: u64,
    /// One vault per account (`POST /api/collections` is idempotent), so one
    /// id and at most one key material.
    collection: Option<String>,
    key: Option<serde_json::Value>,
}

impl State {
    fn id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}{}", self.next)
    }

    fn billing(&self) -> serde_json::Value {
        json!({
            "entitled": self.entitled,
            "state": self.subscription_state,
            "grace_until": serde_json::Value::Null,
            "plan": {
                "storage_quota_bytes": self.quota,
                "blob_max_bytes": BLOB_MAX_BYTES,
            },
            "usage": { "bytes_used": self.bytes_used },
        })
    }
}

/// A running stub. Dropping it stops the server.
pub struct HostedStub {
    server: MockServer,
}

impl HostedStub {
    pub async fn start() -> Self {
        let server = MockServer::start().await;
        let state = Arc::new(Mutex::new(State {
            base: server.uri().trim_end_matches('/').to_owned(),
            next: 0,
            tickets: HashMap::new(),
            tokens: HashMap::new(),
            pairings: HashMap::new(),
            pairing_window: Duration::from_secs(300),
            checkouts: Vec::new(),
            entitled: false,
            subscription_state: "none".to_owned(),
            bytes_used: 0,
            quota: STORAGE_QUOTA_BYTES,
            collection: None,
            key: None,
        }));
        Mock::given(wiremock::matchers::any())
            .respond_with(Router(state))
            .mount(&server)
            .await;
        Self { server }
    }

    pub fn url(&self) -> String {
        self.server.uri().trim_end_matches('/').to_owned()
    }
}

struct Router(Arc<Mutex<State>>);

fn json_response(status: u16, body: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(body)
}

fn not_found() -> ResponseTemplate {
    json_response(404, json!({ "error": "not found" }))
}

/// The refusal an entitlement-gated write gets from an account that may not
/// write — `PUT .../key` is one, which is why a fresh account cannot skip the
/// subscribe step.
fn subscription_required() -> ResponseTemplate {
    json_response(
        402,
        json!({
            "error": "an active subscription is required to write",
            "code": "subscription_required",
        }),
    )
}

/// `GET .../key` always answers with all three recovery fields, `null` and
/// all, so a client can tell "no recovery envelope" from "old server".
fn key_response(stored: Option<&serde_json::Value>) -> ResponseTemplate {
    let Some(stored) = stored else {
        return json_response(200, json!({ "key": serde_json::Value::Null }));
    };
    let mut key = stored.clone();
    if let Some(object) = key.as_object_mut() {
        for field in [
            "recovery_key_salt",
            "recovery_key_kdf",
            "recovery_encrypted_vault_key",
        ] {
            object.entry(field).or_insert(serde_json::Value::Null);
        }
    }
    json_response(200, json!({ "key": key }))
}

/// The server's own refusal for a token it does not accept, `code` and all.
fn invalid_session() -> ResponseTemplate {
    ResponseTemplate::new(401)
        .insert_header(
            "www-authenticate",
            r#"Bearer realm="futo-notes", error="invalid_token""#,
        )
        .set_body_json(json!({
            "code": "invalid_session",
            "error": "session expired or invalid",
        }))
}

fn bearer(request: &Request) -> Option<String> {
    request
        .headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_owned)
}

/// The id out of `/api/collections/{id}/key`.
fn collection_of(path: &str) -> &str {
    path.trim_start_matches("/api/collections/")
        .trim_end_matches("/key")
}

/// Stores what a `PUT` sent, holding the two rules of server ADR 0006: the
/// three recovery fields arrive together or not at all, and the write replaces
/// the whole of the key material rather than patching one envelope.
///
/// A claim carrying no revision token never overwrites: it answers with the
/// authoritative material, which is the one already stored. A re-wrap carries
/// `previous_key_updated_at` and lands only if it still matches.
fn put_key(state: &mut State, sent: &serde_json::Value) -> Result<(), Box<ResponseTemplate>> {
    let present = |field: &str| sent.get(field).is_some_and(|value| !value.is_null());
    let recovery = [
        "recovery_key_salt",
        "recovery_key_kdf",
        "recovery_encrypted_vault_key",
    ]
    .into_iter()
    .filter(|field| present(field))
    .count();
    if recovery != 0 && recovery != 3 {
        return Err(Box::new(json_response(
            400,
            json!({ "error": "the recovery envelope needs all three fields or none" }),
        )));
    }
    for field in ["key_salt", "key_kdf", "encrypted_vault_key"] {
        if !present(field) {
            return Err(Box::new(json_response(
                400,
                json!({ "error": "invalid body" }),
            )));
        }
    }

    let previous = sent
        .get("previous_key_updated_at")
        .and_then(serde_json::Value::as_str);
    let stored = state
        .key
        .as_ref()
        .and_then(|key| key.get("key_updated_at"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    match (previous, stored.as_deref()) {
        // A first claim against material that already exists is not a
        // conflict: the winner's key is never overwritten.
        (None, Some(_)) => return Ok(()),
        (Some(sent), current) if Some(sent) != current => {
            return Err(Box::new(json_response(
                409,
                json!({ "error": "key conflict", "currentKey": state.key }),
            )))
        }
        _ => {}
    }

    state.next += 1;
    let revision = format!("2026-09-15T00:00:0{}Z", state.next % 10);
    let mut key = sent.clone();
    if let Some(object) = key.as_object_mut() {
        object.remove("previous_key_updated_at");
        object.insert("key_updated_at".to_owned(), json!(revision));
    }
    state.key = Some(key);
    Ok(())
}
