use std::collections::HashMap;
use std::path::Path;

use futo_notes_core::e2ee::{self, KeyMaterial};

use crate::checkpoint::{self, ConnectedState};
use crate::server::{Collection, Http, HttpError};
use crate::sync::{ConnectInfo, SyncErrorKind};

fn http_error(error: HttpError) -> SyncErrorKind {
    let status = error.status;
    let message = match status {
        Some(status) => format!("HTTP {status}: {}", error.message),
        None => error.message,
    };
    if status == Some(401) {
        SyncErrorKind::Auth(message)
    } else {
        SyncErrorKind::Http(message)
    }
}

pub(crate) fn collection_error(error: HttpError) -> SyncErrorKind {
    if error.is(404) {
        SyncErrorKind::CollectionGone(format!("HTTP 404: {}", error.message))
    } else {
        http_error(error)
    }
}

async fn create_key_material(password: &str) -> Result<KeyMaterial, SyncErrorKind> {
    let password = password.to_owned();
    let (_, material) = tokio::task::spawn_blocking(move || e2ee::wrap_vault_key(&password))
        .await
        .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?
        .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?;
    Ok(material)
}

async fn load_or_create_key_material(
    http: &Http,
    collection_id: &str,
    password: &str,
) -> Result<KeyMaterial, SyncErrorKind> {
    if let Some(material) = http.key(collection_id).await.map_err(collection_error)? {
        return Ok(material);
    }
    if !http
        .objects(collection_id, 0)
        .await
        .map_err(collection_error)?
        .is_empty()
    {
        return Err(SyncErrorKind::Crypto(
            "collection has objects but no key material; refusing to mint a new vault key".into(),
        ));
    }
    let fresh = create_key_material(password).await?;
    match http.put_key(collection_id, &fresh).await {
        Ok(material) => Ok(material),
        Err(error) if error.is(409) => http
            .key(collection_id)
            .await
            .map_err(collection_error)?
            .ok_or_else(|| {
                SyncErrorKind::Crypto(
                    "vault key claim conflicted but the authoritative key is missing".into(),
                )
            }),
        Err(error) => Err(collection_error(error)),
    }
}

async fn unlock_vault_key(
    password: &str,
    material: KeyMaterial,
) -> Result<[u8; 32], SyncErrorKind> {
    let password = password.to_owned();
    tokio::task::spawn_blocking(move || e2ee::unwrap_vault_key(&password, &material))
        .await
        .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?
        .map_err(|error| SyncErrorKind::Crypto(error.to_string()))
}

fn connected_state(
    root: &Path,
    server: &str,
    token: String,
    user_id: String,
    collection_id: String,
    vault_key: [u8; 32],
) -> ConnectedState {
    let loaded = checkpoint::load(root, &collection_id);
    ConnectedState {
        base_url: server.trim().trim_end_matches('/').to_owned(),
        token,
        user_id,
        collection_id,
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
    }
}

fn canonical_collection_id(collections: Vec<Collection>) -> Option<String> {
    collections
        .into_iter()
        .min_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        })
        .map(|collection| collection.id)
}

pub(crate) async fn connect(
    root: &Path,
    server: &str,
    password: &str,
) -> Result<(ConnectedState, ConnectInfo), SyncErrorKind> {
    let anonymous = Http::new(server).map_err(http_error)?;
    let auth_mode = anonymous.auth_mode().await.map_err(http_error)?;
    let (user_id, token) = anonymous
        .login(&auth_mode, password)
        .await
        .map_err(|error| SyncErrorKind::Auth(error.to_string()))?;
    let http = anonymous.token(token.clone());
    let collection_id = match canonical_collection_id(http.collections().await.map_err(http_error)?)
    {
        Some(id) => id,
        None => {
            http.create_collection().await.map_err(http_error)?;
            canonical_collection_id(http.collections().await.map_err(http_error)?).ok_or_else(
                || SyncErrorKind::Http("server returned no collection after creation".into()),
            )?
        }
    };
    let material = load_or_create_key_material(&http, &collection_id, password).await?;
    let vault_key = unlock_vault_key(password, material).await?;
    let state = connected_state(
        root,
        server,
        token.clone(),
        user_id.clone(),
        collection_id.clone(),
        vault_key,
    );
    checkpoint::save(root, &state).map_err(SyncErrorKind::Io)?;
    Ok((
        state,
        ConnectInfo {
            user_id,
            collection_id,
            token,
            auth_mode,
        },
    ))
}

pub(crate) async fn resume(
    root: &Path,
    server: &str,
    token: &str,
    user_id: &str,
    collection_id: &str,
    password: &str,
) -> Result<ConnectedState, SyncErrorKind> {
    let http = Http::new(server).map_err(http_error)?.token(token);
    let material = http
        .key(collection_id)
        .await
        .map_err(collection_error)?
        .ok_or_else(|| SyncErrorKind::Crypto("vault key material missing on server".into()))?;
    let vault_key = unlock_vault_key(password, material).await?;
    Ok(connected_state(
        root,
        server,
        token.to_owned(),
        user_id.to_owned(),
        collection_id.to_owned(),
        vault_key,
    ))
}

pub(crate) fn client(state: &ConnectedState) -> Result<Http, SyncErrorKind> {
    Ok(Http::new(&state.base_url)
        .map_err(http_error)?
        .token(state.token.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unauthorized_collection_request_preserves_status_and_auth_kind() {
        let error = collection_error(HttpError {
            status: Some(401),
            message: "session expired or invalid".into(),
        });

        assert!(matches!(error, SyncErrorKind::Auth(_)));
        assert_eq!(error.to_string(), "HTTP 401: session expired or invalid");
    }

    #[test]
    fn canonical_collection_prefers_earliest_creation_then_id() {
        let collections = vec![
            Collection {
                id: "later".into(),
                created_at: "2026-07-24T14:30:40.500Z".into(),
            },
            Collection {
                id: "second-at-same-time".into(),
                created_at: "2026-07-24T14:30:40.400Z".into(),
            },
            Collection {
                id: "first-at-same-time".into(),
                created_at: "2026-07-24T14:30:40.400Z".into(),
            },
        ];

        assert_eq!(
            canonical_collection_id(collections).as_deref(),
            Some("first-at-same-time")
        );
    }

    #[test]
    fn canonical_collection_rejects_an_empty_list() {
        assert_eq!(canonical_collection_id(Vec::new()), None);
    }
}
