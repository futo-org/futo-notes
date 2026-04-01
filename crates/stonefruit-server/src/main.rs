use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use stonefruit_server::embedder::load_embedder_from_env;
use stonefruit_server::indexer::{IndexerConfig, IndexerStatus};
use stonefruit_server::{app, db, indexer};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "stonefruit_server=info".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3006);

    let data_dir = std::env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./data"));

    let notes_dir = data_dir.join("notes");
    std::fs::create_dir_all(&notes_dir).expect("Failed to create notes directory");

    let db_path = data_dir.join("stonefruit.db");
    let conn = db::open_db(&db_path).expect("Failed to open database");

    let dev_password = std::env::var("STONEFRUIT_DEV_PASSWORD").ok();
    match stonefruit_server::startup::maybe_seed_dev_password(&conn, dev_password.as_deref()) {
        Ok(true) => tracing::info!("Initialized default dev password from STONEFRUIT_DEV_PASSWORD"),
        Ok(false) => {}
        Err(err) => {
            tracing::error!("{err}");
            std::process::exit(1);
        }
    }

    // Spawn the background indexer
    let indexer_status = Arc::new(RwLock::new(IndexerStatus::default()));
    let indexer_config = IndexerConfig {
        db_path: db_path.clone(),
        notes_dir: notes_dir.clone(),
        status: indexer_status.clone(),
    };

    let embedder = match tokio::task::spawn_blocking(load_embedder_from_env)
        .await
        .expect("embedder init task panicked")
    {
        Ok(embedder) => embedder,
        Err(err) => {
            tracing::error!("{err}");
            std::process::exit(1);
        }
    };
    let indexer_tx = indexer::spawn_indexer(indexer_config, embedder);

    let state = app::AppState {
        db: Arc::new(Mutex::new(conn)),
        notes_dir,
        indexer_tx,
        indexer_status,
    };

    let router = app::build_router(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("Stonefruit v2 server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("Server error");
}
