use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post, put};
use axum::Router;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};

use crate::indexer::{IndexerCommand, IndexerStatus};
use crate::middleware::RateLimiter;
use crate::routes;

/// Shared application state, cloneable via Arc.
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub notes_dir: PathBuf,
    pub indexer_tx: mpsc::Sender<IndexerCommand>,
    pub indexer_status: Arc<RwLock<IndexerStatus>>,
}

/// Build the Axum router with all routes and shared state.
pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Rate limiter for login: 5 attempts per IP per 60 seconds
    let login_limiter = RateLimiter::new(5, 60);

    // Public routes (no auth required)
    let public = Router::new()
        .route("/", get(routes::dashboard::dashboard))
        .route("/health", get(routes::health::health))
        .route("/setup", post(routes::auth::setup))
        .route(
            "/login",
            post(routes::auth::login).layer(axum::middleware::from_fn_with_state(
                login_limiter,
                crate::middleware::rate_limit,
            )),
        );

    // Authenticated routes
    let authed = Router::new()
        .route("/dashboard/status", get(routes::dashboard::status))
        .route("/sync", post(routes::sync::sync))
        .route("/sync/check", post(routes::sync::sync_check))
        .route("/blob/{filename}", put(routes::blob::upload_blob))
        .route("/blob/{filename}", get(routes::blob::download_blob))
        .route("/search", get(routes::search::search))
        .route("/search/status", get(routes::search::status))
        .route("/graph/layout", get(routes::graph::layout))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::middleware::require_auth,
        ));

    Router::new()
        .merge(public)
        .merge(authed)
        .layer(cors)
        .layer(DefaultBodyLimit::max(100 * 1024 * 1024)) // 100 MB (matches blob limit)
        .with_state(state)
}
