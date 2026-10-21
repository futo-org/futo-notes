#[cfg(any(target_os = "linux", test))]
mod reloading;
mod remembering;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

use std::sync::{Arc, OnceLock};

use rustls::client::danger::ServerCertVerifier;
use rustls::crypto::CryptoProvider;
use rustls::ClientConfig;

pub(crate) use remembering::RememberingVerifier;

const ALPN_PROTOCOLS: [&[u8]; 2] = [b"h2", b"http/1.1"];

static SHARED: OnceLock<Arc<dyn ServerCertVerifier>> = OnceLock::new();

pub(crate) fn shared_verifier() -> Result<Arc<dyn ServerCertVerifier>, String> {
    if let Some(verifier) = SHARED.get() {
        return Ok(verifier.clone());
    }
    let verifier = server_cert_verifier().map_err(trust_store_error)?;
    Ok(SHARED.get_or_init(|| verifier).clone())
}

pub(crate) fn trust_store_error(error: rustls::Error) -> String {
    format!("could not build the TLS trust store: {error}")
}

pub(crate) fn client_config_with(
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
