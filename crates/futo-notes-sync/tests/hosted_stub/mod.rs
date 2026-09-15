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

use serde_json::json;
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

/// The one identity a stand-in server signs everybody in as.
pub const STANDIN_EMAIL: &str = "person@standin.test";

const STORAGE_QUOTA_BYTES: u64 = 10_000_000_000;
const BLOB_MAX_BYTES: u64 = 104_857_600;

#[derive(PartialEq)]
enum Ticket {
    /// Minted; the person has not finished in the browser.
    Claimable,
    /// The browser came back; the next poll redeems it.
    Fulfilled,
}

struct State {
    base: String,
    next: u64,
    /// A spent ticket is removed, not kept: unknown, expired, redeemed, and
    /// refused are one answer on this contract.
    tickets: HashMap<String, Ticket>,
    tokens: Vec<String>,
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
            tokens: Vec::new(),
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

impl Respond for Router {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let mut state = self.0.lock().expect("stub state");
        let method = request.method.as_str();
        let path = request.url.path().to_owned();
        let query: HashMap<_, _> = request.url.query_pairs().into_owned().collect();

        let authorised = |state: &State| {
            bearer(request)
                .map(|token| state.tokens.contains(&token))
                .unwrap_or(false)
        };

        match (method, path.as_str()) {
            ("GET", "/") => json_response(
                200,
                json!({
                    "name": "futo-notes",
                    "version": "stub",
                    "auth_mode": "oidc",
                    "signup": "open",
                    "billing": true,
                    "mutation_ids": {
                        "supported": true,
                        "required": false,
                        "retention_days": 30,
                        "successful_create_outcomes": "durable",
                    },
                }),
            ),

            // Takes no body and no credentials.
            ("POST", "/api/auth/handoff") => {
                let ticket = state.id("ticket-");
                let url = format!("{}/api/auth/oidc/start?ticket={ticket}", state.base);
                state.tickets.insert(ticket.clone(), Ticket::Claimable);
                json_response(200, json!({ "ticket": ticket, "url": url }))
            }

            // What a browser opening the hand-off URL amounts to: the stand-in
            // issuer auto-approves, so one request finishes the login.
            ("GET", "/api/auth/oidc/start") => match query.get("ticket") {
                Some(ticket) if state.tickets.contains_key(ticket) => {
                    state.tickets.insert(ticket.clone(), Ticket::Fulfilled);
                    ResponseTemplate::new(200).set_body_string("You can go back to the app.")
                }
                _ => not_found(),
            },

            ("GET", path) if path.starts_with("/api/auth/handoff/") => {
                let ticket = path.trim_start_matches("/api/auth/handoff/").to_owned();
                match state.tickets.get(&ticket) {
                    None => not_found(),
                    Some(Ticket::Claimable) => ResponseTemplate::new(202),
                    Some(Ticket::Fulfilled) => {
                        state.tickets.remove(&ticket);
                        let token = state.id("token-");
                        state.tokens.push(token.clone());
                        json_response(
                            200,
                            json!({
                                "token": token,
                                "user": {
                                    "id": "01a0a6a5-d217-736a-8116-d2ad1914f788",
                                    "email": STANDIN_EMAIL,
                                    "name": "Stand-in Person",
                                },
                            }),
                        )
                    }
                }
            }

            // Who this token belongs to — what a device with a saved token
            // asks on a cold start before deciding which step to show.
            ("GET", "/api/auth") if authorised(&state) => json_response(
                200,
                json!({
                    "user": {
                        "id": "01a0a6a5-d217-736a-8116-d2ad1914f788",
                        "email": STANDIN_EMAIL,
                        "name": "Stand-in Person",
                    },
                }),
            ),

            ("POST", "/api/auth/logout") if authorised(&state) => {
                if let Some(token) = bearer(request) {
                    state.tokens.retain(|held| held != &token);
                }
                ResponseTemplate::new(204)
            }

            // One vault per account: idempotent, `201` the first time and
            // `200` with the same vault afterwards, so two devices setting up
            // at once converge instead of forking. Not entitlement-gated — an
            // account that has not paid still has to find its collection.
            ("POST", "/api/collections") if authorised(&state) => {
                let (status, id) = match state.collection.clone() {
                    Some(id) => (200, id),
                    None => {
                        let id = state.id("collection-");
                        state.collection = Some(id.clone());
                        (201, id)
                    }
                };
                json_response(
                    status,
                    json!({ "collection": { "id": id, "current_version": "0" } }),
                )
            }

            ("GET", path)
                if authorised(&state)
                    && path.starts_with("/api/collections/")
                    && path.ends_with("/key") =>
            {
                if state.collection.as_deref() != Some(collection_of(path)) {
                    return not_found();
                }
                key_response(state.key.as_ref())
            }

            // Entitlement-gated, which is what makes the subscribe step
            // unskippable in the no-vault shape.
            ("PUT", path)
                if authorised(&state)
                    && path.starts_with("/api/collections/")
                    && path.ends_with("/key") =>
            {
                if state.collection.as_deref() != Some(collection_of(path)) {
                    return not_found();
                }
                if !state.entitled {
                    return subscription_required();
                }
                let Some(sent) = request.body_json::<serde_json::Value>().ok() else {
                    return json_response(400, json!({ "error": "invalid body" }));
                };
                match put_key(&mut state, &sent) {
                    Ok(()) => key_response(state.key.as_ref()),
                    Err(response) => *response,
                }
            }

            // Resets the account to the no-vault shape. Entitlement-gated on
            // the real server, so the scenarios subscribe before using it.
            ("DELETE", path)
                if authorised(&state)
                    && path.starts_with("/api/collections/")
                    && !path.ends_with("/key") =>
            {
                if state.collection.as_deref() != Some(path.trim_start_matches("/api/collections/"))
                {
                    return not_found();
                }
                if !state.entitled {
                    return subscription_required();
                }
                state.collection = None;
                state.key = None;
                ResponseTemplate::new(204)
            }

            ("GET", "/api/billing") if authorised(&state) => json_response(200, state.billing()),

            ("POST", "/api/billing/checkout") if authorised(&state) => {
                if state.entitled {
                    // Sending an entitled account to pay again would open a
                    // second subscription, so it gets its status instead.
                    return json_response(200, state.billing());
                }
                let checkout = state.id("checkout-");
                let url = format!("{}/standin/checkout/{checkout}", state.base);
                state.checkouts.push(checkout);
                json_response(200, json!({ "url": url }))
            }

            // Fetching a stand-in checkout URL delivers the subscription event
            // and only then answers, so the account is entitled by the time
            // the fetch returns.
            ("GET", path) if path.starts_with("/standin/checkout/") => {
                let checkout = path.trim_start_matches("/standin/checkout/").to_owned();
                if !state.checkouts.contains(&checkout) {
                    return not_found();
                }
                state.entitled = true;
                state.subscription_state = "active".to_owned();
                ResponseTemplate::new(200).set_body_string("Thanks — you can go back to the app.")
            }

            // The payment provider's customer portal, minted per press.
            ("GET", "/api/billing/portal") if authorised(&state) => {
                let portal = state.id("portal-");
                json_response(
                    200,
                    json!({ "url": format!("{}/standin/portal/{portal}", state.base) }),
                )
            }

            ("POST", "/standin/lapse") if authorised(&state) => {
                state.entitled = false;
                state.subscription_state = "canceled".to_owned();
                json_response(200, json!({ "status": "applied" }))
            }

            ("POST", "/standin/quota") if authorised(&state) => {
                state.quota = state.bytes_used;
                json_response(200, json!({ "status": "applied" }))
            }

            // Every hosted route needs a session; anything reaching here with
            // a bad one gets the refusal a real server sends.
            ("GET", "/api/auth")
            | ("POST", "/api/auth/logout")
            | ("POST", "/api/collections")
            | ("GET", "/api/billing")
            | ("POST", "/api/billing/checkout")
            | ("GET", "/api/billing/portal")
            | ("POST", "/standin/lapse")
            | ("POST", "/standin/quota") => invalid_session(),
            (_, path) if path.starts_with("/api/collections/") => invalid_session(),

            _ => not_found(),
        }
    }
}
