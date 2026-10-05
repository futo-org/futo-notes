use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use rustls::client::danger::ServerCertVerifier;
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use rustls::RootCertStore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::reloading::ReloadingVerifier;
use super::{client_config, client_config_with};
use crate::server::Http;

struct PrivateAuthority {
    certificate_authority_der: Vec<u8>,
    #[cfg(target_os = "linux")]
    certificate_authority_pem: String,
    leaf_der: Vec<u8>,
    leaf_key_der: Vec<u8>,
}

fn private_authority(common_name: &str) -> PrivateAuthority {
    let mut authority_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    authority_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    authority_params.distinguished_name.push(
        DnType::CommonName,
        format!("{common_name} {}", uuid::Uuid::now_v7()),
    );
    let authority_key = KeyPair::generate().unwrap();
    let authority_certificate = authority_params.self_signed(&authority_key).unwrap();
    let certificate_authority_der = authority_certificate.der().to_vec();

    let leaf_key = KeyPair::generate().unwrap();
    let leaf_params = CertificateParams::new(vec!["127.0.0.1".to_owned()]).unwrap();
    let issuer = Issuer::new(authority_params, authority_key);
    let leaf_certificate = leaf_params.signed_by(&leaf_key, &issuer).unwrap();

    PrivateAuthority {
        certificate_authority_der,
        #[cfg(target_os = "linux")]
        certificate_authority_pem: authority_certificate.pem(),
        leaf_der: leaf_certificate.der().to_vec(),
        leaf_key_der: leaf_key.serialize_der(),
    }
}

async fn serve_https(authority: &PrivateAuthority) -> SocketAddr {
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(authority.leaf_der.clone())],
        PrivatePkcs8KeyDer::from(authority.leaf_key_der.clone()).into(),
    )
    .unwrap();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(stream).await else {
                    return;
                };
                let mut request = Vec::new();
                let mut chunk = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match tls.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                let body = br#"{"auth_mode":"password"}"#;
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = tls.write_all(head.as_bytes()).await;
                let _ = tls.write_all(body).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    address
}

fn trust_file(der: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("futo-notes-trust-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ca.der");
    std::fs::write(&path, der).unwrap();
    path
}

fn verifier_from_file(path: &Path) -> Result<Arc<dyn ServerCertVerifier>, rustls::Error> {
    let der = std::fs::read(path).map_err(|error| rustls::Error::General(error.to_string()))?;
    let mut store = RootCertStore::empty();
    store.add(CertificateDer::from(der))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(store), provider)
        .build()
        .map_err(|error| rustls::Error::General(error.to_string()))?;
    Ok(verifier)
}

async fn auth_mode(url: &str, config: &Arc<rustls::ClientConfig>) -> Result<String, String> {
    Http::with_tls(url, Some(config.clone()))
        .unwrap()
        .auth_mode()
        .await
        .map_err(|error| error.message)
}

#[tokio::test]
async fn a_privately_signed_server_is_rejected_without_its_root() {
    let authority = private_authority("futo notes test authority");
    let address = serve_https(&authority).await;

    let error = auth_mode(&format!("https://{address}"), &client_config().unwrap())
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
    let address = serve_https(&ours).await;
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
    let config = client_config_with(Arc::new(verifier)).unwrap();

    assert_eq!(auth_mode(&url, &config).await.unwrap(), "password");
    assert_eq!(auth_mode(&url, &config).await.unwrap(), "password");
    assert_eq!(builds.load(Ordering::SeqCst), 1);

    std::fs::write(&path, &other.certificate_authority_der).unwrap();

    let error = auth_mode(&url, &config)
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
    let address = serve_https(&ours).await;
    let url = format!("https://{address}");
    let path = trust_file(&ours.certificate_authority_der);
    let watched = path.clone();
    let verifier =
        ReloadingVerifier::new(vec![path.clone()], move || verifier_from_file(&watched)).unwrap();
    let config = client_config_with(Arc::new(verifier)).unwrap();

    assert_eq!(auth_mode(&url, &config).await.unwrap(), "password");
    std::fs::remove_file(&path).unwrap();

    assert_eq!(auth_mode(&url, &config).await.unwrap(), "password");
}

#[test]
fn the_shared_configuration_is_built_once() {
    let first = super::shared_client_config().unwrap();
    let second = super::shared_client_config().unwrap();

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
    let address = serve_https(&ours).await;
    let url = format!("https://{address}");
    let installed = Path::new("/usr/local/share/ca-certificates/futo-notes-trust-check.crt");
    let config = client_config().unwrap();

    let rejected = auth_mode(&url, &config)
        .await
        .expect_err("not yet installed");
    assert!(rejected.contains("invalid peer certificate"), "{rejected}");

    std::fs::write(installed, &ours.certificate_authority_pem).unwrap();
    update_ca_certificates(false);
    assert_eq!(auth_mode(&url, &config).await.unwrap(), "password");

    std::fs::remove_file(installed).unwrap();
    update_ca_certificates(true);
    let rejected = auth_mode(&url, &config).await.expect_err("removed again");
    assert!(rejected.contains("invalid peer certificate"), "{rejected}");
}

#[test]
fn the_client_offers_http2_before_http11() {
    let config = client_config().unwrap();

    assert_eq!(
        config.alpn_protocols,
        [b"h2".to_vec(), b"http/1.1".to_vec()]
    );
}
