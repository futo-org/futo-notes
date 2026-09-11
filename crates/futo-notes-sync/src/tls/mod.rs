#[cfg(any(target_os = "linux", test))]
mod reloading;
#[cfg(test)]
mod tests;

use std::sync::{Arc, OnceLock};

use rustls::client::danger::ServerCertVerifier;
use rustls::crypto::CryptoProvider;
use rustls::ClientConfig;

const ALPN_PROTOCOLS: [&[u8]; 2] = [b"h2", b"http/1.1"];

static SHARED: OnceLock<Arc<ClientConfig>> = OnceLock::new();

pub(crate) fn shared_client_config() -> Result<Arc<ClientConfig>, String> {
    if let Some(config) = SHARED.get() {
        return Ok(config.clone());
    }
    let config = client_config()?;
    Ok(SHARED.get_or_init(|| config).clone())
}

fn client_config() -> Result<Arc<ClientConfig>, String> {
    server_cert_verifier()
        .and_then(client_config_with)
        .map_err(|error| format!("could not build the TLS trust store: {error}"))
}

fn client_config_with(
    verifier: Arc<dyn ServerCertVerifier>,
) -> Result<Arc<ClientConfig>, rustls::Error> {
    let mut config = ClientConfig::builder_with_provider(crypto_provider())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = ALPN_PROTOCOLS.iter().map(|name| name.to_vec()).collect();
    config.resumption = rustls::client::Resumption::disabled();
    Ok(Arc::new(config))
}

#[cfg(target_os = "android")]
pub fn install_android_trust(
    env: &mut jni::JNIEnv,
    context: jni::objects::JObject,
) -> Result<(), jni::errors::Error> {
    rustls_platform_verifier::android::init_with_env(env, context)
}

fn crypto_provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn os_verifier() -> Result<Arc<dyn ServerCertVerifier>, rustls::Error> {
    Ok(Arc::new(rustls_platform_verifier::Verifier::new(
        crypto_provider(),
    )?))
}

#[cfg(not(target_os = "linux"))]
fn server_cert_verifier() -> Result<Arc<dyn ServerCertVerifier>, rustls::Error> {
    os_verifier()
}

#[cfg(target_os = "linux")]
fn server_cert_verifier() -> Result<Arc<dyn ServerCertVerifier>, rustls::Error> {
    Ok(Arc::new(reloading::ReloadingVerifier::new(
        reloading::native_certificate_paths(),
        os_verifier,
    )?))
}
