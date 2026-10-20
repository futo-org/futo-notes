//! Auth, collection, and key-material endpoints.

use super::*;

impl Http {
    pub async fn auth_mode(&self) -> Result<String, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            auth_mode: String,
        }
        Ok(
            Self::json::<Body>(self.request(Method::GET, "/").timeout(PROBE_TIMEOUT))
                .await?
                .auth_mode,
        )
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

    /// `PUT …/key` carrying the revision token the material was last read at:
    /// the **re-wrap** shape, which a change of vault password and a new
    /// recovery key both take.
    ///
    /// A stale token comes back as [`KeyRewrap::Stale`] rather than as an
    /// error, because the server sends the authoritative material with the
    /// `409` and the whole remedy is to re-wrap from that one instead.
    ///
    /// The body is the material plus `previous_key_updated_at`. Both envelopes
    /// go in every write — there is no way to address one on its own, and
    /// omitting the recovery fields deletes the recovery envelope rather than
    /// leaving it alone (server ADR 0006, rule 2).
    pub async fn rewrap_key(
        &self,
        collection: &str,
        key: &KeyMaterial,
        previous_key_updated_at: &str,
    ) -> Result<KeyRewrap, HttpError> {
        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(flatten)]
            key: &'a KeyMaterial,
            previous_key_updated_at: &'a str,
        }
        #[derive(Deserialize)]
        struct Written {
            key: KeyMaterial,
        }
        // The one camelCase field in an otherwise snake_case API; named here
        // exactly as the server writes it.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Conflicted {
            current_key: KeyMaterial,
        }

        let response = self
            .request(Method::PUT, &format!("/api/collections/{collection}/key"))
            .json(&Body {
                key,
                previous_key_updated_at,
            })
            .send()
            .await
            .map_err(transport_error)?;
        if response.status() == StatusCode::CONFLICT {
            return response
                .json::<Conflicted>()
                .await
                .map(|body| KeyRewrap::Stale(body.current_key))
                // Keeps the 409 the caller dispatches on — only the body was
                // unreadable — but still names why it was unreadable.
                .map_err(|error| HttpError {
                    status: Some(409),
                    message: error_chain(&error),
                });
        }
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response
            .json::<Written>()
            .await
            .map(|body| KeyRewrap::Written(body.key))
            .map_err(transport_error)
    }
}
