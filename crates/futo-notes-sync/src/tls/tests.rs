use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::client_config;
use crate::server::Http;

struct PrivateAuthority {
    certificate_authority_der: Vec<u8>,
    #[allow(dead_code)]
    certificate_authority_pem: String,
    leaf_der: Vec<u8>,
    leaf_key_der: Vec<u8>,
}

fn private_authority() -> PrivateAuthority {
    let mut authority_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    authority_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    authority_params.distinguished_name.push(
        DnType::CommonName,
        format!("futo notes test authority {}", uuid::Uuid::now_v7()),
    );
    let authority_key = KeyPair::generate().unwrap();
    let authority_certificate = authority_params.self_signed(&authority_key).unwrap();
    let certificate_authority_der = authority_certificate.der().to_vec();
    let certificate_authority_pem = authority_certificate.pem();

    let leaf_key = KeyPair::generate().unwrap();
    let leaf_params = CertificateParams::new(vec!["127.0.0.1".to_owned()]).unwrap();
    let issuer = Issuer::new(authority_params, authority_key);
    let leaf_certificate = leaf_params.signed_by(&leaf_key, &issuer).unwrap();

    PrivateAuthority {
        certificate_authority_der,
        certificate_authority_pem,
        leaf_der: leaf_certificate.der().to_vec(),
        leaf_key_der: leaf_key.serialize_der(),
    }
}

async fn serve_https(authority: &PrivateAuthority) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
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
    let negotiated = Arc::new(Mutex::new(Vec::new()));
    let recorder = negotiated.clone();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            let recorder = recorder.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(stream).await else {
                    return;
                };
                let protocol = tls
                    .get_ref()
                    .1
                    .alpn_protocol()
                    .map(|name| String::from_utf8_lossy(name).into_owned())
                    .unwrap_or_default();
                recorder.lock().unwrap().push(protocol);
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
    (address, negotiated)
}

#[tokio::test]
async fn a_privately_signed_server_is_rejected_without_its_root() {
    let authority = private_authority();
    let (address, _) = serve_https(&authority).await;
    let http = Http::with_tls(&format!("https://{address}"), client_config(&[]).unwrap()).unwrap();

    let error = http.auth_mode().await.expect_err("handshake must fail");

    assert!(
        error.message.contains("UnknownIssuer"),
        "expected an unknown-issuer rejection, got: {}",
        error.message
    );
}

#[tokio::test]
async fn a_privately_signed_server_is_accepted_with_its_root_as_an_extra_anchor() {
    let authority = private_authority();
    let (address, negotiated) = serve_https(&authority).await;
    let http = Http::with_tls(
        &format!("https://{address}"),
        client_config(&[authority.certificate_authority_der.clone()]).unwrap(),
    )
    .unwrap();

    assert_eq!(http.auth_mode().await.unwrap(), "password");
    assert_eq!(
        negotiated.lock().unwrap().as_slice(),
        ["http/1.1".to_owned()]
    );
}

#[tokio::test]
async fn an_unparsable_supplied_anchor_is_skipped_rather_than_breaking_every_request() {
    let authority = private_authority();
    let (address, _) = serve_https(&authority).await;
    let http = Http::with_tls(
        &format!("https://{address}"),
        client_config(&[
            b"not a certificate".to_vec(),
            authority.certificate_authority_der.clone(),
        ])
        .unwrap(),
    )
    .unwrap();

    assert_eq!(http.auth_mode().await.unwrap(), "password");
}

#[tokio::test]
async fn installing_different_anchors_rebuilds_the_shared_configuration() {
    let authority = private_authority();
    let (address, _) = serve_https(&authority).await;
    super::install_extra_root_certificates(Vec::new());
    let without = super::shared_client_config().unwrap();

    super::install_extra_root_certificates(vec![authority.certificate_authority_der.clone()]);
    let with = super::shared_client_config().unwrap();
    super::install_extra_root_certificates(Vec::new());

    assert!(Http::with_tls(&format!("https://{address}"), without)
        .unwrap()
        .auth_mode()
        .await
        .is_err());
    assert_eq!(
        Http::with_tls(&format!("https://{address}"), with)
            .unwrap()
            .auth_mode()
            .await
            .unwrap(),
        "password"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_privately_signed_server_is_accepted_from_the_operating_system_store() {
    let authority = private_authority();
    let (address, _) = serve_https(&authority).await;
    let bundle = std::env::temp_dir().join(format!("futo-tls-{}.pem", uuid::Uuid::now_v7()));
    std::fs::write(&bundle, &authority.certificate_authority_pem).unwrap();
    std::env::set_var("SSL_CERT_FILE", &bundle);

    let config = client_config(&[]).unwrap();

    std::env::remove_var("SSL_CERT_FILE");
    let _ = std::fs::remove_file(&bundle);
    let http = Http::with_tls(&format!("https://{address}"), config).unwrap();

    assert_eq!(http.auth_mode().await.unwrap(), "password");
}
