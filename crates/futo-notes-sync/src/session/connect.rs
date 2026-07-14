use std::collections::HashMap;
use std::path::Path;

use futo_notes_core::e2ee;

use crate::checkpoint::{self, ConnectedState};
use crate::server::{Http, HttpError};
use crate::sync::{ConnectInfo, SyncErrorKind};

fn http_error(error: HttpError) -> SyncErrorKind {
    SyncErrorKind::Http(error.to_string())
}

pub(crate) fn collection_error(error: HttpError) -> SyncErrorKind {
    if error.is(404) {
        SyncErrorKind::CollectionGone(error.to_string())
    } else {
        http_error(error)
    }
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
    let collection_id = match http.collections().await.map_err(http_error)?.first() {
        Some(id) => id.clone(),
        None => http.create_collection().await.map_err(http_error)?,
    };
    let material = match http.key(&collection_id).await.map_err(collection_error)? {
        Some(material) => material,
        None => {
            if !http
                .objects(&collection_id, 0)
                .await
                .map_err(collection_error)?
                .is_empty()
            {
                return Err(SyncErrorKind::Crypto(
                    "collection has objects but no key material; refusing to mint a new vault key"
                        .into(),
                ));
            }
            let password = password.to_owned();
            let (_, fresh) = tokio::task::spawn_blocking(move || e2ee::wrap_vault_key(&password))
                .await
                .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?
                .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?;
            http.put_key(&collection_id, &fresh)
                .await
                .map_err(collection_error)?
        }
    };
    let password = password.to_owned();
    let material_for_unlock = material.clone();
    let vault_key = tokio::task::spawn_blocking(move || {
        e2ee::unwrap_vault_key(&password, &material_for_unlock)
    })
    .await
    .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?
    .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?;
    let loaded = checkpoint::load(root, &collection_id);
    let state = ConnectedState {
        base_url: server.trim().trim_end_matches('/').to_owned(),
        token: token.clone(),
        user_id: user_id.clone(),
        collection_id: collection_id.clone(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
    };
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
    let password = password.to_owned();
    let vault_key =
        tokio::task::spawn_blocking(move || e2ee::unwrap_vault_key(&password, &material))
            .await
            .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?
            .map_err(|error| SyncErrorKind::Crypto(error.to_string()))?;
    let loaded = checkpoint::load(root, collection_id);
    Ok(ConnectedState {
        base_url: server.trim().trim_end_matches('/').to_owned(),
        token: token.to_owned(),
        user_id: user_id.to_owned(),
        collection_id: collection_id.to_owned(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
    })
}

pub(crate) fn client(state: &ConnectedState) -> Result<Http, SyncErrorKind> {
    Ok(Http::new(&state.base_url)
        .map_err(http_error)?
        .token(state.token.clone()))
}
