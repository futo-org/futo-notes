use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rustls::client::danger::ServerCertVerifier;

use super::reloading::ReloadingVerifier;
use super::test_support::{
    file_backed_trust, private_authority, remove_trusted_root, serve_https, trust_file,
    verifier_from_file,
};
use super::{client_config_with, server_cert_verifier};
use crate::server::{Http, HttpClients};

async fn auth_mode(url: &str, verifier: &Arc<dyn ServerCertVerifier>) -> Result<String, String> {
    Http::with_verifier(url, verifier.clone())
        .unwrap()
        .auth_mode()
        .await
        .map_err(|error| error.message)
}

#[tokio::test]
async fn a_privately_signed_server_is_rejected_without_its_root() {
    let authority = private_authority("futo notes test authority");
    let (address, _) = serve_https(&authority).await;

    let error = auth_mode(
        &format!("https://{address}"),
        &server_cert_verifier().unwrap(),
    )
    .await
    .expect_err("handshake must fail");

    assert!(
        error.contains("invalid peer certificate"),
        "expected a certificate rejection, got: {error}"
    );
}

#[tokio::test]
async fn a_changed_trust_file_is_honored_on_the_next_handshake_and_only_then() {
    let ours = private_authority("futo notes test authority");
    let other =
        private_authority("an unrelated authority with a deliberately much longer common name");
    let (address, _) = serve_https(&ours).await;
    let url = format!("https://{address}");
    let path = trust_file(&ours.certificate_authority_der);
    let builds = Arc::new(AtomicUsize::new(0));
    let counted = builds.clone();
    let watched = path.clone();
    let verifier = ReloadingVerifier::new(vec![path.clone()], move || {
        counted.fetch_add(1, Ordering::SeqCst);
        verifier_from_file(&watched)
    })
    .unwrap();
    let verifier: Arc<dyn ServerCertVerifier> = Arc::new(verifier);

    assert_eq!(auth_mode(&url, &verifier).await.unwrap(), "password");
    assert_eq!(auth_mode(&url, &verifier).await.unwrap(), "password");
    assert_eq!(builds.load(Ordering::SeqCst), 1);

    std::fs::write(&path, &other.certificate_authority_der).unwrap();

    let error = auth_mode(&url, &verifier)
        .await
        .expect_err("the replaced authority must no longer vouch for the server");
    assert!(
        error.contains("invalid peer certificate"),
        "expected a certificate rejection, got: {error}"
    );
    assert_eq!(builds.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn an_unreadable_trust_file_keeps_the_previous_verifier() {
    let ours = private_authority("futo notes test authority");
    let (address, _) = serve_https(&ours).await;
    let url = format!("https://{address}");
    let path = trust_file(&ours.certificate_authority_der);
    let watched = path.clone();
    let verifier =
        ReloadingVerifier::new(vec![path.clone()], move || verifier_from_file(&watched)).unwrap();
    let verifier: Arc<dyn ServerCertVerifier> = Arc::new(verifier);

    assert_eq!(auth_mode(&url, &verifier).await.unwrap(), "password");
    std::fs::remove_file(&path).unwrap();

    assert_eq!(auth_mode(&url, &verifier).await.unwrap(), "password");
}

#[tokio::test]
async fn a_root_removed_while_its_connection_is_pooled_fails_the_next_request() {
    let authority = private_authority("futo notes test authority");
    let (address, handshakes) = serve_https(&authority).await;
    let url = format!("https://{address}");
    let (trust_path, verifier) = file_backed_trust(&authority);
    let clients = HttpClients::with_verifier(Some(verifier)).unwrap();
    let auth_mode = || async { clients.for_base(&url).unwrap().auth_mode().await };

    assert_eq!(auth_mode().await.unwrap(), "password");
    assert_eq!(auth_mode().await.unwrap(), "password");
    assert_eq!(handshakes.load(Ordering::SeqCst), 1);
    assert_eq!(clients.generation(), 0);

    remove_trusted_root(&trust_path);

    let error = auth_mode()
        .await
        .expect_err("a pooled connection must not outlive the root that vouched for it");
    assert!(
        error.message.contains("invalid peer certificate"),
        "expected a certificate rejection, got: {}",
        error.message
    );
    assert_eq!(clients.generation(), 1);
}

#[tokio::test]
async fn a_cycle_that_fails_early_still_drops_connections_whose_root_was_removed() {
    let authority = private_authority("futo notes test authority");
    let (address, _) = serve_https(&authority).await;
    let url = format!("https://{address}");
    let (trust_path, verifier) = file_backed_trust(&authority);
    let clients = HttpClients::with_verifier(Some(verifier)).unwrap();
    clients.for_base(&url).unwrap().auth_mode().await.unwrap();
    remove_trusted_root(&trust_path);
    let state = crate::checkpoint::ConnectedState::new(
        url,
        "token".into(),
        "user".into(),
        "collection".into(),
        [3; 32],
    );
    let missing_vault = std::env::temp_dir().join(format!("futo-missing-{}", uuid::Uuid::now_v7()));

    let failure = crate::sync::cycle_with_checkpoint_and_clients(
        &state,
        &missing_vault,
        &|_| {},
        &|_| {},
        &crate::checkpoint::save,
        &crate::journal::SyncRunJournal::disabled(),
        &clients,
    )
    .await
    .expect_err("a missing vault fails the cycle");

    assert!(matches!(
        failure.kind,
        crate::sync::SyncErrorKind::VaultMissing(_)
    ));
    assert_eq!(clients.generation(), 1);
}

#[test]
fn the_shared_verifier_is_built_once() {
    let first = super::shared_verifier().unwrap();
    let second = super::shared_verifier().unwrap();

    assert!(Arc::ptr_eq(&first, &second));
}

#[cfg(target_os = "linux")]
fn update_ca_certificates(fresh: bool) {
    let mut command = std::process::Command::new("update-ca-certificates");
    if fresh {
        command.arg("--fresh");
    }
    assert!(command.status().unwrap().success());
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "rewrites the system CA bundle as root; run: docker run --rm -v $PWD:/repo -w /repo rust:1.89-bookworm cargo test -p futo-notes-sync --lib tls -- --include-ignored"]
async fn a_ca_installed_with_update_ca_certificates_is_honored_on_the_next_handshake() {
    let ours = private_authority("futo notes linux trust check");
    let (address, _) = serve_https(&ours).await;
    let url = format!("https://{address}");
    let installed =
        std::path::Path::new("/usr/local/share/ca-certificates/futo-notes-trust-check.crt");
    let verifier = server_cert_verifier().unwrap();

    let rejected = auth_mode(&url, &verifier)
        .await
        .expect_err("not yet installed");
    assert!(rejected.contains("invalid peer certificate"), "{rejected}");

    std::fs::write(installed, &ours.certificate_authority_pem).unwrap();
    update_ca_certificates(false);
    assert_eq!(auth_mode(&url, &verifier).await.unwrap(), "password");

    std::fs::remove_file(installed).unwrap();
    update_ca_certificates(true);
    let rejected = auth_mode(&url, &verifier).await.expect_err("removed again");
    assert!(rejected.contains("invalid peer certificate"), "{rejected}");
}

#[test]
fn the_client_offers_http2_before_http11() {
    let config = client_config_with(server_cert_verifier().unwrap()).unwrap();

    assert_eq!(
        config.alpn_protocols,
        [b"h2".to_vec(), b"http/1.1".to_vec()]
    );
}
