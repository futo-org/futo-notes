//! The stub's one route table: every hosted request a scenario can make, and
//! what the stand-in server answers.

use super::*;

impl Respond for Router {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let mut state = self.0.lock().expect("stub state");
        let method = request.method.as_str();
        let path = request.url.path().to_owned();
        let query: HashMap<_, _> = request.url.query_pairs().into_owned().collect();

        let account =
            |state: &State| bearer(request).and_then(|token| state.tokens.get(&token).cloned());
        let authorised = |state: &State| account(state).is_some();

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
                        state.tokens.insert(token.clone(), STANDIN_USER.to_owned());
                        json_response(
                            200,
                            json!({
                                "token": token,
                                "user": {
                                    "id": STANDIN_USER,
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
            ("GET", "/api/auth") if authorised(&state) => {
                let user = account(&state).expect("an authorized request has an account");
                let (email, name) = if user == OTHER_USER {
                    (OTHER_EMAIL, "Somebody Else")
                } else {
                    (STANDIN_EMAIL, "Stand-in Person")
                };
                json_response(
                    200,
                    json!({ "user": { "id": user, "email": email, "name": name } }),
                )
            }

            ("POST", "/api/auth/logout") if authorised(&state) => {
                if let Some(token) = bearer(request) {
                    state.tokens.remove(&token);
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

            // ── The pairing relay (server ADR 0008) ──
            //
            // Authenticated, account-scoped, and NOT entitlement-gated: a
            // lapsed subscriber still has to be able to set up a device to
            // read what they already stored.
            ("POST", "/api/pairings") if authorised(&state) => {
                let owner = account(&state).expect("an authorized request has an account");
                let Some(sent) = request.body_json::<serde_json::Value>().ok() else {
                    return json_response(400, json!({ "error": "invalid json" }));
                };
                for field in ["public_key", "device_name", "platform"] {
                    match sent.get(field).and_then(serde_json::Value::as_str) {
                        None | Some("") => {
                            return json_response(
                                400,
                                json!({ "error": format!("{field} is required") }),
                            )
                        }
                        Some(value) if value.len() > 1024 => {
                            return json_response(
                                400,
                                json!({ "error": format!("{field} is too long") }),
                            )
                        }
                        Some(_) => {}
                    }
                }
                let id = state.id("pairing-");
                let expires_at = time::OffsetDateTime::now_utc() + state.pairing_window;
                state.pairings.insert(
                    id.clone(),
                    Pairing {
                        owner,
                        ciphertext: None,
                        expires_at,
                    },
                );
                json_response(
                    201,
                    json!({
                        "id": id,
                        "expires_at": expires_at
                            .format(&time::format_description::well_known::Rfc3339)
                            .expect("format an expiry"),
                    }),
                )
            }

            // One key per pairing. A stranger's post is refused as 404 before
            // the pairing's state is consulted, so the 409 that tells the
            // owner "somebody already answered this" tells a stranger nothing.
            ("POST", path)
                if authorised(&state)
                    && path.starts_with("/api/pairings/")
                    && path.ends_with("/key") =>
            {
                let owner = account(&state).expect("an authorized request has an account");
                let id = path
                    .trim_start_matches("/api/pairings/")
                    .trim_end_matches("/key")
                    .to_owned();
                let Some(sent) = request.body_json::<serde_json::Value>().ok() else {
                    return json_response(400, json!({ "error": "invalid json" }));
                };
                let Some(ciphertext) = sent
                    .get("ciphertext")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty() && value.len() <= 1024)
                else {
                    return json_response(400, json!({ "error": "ciphertext is required" }));
                };
                let ciphertext = ciphertext.to_owned();
                let now = time::OffsetDateTime::now_utc();
                match state.pairings.get_mut(&id) {
                    Some(pairing) if pairing.owner == owner && pairing.expires_at > now => {
                        if pairing.ciphertext.is_some() {
                            return json_response(
                                409,
                                json!({ "error": "pairing already has a key" }),
                            );
                        }
                        pairing.ciphertext = Some(ciphertext);
                        ResponseTemplate::new(204)
                    }
                    _ => not_found(),
                }
            }

            // Collecting spends the pairing: the poll that returns the
            // ciphertext deletes the row in the same breath, so a second poll
            // is a 404 rather than a replay.
            ("GET", path) if authorised(&state) && path.starts_with("/api/pairings/") => {
                let owner = account(&state).expect("an authorized request has an account");
                let id = path.trim_start_matches("/api/pairings/").to_owned();
                let now = time::OffsetDateTime::now_utc();
                match state.pairings.get(&id) {
                    Some(pairing) if pairing.owner == owner && pairing.expires_at > now => {
                        match pairing.ciphertext.clone() {
                            None => ResponseTemplate::new(202),
                            Some(ciphertext) => {
                                state.pairings.remove(&id);
                                json_response(200, json!({ "ciphertext": ciphertext }))
                            }
                        }
                    }
                    _ => not_found(),
                }
            }

            // Stub-only. A real stand-in server has one identity and a fixed
            // five-minute window, so the two scenarios these serve — another
            // account's live pairing, and an expiry reached inside a test —
            // run against this stub alone.
            ("POST", "/standin/second-identity") => {
                let token = state.id("token-");
                state.tokens.insert(token.clone(), OTHER_USER.to_owned());
                json_response(200, json!({ "token": token }))
            }

            ("POST", "/standin/pairing-window") if authorised(&state) => {
                let seconds = request
                    .body_json::<serde_json::Value>()
                    .ok()
                    .and_then(|body| body.get("seconds").and_then(serde_json::Value::as_u64))
                    .unwrap_or(300);
                state.pairing_window = Duration::from_secs(seconds);
                json_response(200, json!({ "status": "applied" }))
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
            | ("POST", "/api/pairings")
            | ("POST", "/standin/lapse")
            | ("POST", "/standin/quota")
            | ("POST", "/standin/pairing-window") => invalid_session(),
            (_, path) if path.starts_with("/api/collections/") => invalid_session(),
            (_, path) if path.starts_with("/api/pairings/") => invalid_session(),

            _ => not_found(),
        }
    }
}
