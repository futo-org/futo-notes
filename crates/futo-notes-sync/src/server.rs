use std::time::Duration;

use futo_notes_core::e2ee::KeyMaterial;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub(crate) struct HttpError {
    pub status: Option<u16>,
    pub message: String,
}

impl HttpError {
    pub fn is(&self, status: u16) -> bool {
        self.status == Some(status)
    }
}

#[derive(Clone)]
pub(crate) struct Http {
    base: String,
    token: Option<String>,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
}

fn number<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Value {
        Number(u64),
        String(String),
    }
    match Value::deserialize(deserializer)? {
        Value::Number(n) => Ok(n),
        Value::String(s) => s.parse().map_err(serde::de::Error::custom),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Object {
    pub id: String,
    #[serde(deserialize_with = "number")]
    pub version: u64,
    #[serde(deserialize_with = "number")]
    pub change_seq: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub blob_key: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Collection {
    pub id: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct Write {
    pub object: Object,
    pub collection_version: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conflict {
    #[serde(deserialize_with = "number")]
    pub current_version: u64,
    #[serde(default)]
    pub current_blob_key: Option<String>,
}

pub(crate) enum Mutation {
    Written(Write),
    Conflict(Conflict),
}

#[derive(Deserialize)]
struct WriteBody {
    object: Object,
    #[serde(rename = "collectionVersion", deserialize_with = "number")]
    collection_version: u64,
}

impl From<WriteBody> for Write {
    fn from(body: WriteBody) -> Self {
        Self {
            object: body.object,
            collection_version: body.collection_version,
        }
    }
}

impl Http {
    pub fn new(base: &str) -> Result<Self, HttpError> {
        let base = base.trim().trim_end_matches('/');
        let url = url::Url::parse(base).map_err(|e| HttpError {
            status: None,
            message: format!("invalid server URL: {e}"),
        })?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(HttpError {
                status: None,
                message: "server URL must use http or https".into(),
            });
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| HttpError {
                status: None,
                message: e.to_string(),
            })?;
        Ok(Self {
            base: base.to_owned(),
            token: None,
            client,
        })
    }

    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let request = self
            .client
            .request(method, format!("{}{}", self.base, path));
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    async fn response_error(response: reqwest::Response) -> HttpError {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<ErrorBody>(&text)
            .ok()
            .and_then(|body| body.error)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("HTTP {status}"));
        HttpError {
            status: Some(status),
            message,
        }
    }

    async fn json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T, HttpError> {
        let response = request.send().await.map_err(|e| HttpError {
            status: e.status().map(|s| s.as_u16()),
            message: e.to_string(),
        })?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response.json().await.map_err(|e| HttpError {
            status: None,
            message: e.to_string(),
        })
    }

    pub async fn auth_mode(&self) -> Result<String, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            auth_mode: String,
        }
        Ok(Self::json::<Body>(self.request(Method::GET, "/"))
            .await?
            .auth_mode)
    }

    pub async fn login(&self, mode: &str, password: &str) -> Result<(String, String), HttpError> {
        #[derive(Deserialize)]
        struct User {
            id: String,
        }
        #[derive(Deserialize)]
        struct Body {
            user: User,
            token: String,
        }
        let request = if mode == "dev" {
            self.request(Method::POST, "/api/auth/dev/login")
                .json(&serde_json::json!({"email":"local@futo-notes.local","name":"FUTO Notes"}))
        } else {
            self.request(Method::POST, "/api/auth/password/login")
                .json(&serde_json::json!({"password":password}))
        };
        let body = Self::json::<Body>(request).await?;
        Ok((body.user.id, body.token))
    }

    pub async fn collections(&self) -> Result<Vec<Collection>, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            collections: Vec<Collection>,
        }
        Ok(
            Self::json::<Body>(self.request(Method::GET, "/api/collections"))
                .await?
                .collections,
        )
    }

    pub async fn create_collection(&self) -> Result<String, HttpError> {
        #[derive(Deserialize)]
        struct Collection {
            id: String,
        }
        #[derive(Deserialize)]
        struct Body {
            collection: Collection,
        }
        Ok(
            Self::json::<Body>(self.request(Method::POST, "/api/collections"))
                .await?
                .collection
                .id,
        )
    }

    pub async fn key(&self, collection: &str) -> Result<Option<KeyMaterial>, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            key: Option<KeyMaterial>,
        }
        Ok(Self::json::<Body>(
            self.request(Method::GET, &format!("/api/collections/{collection}/key")),
        )
        .await?
        .key)
    }

    pub async fn put_key(
        &self,
        collection: &str,
        key: &KeyMaterial,
    ) -> Result<KeyMaterial, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            key: KeyMaterial,
        }
        Ok(Self::json::<Body>(
            self.request(Method::PUT, &format!("/api/collections/{collection}/key"))
                .json(key),
        )
        .await?
        .key)
    }

    pub async fn objects(&self, collection: &str, since: u64) -> Result<Vec<Object>, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            objects: Vec<Object>,
        }
        Ok(Self::json::<Body>(self.request(
            Method::GET,
            &format!("/api/collections/{collection}/objects?sinceVersion={since}"),
        ))
        .await?
        .objects)
    }

    pub async fn object(&self, collection: &str, object: &str) -> Result<Object, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            object: Object,
        }
        Ok(Self::json::<Body>(self.request(
            Method::GET,
            &format!("/api/collections/{collection}/objects/{object}"),
        ))
        .await?
        .object)
    }

    pub async fn blob(&self, key: &str) -> Result<Vec<u8>, HttpError> {
        let response = self
            .request(Method::GET, &format!("/api/blobs/{key}"))
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| HttpError {
                status: e.status().map(|s| s.as_u16()),
                message: e.to_string(),
            })?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| HttpError {
                status: None,
                message: e.to_string(),
            })
    }

    async fn mutation(request: reqwest::RequestBuilder) -> Result<Mutation, HttpError> {
        let response = request.send().await.map_err(|e| HttpError {
            status: e.status().map(|s| s.as_u16()),
            message: e.to_string(),
        })?;
        if response.status() == StatusCode::CONFLICT {
            return response
                .json::<Conflict>()
                .await
                .map(Mutation::Conflict)
                .map_err(|e| HttpError {
                    status: Some(409),
                    message: e.to_string(),
                });
        }
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response
            .json::<WriteBody>()
            .await
            .map(|body| Mutation::Written(body.into()))
            .map_err(|e| HttpError {
                status: None,
                message: e.to_string(),
            })
    }

    pub async fn create_object(
        &self,
        collection: &str,
        ciphertext: Vec<u8>,
    ) -> Result<Write, HttpError> {
        match Self::mutation(
            self.request(
                Method::POST,
                &format!("/api/collections/{collection}/blob-objects"),
            )
            .header("content-type", "application/octet-stream")
            .body(ciphertext),
        )
        .await?
        {
            Mutation::Written(write) => Ok(write),
            Mutation::Conflict(_) => unreachable!("create cannot conflict"),
        }
    }

    pub async fn update_object(
        &self,
        collection: &str,
        object: &str,
        version: u64,
        ciphertext: Vec<u8>,
    ) -> Result<Mutation, HttpError> {
        Self::mutation(
            self.request(
                Method::PUT,
                &format!("/api/collections/{collection}/blob-objects/{object}?version={version}"),
            )
            .header("content-type", "application/octet-stream")
            .body(ciphertext),
        )
        .await
    }

    pub async fn delete_object(
        &self,
        collection: &str,
        object: &str,
        version: u64,
    ) -> Result<Mutation, HttpError> {
        Self::mutation(self.request(
            Method::DELETE,
            &format!("/api/collections/{collection}/objects/{object}?version={version}"),
        ))
        .await
    }

    pub async fn events(&self) -> Result<reqwest::Response, HttpError> {
        let response = self
            .request(Method::GET, "/api/sync/events")
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| HttpError {
                status: e.status().map(|s| s.as_u16()),
                message: e.to_string(),
            })?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        Ok(response)
    }
}

pub(crate) fn timestamp_ms(value: &str) -> i64 {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|t| t.unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(0) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_matches_javascript_date_milliseconds() {
        assert_eq!(timestamp_ms("2026-06-05T12:34:56.789Z"), 1_780_662_896_789);
        assert_eq!(timestamp_ms("not a timestamp"), 0);
    }

    #[test]
    fn numeric_wire_fields_accept_numbers_and_decimal_strings() {
        for version in [serde_json::json!(7), serde_json::json!("7")] {
            let value = serde_json::json!({
                "id": "o1",
                "version": version,
                "change_seq": "9"
            });
            let object: Object = serde_json::from_value(value).unwrap();
            assert_eq!(object.version, 7);
            assert_eq!(object.change_seq, 9);
        }
        assert!(serde_json::from_value::<Object>(serde_json::json!({
            "id":"o1", "version":"nope", "change_seq":1
        }))
        .is_err());
    }

    #[test]
    fn base_url_is_trimmed_and_requires_http() {
        assert_eq!(
            Http::new("  http://example.test///  ").unwrap().base,
            "http://example.test"
        );
        assert!(Http::new("ftp://example.test").is_err());
        assert!(Http::new("example.test").is_err());
    }

    #[test]
    fn delete_response_can_omit_blob_key_and_updated_at() {
        let body: WriteBody = serde_json::from_value(serde_json::json!({
            "object": {
                "id":"o1",
                "version":"2",
                "change_seq":"8",
                "deleted":true
            },
            "collectionVersion":"8"
        }))
        .unwrap();
        assert!(body.object.deleted);
        assert!(body.object.blob_key.is_none());
        assert_eq!(body.object.updated_at, "");
        assert_eq!(body.collection_version, 8);
    }
}
