#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, PoisonError};

use rustls::pki_types::CertificateDer;
use rustls::ClientConfig;

const ALPN_PROTOCOLS: [&[u8]; 2] = [b"h2", b"http/1.1"];

static INSTALLED_ROOTS: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());
static CACHED_CONFIG: Mutex<Option<(Vec<Vec<u8>>, Arc<ClientConfig>)>> = Mutex::new(None);

pub fn install_extra_root_certificates(certificates: Vec<Vec<u8>>) {
    *INSTALLED_ROOTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = certificates;
}

pub(crate) fn shared_client_config() -> Result<Arc<ClientConfig>, String> {
    let installed = INSTALLED_ROOTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let mut cached = CACHED_CONFIG.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((anchors, config)) = cached.as_ref() {
        if *anchors == installed {
            return Ok(config.clone());
        }
    }
    let config = client_config(&installed)?;
    *cached = Some((installed, config.clone()));
    Ok(config)
}

pub(crate) fn client_config(extra_roots: &[Vec<u8>]) -> Result<Arc<ClientConfig>, String> {
    operating_system_and_bundled_roots(extra_roots)
        .map(|mut config| {
            config.alpn_protocols = ALPN_PROTOCOLS.iter().map(|name| name.to_vec()).collect();
            Arc::new(config)
        })
        .map_err(|error| format!("could not build the TLS trust store: {error}"))
}

fn crypto_provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn bundled_mozilla_roots() -> impl Iterator<Item = CertificateDer<'static>> {
    webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().cloned()
}

fn parsable_supplied_roots(extra_roots: &[Vec<u8>]) -> Vec<CertificateDer<'static>> {
    let mut parse_probe = rustls::RootCertStore::empty();
    extra_roots
        .iter()
        .map(|der| CertificateDer::from(der.clone()))
        .filter(|der| parse_probe.add(der.clone()).is_ok())
        .collect()
}

#[cfg(not(target_os = "android"))]
fn operating_system_and_bundled_roots(
    extra_roots: &[Vec<u8>],
) -> Result<ClientConfig, rustls::Error> {
    let provider = crypto_provider();
    let verifier = rustls_platform_verifier::Verifier::new_with_extra_roots(
        bundled_mozilla_roots().chain(parsable_supplied_roots(extra_roots)),
        provider.clone(),
    )?;
    Ok(ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

#[cfg(target_os = "android")]
fn operating_system_and_bundled_roots(
    extra_roots: &[Vec<u8>],
) -> Result<ClientConfig, rustls::Error> {
    let provider = crypto_provider();
    let mut store = rustls::RootCertStore::empty();
    store.add_parsable_certificates(
        bundled_mozilla_roots().chain(parsable_supplied_roots(extra_roots)),
    );
    Ok(ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(store)
        .with_no_client_auth())
}
