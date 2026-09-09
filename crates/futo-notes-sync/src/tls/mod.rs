#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, PoisonError};

use rustls::pki_types::CertificateDer;
use rustls::ClientConfig;

const ALPN_PROTOCOLS: [&[u8]; 2] = [b"h2", b"http/1.1"];

type Trust = (Vec<Vec<u8>>, Option<Arc<ClientConfig>>);

static TRUST: Mutex<Trust> = Mutex::new((Vec::new(), None));

pub fn install_process_root_certificates(certificates: Vec<Vec<u8>>) {
    *TRUST.lock().unwrap_or_else(PoisonError::into_inner) = (certificates, None);
}

pub(crate) fn shared_client_config() -> Result<Arc<ClientConfig>, String> {
    let mut trust = TRUST.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(config) = &trust.1 {
        return Ok(config.clone());
    }
    let config = client_config(&trust.0)?;
    trust.1 = Some(config.clone());
    Ok(config)
}

pub(crate) fn client_config(extra_roots: &[Vec<u8>]) -> Result<Arc<ClientConfig>, String> {
    trusted_roots(extra_roots)
        .map(|mut config| {
            config.alpn_protocols = ALPN_PROTOCOLS.iter().map(|name| name.to_vec()).collect();
            Arc::new(config)
        })
        .map_err(|error| format!("could not build the TLS trust store: {error}"))
}

fn crypto_provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn supplied_roots(extra_roots: &[Vec<u8>]) -> impl Iterator<Item = CertificateDer<'static>> + '_ {
    extra_roots
        .iter()
        .map(|der| CertificateDer::from(der.clone()))
}

#[cfg(any(target_os = "android", test))]
fn bundled_mozilla_roots() -> impl Iterator<Item = CertificateDer<'static>> {
    webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().cloned()
}

#[cfg(not(target_os = "android"))]
fn trusted_roots(extra_roots: &[Vec<u8>]) -> Result<ClientConfig, rustls::Error> {
    let provider = crypto_provider();
    let verifier = if extra_roots.is_empty() {
        rustls_platform_verifier::Verifier::new(provider.clone())?
    } else {
        rustls_platform_verifier::Verifier::new_with_extra_roots(
            supplied_roots(extra_roots),
            provider.clone(),
        )?
    };
    Ok(ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

#[cfg(target_os = "android")]
fn trusted_roots(extra_roots: &[Vec<u8>]) -> Result<ClientConfig, rustls::Error> {
    let provider = crypto_provider();
    let mut store = rustls::RootCertStore::empty();
    store.add_parsable_certificates(bundled_mozilla_roots().chain(supplied_roots(extra_roots)));
    Ok(ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(store)
        .with_no_client_auth())
}
