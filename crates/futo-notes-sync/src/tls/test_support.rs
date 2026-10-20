use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use rustls::client::danger::ServerCertVerifier;
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use rustls::RootCertStore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::reloading::ReloadingVerifier;

pub(crate) struct PrivateAuthority {
    pub(crate) certificate_authority_der: Vec<u8>,
    #[cfg(target_os = "linux")]
    pub(crate) certificate_authority_pem: String,
    leaf_der: Vec<u8>,
    leaf_key_der: Vec<u8>,
}

pub(crate) fn private_authority(common_name: &str) -> PrivateAuthority {
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

pub(crate) async fn serve_https(authority: &PrivateAuthority) -> (SocketAddr, Arc<AtomicUsize>) {
    let (address, handshakes, _) =
        serve_https_replying(authority, 200, r#"{"auth_mode":"password","objects":[]}"#).await;
    (address, handshakes)
}

/// [`serve_https`] answering every non-SSE request with `status` and `body`,
/// and recording each request's head, so a test can say what a client did or
/// did not send.
pub(crate) async fn serve_https_replying(
    authority: &PrivateAuthority,
    status: u16,
    body: &'static str,
) -> (SocketAddr, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
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
    let handshakes = Arc::new(AtomicUsize::new(0));
    let counted = handshakes.clone();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            let counted = counted.clone();
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(stream).await else {
                    return;
                };
                counted.fetch_add(1, Ordering::SeqCst);
                let mut chunk = [0u8; 1024];
                loop {
                    let mut request = Vec::new();
                    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                        match tls.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => request.extend_from_slice(&chunk[..read]),
                        }
                    }
                    recorded
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&request).into_owned());
                    if request.starts_with(b"GET /api/sync/events ") {
                        let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\nevent: ready\ndata: {}\n\n";
                        let _ = tls.write_all(head.as_bytes()).await;
                        std::future::pending::<()>().await;
                    }
                    let head = format!(
                        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
                        body.len()
                    );
                    if tls.write_all(head.as_bytes()).await.is_err()
                        || tls.write_all(body.as_bytes()).await.is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    (address, handshakes, requests)
}

pub(crate) fn trust_file(der: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("futo-notes-trust-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ca.der");
    std::fs::write(&path, der).unwrap();
    path
}

pub(crate) fn verifier_from_file(
    path: &Path,
) -> Result<Arc<dyn ServerCertVerifier>, rustls::Error> {
    let der = std::fs::read(path).map_err(|error| rustls::Error::General(error.to_string()))?;
    let mut store = RootCertStore::empty();
    store.add(CertificateDer::from(der))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(store), provider)
        .build()
        .map_err(|error| rustls::Error::General(error.to_string()))?;
    Ok(verifier)
}

pub(crate) fn file_backed_trust(
    authority: &PrivateAuthority,
) -> (PathBuf, Arc<dyn ServerCertVerifier>) {
    let path = trust_file(&authority.certificate_authority_der);
    let watched = path.clone();
    let verifier =
        ReloadingVerifier::new(vec![path.clone()], move || verifier_from_file(&watched)).unwrap();
    (path, Arc::new(verifier))
}

pub(crate) fn remove_trusted_root(path: &Path) {
    let other =
        private_authority("an unrelated authority with a deliberately much longer common name");
    std::fs::write(path, other.certificate_authority_der).unwrap();
}
