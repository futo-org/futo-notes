//! HTTP client for the FUTO Notes E2EE sync protocol.
//!
//! One method per endpoint; conflict (409) responses surface as `Conflict`
//! variants on `PutResult` / `DeleteResult` so callers can pattern-match.
//! Wire shapes match the TS path in `src/lib/syncServiceE2ee.ts` exactly so
//! clients on either side can interoperate.

use std::time::Duration;

use futo_notes_core::e2ee::KeyMaterial;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

// ── Errors ───────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum E2eeHttpError {
    #[error("invalid base URL: {0}")]
    BadUrl(#[from] url::ParseError),
    #[error("transport error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("invalid auth token (could not build header)")]
    BadToken,
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("server returned non-JSON body: {0}")]
    InvalidJson(String),
    #[error("invalid password")]
    BadPassword,
    #[error("missing field in response: {0}")]
    MissingField(&'static str),
}

impl E2eeHttpError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Http { status: 401, .. })
    }
}

// ── Wire types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct ServerCapabilities {
    #[serde(default)]
    auth_mode: Option<String>,
}

/// Server capability advertised at `GET /`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    Password,
    Dev,
}

impl AuthMode {
    fn from_str(s: &str) -> Self {
        if s == "dev" {
            Self::Dev
        } else {
            Self::Password
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct DevLoginBody<'a> {
    email: &'a str,
    name: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct PasswordLoginBody<'a> {
    password: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
struct LoginResponse {
    user: LoginUser,
    token: String,
}

#[derive(Debug, Clone, Deserialize)]
struct LoginUser {
    id: String,
}

/// Successful login. `user_id` is the server-assigned user identifier;
/// `token` is the bearer to use on every subsequent authenticated call.
#[derive(Debug, Clone)]
pub struct LoginOk {
    pub user_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CollectionListResponse {
    collections: Vec<CollectionRef>,
}

#[derive(Debug, Clone, Deserialize)]
struct CollectionRef {
    id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CreateCollectionResponse {
    collection: CollectionRef,
}

#[derive(Debug, Clone, Deserialize)]
struct KeyMaterialResponse {
    #[serde(default)]
    key: Option<KeyMaterial>,
}

#[derive(Debug, Clone, Serialize)]
struct PutKeyMaterialBody<'a> {
    key_salt: &'a str,
    key_kdf: &'a futo_notes_core::e2ee::KeyKdf,
    encrypted_vault_key: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
struct PutKeyMaterialResponse {
    key: KeyMaterial,
}

/// One server-side object. `version` and `change_seq` arrive as either
/// numbers or numeric strings depending on whether the server's JSON
/// pipeline serialized them as BigInt; both shapes are accepted.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerObject {
    pub id: String,
    pub collection_id: String,
    #[serde(deserialize_with = "de_u64_lenient")]
    pub version: u64,
    #[serde(deserialize_with = "de_u64_lenient")]
    pub change_seq: u64,
    pub deleted: bool,
    #[serde(default)]
    pub blob_key: Option<String>,
    #[serde(default, deserialize_with = "de_opt_u64_lenient")]
    pub size_bytes: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ListObjectsResponse {
    objects: Vec<ServerObject>,
}

/// Successful create or update of a blob-backed object.
#[derive(Debug, Clone)]
pub struct ObjectWriteResponse {
    pub object_id: String,
    pub version: u64,
    pub change_seq: u64,
    pub blob_key: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct ObjectWriteWire {
    object: ObjectWriteObject,
    // The server emits `collectionVersion` at the top level even though the
    // nested `object` uses snake_case fields — match that mixed wire shape.
    #[serde(rename = "collectionVersion", default, deserialize_with = "de_opt_u64_lenient")]
    collection_version: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ObjectWriteObject {
    id: String,
    #[serde(deserialize_with = "de_u64_lenient")]
    version: u64,
    #[serde(default, deserialize_with = "de_opt_u64_lenient")]
    change_seq: Option<u64>,
    #[serde(default)]
    updated_at: Option<String>,
    // DELETE responses don't include `blob_key` (the blob is already
    // orphaned), so make it optional. POST/PUT paths still require it —
    // see `wire_to_write_response`.
    #[serde(default)]
    blob_key: Option<String>,
}

/// 409 conflict body returned by PUT / DELETE on version mismatch. The
/// server emits camelCase on the wire (`currentVersion`, `currentBlobKey`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResponse {
    #[allow(dead_code)]
    pub error: String,
    #[serde(deserialize_with = "de_u64_lenient")]
    pub current_version: u64,
    #[serde(default)]
    pub current_blob_key: Option<String>,
}

/// Outcome of an update PUT.
#[derive(Debug)]
pub enum PutResult {
    Ok(ObjectWriteResponse),
    Conflict(ConflictResponse),
}

/// Outcome of a delete.
#[derive(Debug)]
pub enum DeleteResult {
    Ok(ObjectWriteOk),
    Conflict(ConflictResponse),
}

/// Bookkeeping returned by a successful delete — version + change_seq stamps.
#[derive(Debug, Clone)]
pub struct ObjectWriteOk {
    pub version: u64,
    pub change_seq: u64,
}

// ── Lenient u64 deserialization (server sends either number or string) ──

fn de_u64_lenient<'de, D>(d: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| D::Error::custom("expected u64 number")),
        serde_json::Value::String(s) => s.parse::<u64>().map_err(D::Error::custom),
        other => Err(D::Error::custom(format!("expected u64, got {other:?}"))),
    }
}

fn de_opt_u64_lenient<'de, D>(d: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::Number(n) => Ok(n.as_u64()),
        serde_json::Value::String(s) => s.parse::<u64>().map(Some).map_err(D::Error::custom),
        other => Err(D::Error::custom(format!("expected u64|null, got {other:?}"))),
    }
}

// ── Client ───────────────────────────────────────────────────────────────

/// Stateless-ish HTTP wrapper. One instance per connected session: holds
/// the base URL, the bearer token (after login), and a shared
/// `reqwest::Client` so HTTPS + connection pooling are reused.
#[derive(Clone)]
pub struct E2eeClient {
    base_url: Url,
    token: Option<String>,
    http: Client,
}

impl E2eeClient {
    /// Build a fresh client. `base_url` is e.g. `https://sync.example.com`
    /// or `http://127.0.0.1:3100` — no trailing slash required.
    pub fn new(base_url: &str) -> Result<Self, E2eeHttpError> {
        let mut url = base_url.to_owned();
        if !url.ends_with('/') {
            url.push('/');
        }
        let base_url = Url::parse(&url)?;
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(E2eeHttpError::Transport)?;
        Ok(Self {
            base_url,
            token: None,
            http,
        })
    }

    pub fn set_token(&mut self, token: impl Into<String>) {
        self.token = Some(token.into());
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn base_url(&self) -> &str {
        self.base_url.as_str()
    }

    fn join(&self, path: &str) -> Result<Url, E2eeHttpError> {
        // strip a leading slash so url::Url::join produces base + path,
        // not an absolute-path replacement.
        let trimmed = path.trim_start_matches('/');
        self.base_url.join(trimmed).map_err(E2eeHttpError::BadUrl)
    }

    fn auth_header(&self) -> Result<HeaderMap, E2eeHttpError> {
        let mut h = HeaderMap::new();
        if let Some(tok) = &self.token {
            let val = HeaderValue::from_str(&format!("Bearer {tok}"))
                .map_err(|_| E2eeHttpError::BadToken)?;
            h.insert(AUTHORIZATION, val);
        }
        Ok(h)
    }

    // ── Endpoint 1: GET / (probe) ──

    pub async fn probe_auth_mode(&self) -> AuthMode {
        let url = match self.join("") {
            Ok(u) => u,
            Err(_) => return AuthMode::Password,
        };
        let req = self.http.get(url).timeout(PROBE_TIMEOUT).build();
        let req = match req {
            Ok(r) => r,
            Err(_) => return AuthMode::Password,
        };
        let res = match self.http.execute(req).await {
            Ok(r) => r,
            Err(_) => return AuthMode::Password,
        };
        if !res.status().is_success() {
            return AuthMode::Password;
        }
        match res.json::<ServerCapabilities>().await {
            Ok(caps) => AuthMode::from_str(caps.auth_mode.as_deref().unwrap_or("password")),
            Err(_) => AuthMode::Password,
        }
    }

    // ── Endpoint 2: POST /api/auth/dev/login ──

    pub async fn login_dev(&self, email: &str, name: &str) -> Result<LoginOk, E2eeHttpError> {
        let url = self.join("api/auth/dev/login")?;
        let res = self
            .http
            .post(url)
            .json(&DevLoginBody { email, name })
            .send()
            .await?;
        let parsed: LoginResponse = parse_json_or_http(res).await?;
        Ok(LoginOk {
            user_id: parsed.user.id,
            token: parsed.token,
        })
    }

    // ── Endpoint 3: POST /api/auth/password/login ──

    pub async fn login_password(&self, password: &str) -> Result<LoginOk, E2eeHttpError> {
        let url = self.join("api/auth/password/login")?;
        let res = self
            .http
            .post(url)
            .json(&PasswordLoginBody { password })
            .send()
            .await?;
        if res.status() == StatusCode::UNAUTHORIZED {
            return Err(E2eeHttpError::BadPassword);
        }
        let parsed: LoginResponse = parse_json_or_http(res).await?;
        Ok(LoginOk {
            user_id: parsed.user.id,
            token: parsed.token,
        })
    }

    // ── Endpoint 4: GET /api/collections ──

    pub async fn list_collections(&self) -> Result<Vec<String>, E2eeHttpError> {
        let url = self.join("api/collections")?;
        let res = self
            .http
            .get(url)
            .headers(self.auth_header()?)
            .send()
            .await?;
        let parsed: CollectionListResponse = parse_json_or_http(res).await?;
        Ok(parsed.collections.into_iter().map(|c| c.id).collect())
    }

    // ── Endpoint 5: POST /api/collections ──

    pub async fn create_collection(&self) -> Result<String, E2eeHttpError> {
        let url = self.join("api/collections")?;
        let res = self
            .http
            .post(url)
            .headers(self.auth_header()?)
            .send()
            .await?;
        let parsed: CreateCollectionResponse = parse_json_or_http(res).await?;
        Ok(parsed.collection.id)
    }

    // ── Endpoint 6: GET /api/collections/{cid}/key ──

    pub async fn get_key_material(
        &self,
        collection_id: &str,
    ) -> Result<Option<KeyMaterial>, E2eeHttpError> {
        let url = self.join(&format!("api/collections/{collection_id}/key"))?;
        let res = self
            .http
            .get(url)
            .headers(self.auth_header()?)
            .send()
            .await?;
        let parsed: KeyMaterialResponse = parse_json_or_http(res).await?;
        Ok(parsed.key)
    }

    // ── Endpoint 7: PUT /api/collections/{cid}/key ──

    pub async fn put_key_material(
        &self,
        collection_id: &str,
        material: &KeyMaterial,
    ) -> Result<KeyMaterial, E2eeHttpError> {
        let url = self.join(&format!("api/collections/{collection_id}/key"))?;
        let body = PutKeyMaterialBody {
            key_salt: &material.key_salt,
            key_kdf: &material.key_kdf,
            encrypted_vault_key: &material.encrypted_vault_key,
        };
        let res = self
            .http
            .put(url)
            .headers(self.auth_header()?)
            .json(&body)
            .send()
            .await?;
        let parsed: PutKeyMaterialResponse = parse_json_or_http(res).await?;
        Ok(parsed.key)
    }

    // ── Endpoint 8: GET /api/collections/{cid}/objects?sinceVersion={n} ──

    pub async fn list_objects(
        &self,
        collection_id: &str,
        since_version: u64,
    ) -> Result<Vec<ServerObject>, E2eeHttpError> {
        let path = format!("api/collections/{collection_id}/objects");
        let mut url = self.join(&path)?;
        url.query_pairs_mut()
            .append_pair("sinceVersion", &since_version.to_string());
        let res = self
            .http
            .get(url)
            .headers(self.auth_header()?)
            .send()
            .await?;
        let parsed: ListObjectsResponse = parse_json_or_http(res).await?;
        Ok(parsed.objects)
    }

    // ── Endpoint 9: GET /api/blobs/{key} (raw binary) ──

    pub async fn get_blob(&self, blob_key: &str) -> Result<Vec<u8>, E2eeHttpError> {
        let url = self.join(&format!("api/blobs/{blob_key}"))?;
        let res = self
            .http
            .get(url)
            .headers(self.auth_header()?)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(E2eeHttpError::Http { status, body });
        }
        Ok(res.bytes().await?.to_vec())
    }

    // ── Endpoint 10: POST /api/collections/{cid}/blob-objects (raw body) ──

    pub async fn post_blob_object(
        &self,
        collection_id: &str,
        ciphertext: Vec<u8>,
    ) -> Result<ObjectWriteResponse, E2eeHttpError> {
        let url = self.join(&format!("api/collections/{collection_id}/blob-objects"))?;
        let mut headers = self.auth_header()?;
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        let res = self
            .http
            .post(url)
            .headers(headers)
            .body(ciphertext)
            .send()
            .await?;
        let parsed: ObjectWriteWire = parse_json_or_http(res).await?;
        wire_to_write_response(parsed)
    }

    // ── Endpoint 11: PUT /api/collections/{cid}/blob-objects/{oid}?version={v} ──

    pub async fn put_blob_object(
        &self,
        collection_id: &str,
        object_id: &str,
        expected_version: u64,
        ciphertext: Vec<u8>,
    ) -> Result<PutResult, E2eeHttpError> {
        let path = format!("api/collections/{collection_id}/blob-objects/{object_id}");
        let mut url = self.join(&path)?;
        url.query_pairs_mut()
            .append_pair("version", &expected_version.to_string());
        let mut headers = self.auth_header()?;
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        let res = self
            .http
            .put(url)
            .headers(headers)
            .body(ciphertext)
            .send()
            .await?;
        if res.status() == StatusCode::CONFLICT {
            let conflict: ConflictResponse = res.json().await.map_err(E2eeHttpError::Transport)?;
            return Ok(PutResult::Conflict(conflict));
        }
        let parsed: ObjectWriteWire = parse_json_or_http(res).await?;
        Ok(PutResult::Ok(wire_to_write_response(parsed)?))
    }

    // ── Endpoint 12: DELETE /api/collections/{cid}/objects/{oid}?version={v} ──

    pub async fn delete_object(
        &self,
        collection_id: &str,
        object_id: &str,
        version: u64,
    ) -> Result<DeleteResult, E2eeHttpError> {
        let path = format!("api/collections/{collection_id}/objects/{object_id}");
        let mut url = self.join(&path)?;
        url.query_pairs_mut()
            .append_pair("version", &version.to_string());
        let res = self
            .http
            .delete(url)
            .headers(self.auth_header()?)
            .send()
            .await?;
        if res.status() == StatusCode::CONFLICT {
            let conflict: ConflictResponse = res.json().await.map_err(E2eeHttpError::Transport)?;
            return Ok(DeleteResult::Conflict(conflict));
        }
        let parsed: ObjectWriteWire = parse_json_or_http(res).await?;
        let change_seq = parsed
            .collection_version
            .or(parsed.object.change_seq)
            .unwrap_or(0);
        Ok(DeleteResult::Ok(ObjectWriteOk {
            version: parsed.object.version,
            change_seq,
        }))
    }
}

fn wire_to_write_response(wire: ObjectWriteWire) -> Result<ObjectWriteResponse, E2eeHttpError> {
    let change_seq = wire
        .collection_version
        .or(wire.object.change_seq)
        .unwrap_or(0);
    let updated_at = wire
        .object
        .updated_at
        .as_deref()
        .and_then(parse_iso_ms)
        .unwrap_or_else(|| futo_notes_core::files::now_ms());
    let blob_key = wire.object.blob_key.ok_or_else(|| {
        E2eeHttpError::InvalidJson("POST/PUT response missing blob_key".to_owned())
    })?;
    Ok(ObjectWriteResponse {
        object_id: wire.object.id,
        version: wire.object.version,
        change_seq,
        blob_key,
        updated_at,
    })
}

/// Cheap ISO-8601 → epoch-ms parser that matches `new Date(iso).getTime()`
/// in JS for the formats the server actually emits (`YYYY-MM-DDTHH:MM:SS[.fff]Z`).
/// Returns `None` for anything it doesn't recognize so the caller can fall
/// back to `now_ms()`.
pub(crate) fn parse_iso_ms(s: &str) -> Option<i64> {
    use time::format_description::well_known::Rfc3339;
    let parsed = time::OffsetDateTime::parse(s, &Rfc3339).ok()?;
    let nanos = parsed.unix_timestamp_nanos();
    Some((nanos / 1_000_000) as i64)
}

async fn parse_json_or_http<T: for<'de> Deserialize<'de>>(
    res: reqwest::Response,
) -> Result<T, E2eeHttpError> {
    let status = res.status();
    if !status.is_success() {
        let code = status.as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(E2eeHttpError::Http { status: code, body });
    }
    let bytes = res.bytes().await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| E2eeHttpError::InvalidJson(format!("{e} (body: {:?})", String::from_utf8_lossy(&bytes))))
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client_for(server: &MockServer) -> E2eeClient {
        let mut c = E2eeClient::new(&server.uri()).unwrap();
        c.set_token("test-token");
        c
    }

    #[tokio::test]
    async fn probe_returns_dev_when_server_advertises_dev() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"auth_mode": "dev"})))
            .mount(&server)
            .await;
        let c = E2eeClient::new(&server.uri()).unwrap();
        assert_eq!(c.probe_auth_mode().await, AuthMode::Dev);
    }

    #[tokio::test]
    async fn probe_falls_back_to_password_on_unreachable_server() {
        // 127.0.0.1 with no listener — the request will fail fast.
        let c = E2eeClient::new("http://127.0.0.1:1").unwrap();
        assert_eq!(c.probe_auth_mode().await, AuthMode::Password);
    }

    #[tokio::test]
    async fn login_dev_round_trips_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/dev/login"))
            .and(body_json(serde_json::json!({"email": "a@b", "name": "Alice"})))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"user": {"id": "u1"}, "token": "tok"})),
            )
            .mount(&server)
            .await;
        let c = E2eeClient::new(&server.uri()).unwrap();
        let out = c.login_dev("a@b", "Alice").await.unwrap();
        assert_eq!(out.user_id, "u1");
        assert_eq!(out.token, "tok");
    }

    #[tokio::test]
    async fn login_password_maps_401_to_bad_password() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/password/login"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let c = E2eeClient::new(&server.uri()).unwrap();
        let err = c.login_password("nope").await.unwrap_err();
        assert!(matches!(err, E2eeHttpError::BadPassword));
    }

    #[tokio::test]
    async fn list_collections_sends_bearer_and_parses_ids() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/collections"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"collections": [{"id": "c1"}, {"id": "c2"}]}),
            ))
            .mount(&server)
            .await;
        let ids = client_for(&server).list_collections().await.unwrap();
        assert_eq!(ids, vec!["c1", "c2"]);
    }

    #[tokio::test]
    async fn create_collection_returns_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/collections"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"collection": {"id": "new"}})),
            )
            .mount(&server)
            .await;
        let id = client_for(&server).create_collection().await.unwrap();
        assert_eq!(id, "new");
    }

    #[tokio::test]
    async fn get_key_material_handles_null() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/collections/c1/key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"key": null})))
            .mount(&server)
            .await;
        let m = client_for(&server).get_key_material("c1").await.unwrap();
        assert!(m.is_none());
    }

    #[tokio::test]
    async fn put_key_material_sends_expected_body() {
        let server = MockServer::start().await;
        let (_, material) =
            futo_notes_core::e2ee::wrap_vault_key("password").unwrap();
        let key_salt_clone = material.key_salt.clone();
        Mock::given(method("PUT"))
            .and(path("/api/collections/c1/key"))
            .and(body_partial_json(serde_json::json!({
                "key_kdf": {"kdf": "pbkdf2-sha256", "iterations": 100_000, "hash": "SHA-256"}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "key": {
                    "key_salt": key_salt_clone,
                    "key_kdf": {"kdf": "pbkdf2-sha256", "iterations": 100_000, "hash": "SHA-256"},
                    "encrypted_vault_key": material.encrypted_vault_key,
                }
            })))
            .mount(&server)
            .await;
        let returned = client_for(&server)
            .put_key_material("c1", &material)
            .await
            .unwrap();
        assert_eq!(returned.key_salt, material.key_salt);
    }

    #[tokio::test]
    async fn list_objects_passes_since_version_and_accepts_numeric_strings() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "42"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [{
                    "id": "o1",
                    "collection_id": "c1",
                    "version": "3",
                    "change_seq": "99",
                    "deleted": false,
                    "blob_key": "bk1",
                    "size_bytes": "12",
                    "created_at": "2026-05-13T00:00:00.000Z",
                    "updated_at": "2026-05-13T00:00:01.000Z"
                }]
            })))
            .mount(&server)
            .await;
        let objs = client_for(&server).list_objects("c1", 42).await.unwrap();
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0].id, "o1");
        assert_eq!(objs[0].version, 3);
        assert_eq!(objs[0].change_seq, 99);
        assert_eq!(objs[0].blob_key.as_deref(), Some("bk1"));
        assert_eq!(objs[0].size_bytes, Some(12));
    }

    #[tokio::test]
    async fn get_blob_returns_raw_bytes() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/blobs/bk1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"\x01\x02\x03"))
            .mount(&server)
            .await;
        let bytes = client_for(&server).get_blob("bk1").await.unwrap();
        assert_eq!(bytes, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn get_blob_propagates_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/blobs/missing"))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .mount(&server)
            .await;
        let err = client_for(&server).get_blob("missing").await.unwrap_err();
        assert!(matches!(err, E2eeHttpError::Http { status: 404, .. }));
    }

    #[tokio::test]
    async fn post_blob_object_sends_octet_stream() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/collections/c1/blob-objects"))
            .and(header("content-type", "application/octet-stream"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o1",
                    "version": 1,
                    "change_seq": 5,
                    "blob_key": "bk1",
                    "updated_at": "2026-05-13T00:00:00.000Z"
                },
                "collectionVersion": 5
            })))
            .mount(&server)
            .await;
        let out = client_for(&server)
            .post_blob_object("c1", vec![9, 8, 7])
            .await
            .unwrap();
        assert_eq!(out.object_id, "o1");
        assert_eq!(out.version, 1);
        assert_eq!(out.change_seq, 5);
        assert_eq!(out.blob_key, "bk1");
        assert!(out.updated_at > 0);
    }

    #[tokio::test]
    async fn put_blob_object_handles_409_conflict() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/collections/c1/blob-objects/o1"))
            .and(query_param("version", "3"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "version mismatch",
                "currentVersion": 5,
                "currentBlobKey": "bk-new"
            })))
            .mount(&server)
            .await;
        let res = client_for(&server)
            .put_blob_object("c1", "o1", 3, vec![1])
            .await
            .unwrap();
        match res {
            PutResult::Conflict(c) => {
                assert_eq!(c.current_version, 5);
                assert_eq!(c.current_blob_key.as_deref(), Some("bk-new"));
            }
            PutResult::Ok(_) => panic!("expected conflict"),
        }
    }

    #[tokio::test]
    async fn delete_object_parses_response_without_blob_key() {
        // The server omits `blob_key` on DELETE — the blob is already
        // orphaned. The wire decoder must accept that.
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/collections/c1/objects/o1"))
            .and(query_param("version", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o1",
                    "version": "2",
                    "change_seq": "3",
                    "deleted": true
                },
                "collectionVersion": 3
            })))
            .mount(&server)
            .await;
        let res = client_for(&server)
            .delete_object("c1", "o1", 1)
            .await
            .unwrap();
        match res {
            DeleteResult::Ok(ok) => {
                assert_eq!(ok.version, 2);
                assert_eq!(ok.change_seq, 3);
            }
            DeleteResult::Conflict(_) => panic!("expected ok"),
        }
    }

    #[tokio::test]
    async fn delete_object_handles_409_conflict() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/collections/c1/objects/o1"))
            .and(query_param("version", "3"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "edit while delete",
                "currentVersion": 7,
                "currentBlobKey": "bk-restore"
            })))
            .mount(&server)
            .await;
        let res = client_for(&server)
            .delete_object("c1", "o1", 3)
            .await
            .unwrap();
        match res {
            DeleteResult::Conflict(c) => {
                assert_eq!(c.current_version, 7);
                assert_eq!(c.current_blob_key.as_deref(), Some("bk-restore"));
            }
            DeleteResult::Ok(_) => panic!("expected conflict"),
        }
    }

    // ── ISO timestamp ──

    #[test]
    fn parse_iso_ms_matches_js_date_getTime() {
        // Reference: 20454 days from 1970-01-01 to 2026-01-01 (incl. 14 leap
        // days) + 132 days through May 13 = 20586 days * 86400_000 ms.
        // Matches `new Date('2026-05-13T00:00:00.000Z').getTime()`.
        assert_eq!(parse_iso_ms("2026-05-13T00:00:00.000Z"), Some(1778630400000));
        // Unix epoch sanity-check.
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("not-a-date"), None);
    }
}
