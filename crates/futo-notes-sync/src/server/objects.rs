//! Object, blob, and event-stream endpoints.

use super::*;

impl Http {
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

    pub async fn blob(&self, key: &str, expected_bytes: u64) -> Result<Vec<u8>, HttpError> {
        let response = self
            .request(Method::GET, &format!("/api/blobs/{key}"))
            .timeout(download_timeout(expected_bytes))
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(transport_error)
    }

    pub async fn blobs_batch(
        &self,
        keys: &[String],
        expected_bytes: u64,
    ) -> Result<Vec<BatchBlobEntry>, HttpError> {
        let response = self
            .request(Method::POST, "/api/blobs/batch")
            .timeout(download_timeout(expected_bytes))
            .json(&serde_json::json!({ "keys": keys }))
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let body = response.bytes().await.map_err(transport_error)?;
        let entries = parse_batch_frames(&body).map_err(|message| HttpError {
            status: None,
            message: format!("batch frames: {message}"),
        })?;
        if entries.len() != keys.len() {
            return Err(HttpError {
                status: None,
                message: format!(
                    "batch frames: expected {} entries, got {}",
                    keys.len(),
                    entries.len()
                ),
            });
        }
        Ok(entries)
    }

    async fn mutation(request: reqwest::RequestBuilder) -> Result<Mutation, HttpError> {
        let response = request.send().await.map_err(transport_error)?;
        if response.status() == StatusCode::CONFLICT {
            return response
                .json::<Conflict>()
                .await
                .map(Mutation::Conflict)
                // Keeps the 409 the caller dispatches on — only the body was
                // unreadable — but still names why it was unreadable.
                .map_err(|e| HttpError {
                    status: Some(409),
                    message: error_chain(&e),
                });
        }
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response
            .json::<WriteBody>()
            .await
            .map(|body| Mutation::Written(body.into()))
            .map_err(transport_error)
    }

    pub async fn create_object(
        &self,
        collection: &str,
        mutation_id: &str,
        ciphertext: Vec<u8>,
    ) -> Result<CreateWrite, HttpError> {
        let timeout = transfer_timeout(ciphertext.len() as u64);
        let response = self
            .request(
                Method::POST,
                &format!("/api/collections/{collection}/blob-objects"),
            )
            .header("content-type", "application/octet-stream")
            .header("mutation-id", mutation_id)
            .timeout(timeout)
            .body(ciphertext)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let body = response
            .json::<WriteBody>()
            .await
            .map_err(transport_error)?;
        let replayed = body.replayed;
        Ok(CreateWrite {
            write: body.into(),
            replayed,
        })
    }

    pub async fn create_mutation(
        &self,
        collection: &str,
        mutation_id: &str,
    ) -> Result<CreateWrite, HttpError> {
        let body = Self::json::<WriteBody>(self.request(
            Method::GET,
            &format!("/api/collections/{collection}/create-mutations/{mutation_id}"),
        ))
        .await?;
        let replayed = body.replayed;
        Ok(CreateWrite {
            write: body.into(),
            replayed,
        })
    }

    pub async fn update_object(
        &self,
        collection: &str,
        object: &str,
        version: u64,
        ciphertext: Vec<u8>,
    ) -> Result<Mutation, HttpError> {
        let timeout = transfer_timeout(ciphertext.len() as u64);
        Self::mutation(
            self.request(
                Method::PUT,
                &format!("/api/collections/{collection}/blob-objects/{object}?version={version}"),
            )
            .header("content-type", "application/octet-stream")
            .timeout(timeout)
            .body(ciphertext),
        )
        .await
    }

    pub async fn write_objects_batch(
        &self,
        collection: &str,
        entries: &[BatchWriteEntry],
    ) -> Result<Vec<BatchMutation>, HttpError> {
        let body = encode_batch_write_frames(entries)?;
        let response = self
            .request(
                Method::POST,
                &format!("/api/collections/{collection}/blob-objects/batch"),
            )
            .header("content-type", "application/octet-stream")
            .timeout(transfer_timeout(body.len() as u64))
            .body(body)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let body = response.bytes().await.map_err(transport_error)?;
        parse_batch_write_results(&body, entries)
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
        let request = self.authorize(
            self.event_client
                .get(format!("{}/api/sync/events", self.base))
                .header("accept", "text/event-stream"),
        );
        let response = tokio::time::timeout(REQUEST_TIMEOUT, request.send())
            .await
            .map_err(|_| HttpError {
                status: None,
                message: "event stream response timed out".into(),
            })?
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        Ok(response)
    }
}
