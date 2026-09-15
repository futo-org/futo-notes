//! The hosted service's own routes: capability discovery, the Login Hand-off,
//! and billing.
//!
//! These carry their own error type rather than [`HttpError`]. Two of them
//! answer in statuses that are outcomes and not failures at all — a hand-off
//! poll is `202` until the person finishes in the browser, and `404` once the
//! ticket is spent — and the one failure a hosted client must tell apart from
//! every other, an expired session, is a `401` carrying `invalid_session`.
//! Password mode has nothing like either, which is why this does not widen the
//! error the rest of the engine speaks.

use reqwest::Method;
use serde::Deserialize;

use super::{transport_error, Http, HttpError, PROBE_TIMEOUT};
use crate::hosted::{BillingStatus, Checkout, HostedError, HostedSession, SignInHandoff};

/// The two fields of the capability document that decide how to log in.
pub(crate) struct Capabilities {
    pub auth_mode: String,
    pub billing: bool,
}

/// One poll of a Login Hand-off ticket.
pub(crate) enum HandoffPoll {
    /// The person is still in the browser.
    Pending,
    /// Redeemed — and only once; the ticket is spent now.
    Session(HostedSession),
    /// Unknown, expired, already redeemed, or an identity the server turned
    /// away. The server answers all four alike on purpose, so polling cannot
    /// be used to discover whether a ticket exists.
    Gone,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
    code: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct UserBody {
    pub(crate) id: String,
    pub(crate) email: String,
    #[serde(default)]
    pub(crate) name: String,
}

#[derive(Deserialize)]
struct SessionBody {
    user: UserBody,
    token: String,
}

#[derive(Deserialize)]
struct PlanBody {
    storage_quota_bytes: u64,
    blob_max_bytes: u64,
}

#[derive(Deserialize)]
struct UsageBody {
    bytes_used: u64,
}

#[derive(Deserialize)]
struct BillingBody {
    entitled: bool,
    state: String,
    #[serde(default)]
    grace_until: Option<String>,
    plan: PlanBody,
    usage: UsageBody,
}

impl From<BillingBody> for BillingStatus {
    fn from(body: BillingBody) -> Self {
        Self {
            entitled: body.entitled,
            state: body.state,
            grace_until: body.grace_until,
            storage_quota_bytes: body.plan.storage_quota_bytes,
            blob_max_bytes: body.plan.blob_max_bytes,
            bytes_used: body.usage.bytes_used,
        }
    }
}

async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, HostedError> {
    request
        .send()
        .await
        .map_err(|error| HostedError::Network(transport_error(error).message))
}

/// Turns a refusal into the variant a shell acts on.
async fn refusal(response: reqwest::Response) -> HostedError {
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u32>().ok());
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<ErrorBody>(&body).ok();
    let code = parsed.as_ref().and_then(|body| body.code.as_deref());
    let message = parsed
        .as_ref()
        .and_then(|body| body.error.clone())
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| format!("HTTP {status}"));

    match status {
        // A hosted route is reached with a bearer token and nothing else, so
        // the only thing a 401 can mean is that the token is no longer good —
        // whether or not this server bothered to name the code. It is a trip
        // to the browser, never a vault reset.
        401 => HostedError::SignInAgain,
        // `invalid_session` on any other status would still be that.
        _ if code == Some("invalid_session") => HostedError::SignInAgain,
        // Every write on the hosted service is entitlement-gated, and the one
        // this client makes before a person has notes is the vault key.
        402 => HostedError::NotEntitled,
        404 => HostedError::NotHosted(message),
        429 => HostedError::RateLimited {
            retry_after_seconds: retry_after.unwrap_or(0),
        },
        _ => HostedError::Server(format!("HTTP {status}: {message}")),
    }
}

async fn json<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, HostedError> {
    let response = send(request).await?;
    if !response.status().is_success() {
        return Err(refusal(response).await);
    }
    response
        .json()
        .await
        .map_err(|error| HostedError::Server(transport_error(error).message))
}

impl Http {
    /// `GET /` — how to drive login on this deployment, and whether it sells
    /// subscriptions.
    pub(crate) async fn capabilities(&self) -> Result<Capabilities, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            auth_mode: String,
            #[serde(default)]
            billing: bool,
        }
        let body =
            Self::json::<Body>(self.request(Method::GET, "/").timeout(PROBE_TIMEOUT)).await?;
        Ok(Capabilities {
            auth_mode: body.auth_mode,
            billing: body.billing,
        })
    }

    /// `POST /api/auth/handoff` — takes no body and no credentials.
    pub(crate) async fn mint_handoff(&self) -> Result<SignInHandoff, HostedError> {
        #[derive(Deserialize)]
        struct Body {
            ticket: String,
            url: String,
        }
        let body = json::<Body>(self.request(Method::POST, "/api/auth/handoff")).await?;
        Ok(SignInHandoff {
            url: body.url,
            ticket: body.ticket,
        })
    }

    /// `GET /api/auth/handoff/{ticket}` — the ticket is the credential.
    pub(crate) async fn redeem_handoff(&self, ticket: &str) -> Result<HandoffPoll, HostedError> {
        let path = format!("/api/auth/handoff/{}", urlencoding(ticket));
        let response = send(self.request(Method::GET, &path)).await?;
        match response.status().as_u16() {
            202 => Ok(HandoffPoll::Pending),
            404 => Ok(HandoffPoll::Gone),
            status if (200..300).contains(&status) => {
                let body: SessionBody = response
                    .json()
                    .await
                    .map_err(|error| HostedError::Server(transport_error(error).message))?;
                Ok(HandoffPoll::Session(HostedSession {
                    user_id: body.user.id,
                    email: body.user.email,
                    name: body.user.name,
                    token: body.token,
                }))
            }
            _ => Err(refusal(response).await),
        }
    }

    /// `GET /api/billing`.
    pub(crate) async fn billing(&self) -> Result<BillingStatus, HostedError> {
        Ok(
            json::<BillingBody>(self.request(Method::GET, "/api/billing"))
                .await?
                .into(),
        )
    }

    /// `POST /api/billing/checkout`. Answers with a URL to open, or — for an
    /// account that may already write — with the billing status itself.
    /// The presence of `url` is the contract's own way of telling them apart.
    pub(crate) async fn checkout(&self) -> Result<Checkout, HostedError> {
        let body =
            json::<serde_json::Value>(self.request(Method::POST, "/api/billing/checkout")).await?;
        if let Some(url) = body
            .get("url")
            .and_then(serde_json::Value::as_str)
            .filter(|url| !url.is_empty())
        {
            return Ok(Checkout::Open {
                url: url.to_owned(),
            });
        }
        let billing: BillingBody = serde_json::from_value(body).map_err(|error| {
            HostedError::Server(format!(
                "checkout answered with neither a URL nor a billing status: {error}"
            ))
        })?;
        Ok(Checkout::AlreadyEntitled(billing.into()))
    }

    /// `GET /api/billing/portal`. The payment provider's own customer portal,
    /// as a one-shot URL to open in a browser. Invoices, cancellation, and
    /// cards live there and nowhere in this app (ADR 0003, decision 8).
    pub(crate) async fn billing_portal(&self) -> Result<String, HostedError> {
        #[derive(Deserialize)]
        struct Body {
            url: String,
        }
        Ok(
            json::<Body>(self.request(Method::GET, "/api/billing/portal"))
                .await?
                .url,
        )
    }
}

/// Turns the engine's own transport failure into the hosted vocabulary, for
/// the routes the hosted flow shares with password mode: claiming the
/// collection, and reading and writing the vault key material. Those are one
/// implementation used by both modes — only what a refusal *means* differs,
/// which is what this says.
pub(crate) fn hosted_error(error: HttpError) -> HostedError {
    match error.status {
        Some(401) => HostedError::SignInAgain,
        // Writing the vault key is entitlement-gated; this is the refusal a
        // fresh account meets before it has subscribed.
        Some(402) => HostedError::NotEntitled,
        Some(404) => HostedError::NotHosted(error.message),
        Some(status) => HostedError::Server(format!("HTTP {status}: {}", error.message)),
        // No status at all is a transport failure: nothing reached the server.
        None => HostedError::Network(error.message),
    }
}

impl Http {
    /// `GET /api/auth` — who this token belongs to. `Ok(None)` is a token the
    /// server no longer accepts, which on a cold start is an ordinary fact
    /// about a device that sat idle rather than a failure to report.
    pub(crate) async fn current_user(&self) -> Result<Option<UserBody>, HostedError> {
        #[derive(Deserialize)]
        struct Body {
            user: UserBody,
        }
        let response = send(self.request(Method::GET, "/api/auth")).await?;
        if response.status().as_u16() == 401 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(refusal(response).await);
        }
        let body: Body = response
            .json()
            .await
            .map_err(|error| HostedError::Server(transport_error(error).message))?;
        Ok(Some(body.user))
    }

    /// `POST /api/auth/logout` — destroys this session server-side. It answers
    /// `204`, so there is no body to read.
    pub(crate) async fn logout(&self) -> Result<(), HostedError> {
        let response = send(self.request(Method::POST, "/api/auth/logout")).await?;
        if response.status().is_success() {
            return Ok(());
        }
        Err(refusal(response).await)
    }
}

/// The ticket is base64url from the server, but it reaches us as a string a
/// caller could have mangled; percent-encode anything that is not already safe
/// in a path segment rather than splicing it in raw.
fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_path_segments_are_percent_encoded() {
        assert_eq!(urlencoding("A-Za_z0.9~"), "A-Za_z0.9~");
        assert_eq!(urlencoding("a/b?c#d"), "a%2Fb%3Fc%23d");
    }

    /// Pinned against the body a real stand-in server answered with, numbers
    /// and `null` grace date included.
    #[test]
    fn the_billing_body_parses_field_for_field() {
        let body: BillingBody = serde_json::from_str(
            r#"{"entitled":true,"grace_until":null,
                "plan":{"storage_quota_bytes":10000000000,"blob_max_bytes":104857600},
                "state":"active","usage":{"bytes_used":42}}"#,
        )
        .unwrap();
        let billing = BillingStatus::from(body);
        assert!(billing.entitled);
        assert_eq!(billing.state, "active");
        assert_eq!(billing.grace_until, None);
        assert_eq!(billing.bytes_used, 42);
        assert_eq!(billing.storage_quota_bytes, 10_000_000_000);
        assert_eq!(billing.blob_max_bytes, 104_857_600);
    }

    #[test]
    fn a_past_due_account_carries_the_date_its_grace_period_ends() {
        let body: BillingBody = serde_json::from_str(
            r#"{"entitled":true,"grace_until":"2026-09-22T00:00:00Z",
                "plan":{"storage_quota_bytes":1,"blob_max_bytes":1},
                "state":"past_due","usage":{"bytes_used":0}}"#,
        )
        .unwrap();
        assert_eq!(
            BillingStatus::from(body).grace_until.as_deref(),
            Some("2026-09-22T00:00:00Z")
        );
    }
}
