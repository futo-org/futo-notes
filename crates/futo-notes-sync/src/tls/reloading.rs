use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};

type TrustSourceStamp = Vec<Option<(SystemTime, u64)>>;
type Verifier = Arc<dyn ServerCertVerifier>;
type BuildVerifier = dyn Fn() -> Result<Verifier, Error> + Send + Sync;

pub(super) struct ReloadingVerifier {
    sources: Vec<PathBuf>,
    build: Box<BuildVerifier>,
    current: Mutex<(TrustSourceStamp, Verifier)>,
}

impl ReloadingVerifier {
    pub(super) fn new(
        sources: Vec<PathBuf>,
        build: impl Fn() -> Result<Verifier, Error> + Send + Sync + 'static,
    ) -> Result<Self, Error> {
        let current = Mutex::new((stat_trust_sources(&sources), build()?));
        Ok(Self {
            sources,
            build: Box::new(build),
            current,
        })
    }

    fn current(&self) -> Verifier {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        let observed = stat_trust_sources(&self.sources);
        if observed != current.0 {
            if let Ok(rebuilt) = (self.build)() {
                *current = (observed, rebuilt);
            }
        }
        current.1.clone()
    }
}

impl fmt::Debug for ReloadingVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReloadingVerifier")
            .field("sources", &self.sources)
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for ReloadingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        self.current().verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.current().verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.current().verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.current().supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.current().requires_raw_public_keys()
    }
}

fn stat_trust_sources(sources: &[PathBuf]) -> TrustSourceStamp {
    sources
        .iter()
        .map(|path| {
            let metadata = std::fs::metadata(path).ok()?;
            Some((metadata.modified().ok()?, metadata.len()))
        })
        .collect()
}

#[cfg(target_os = "linux")]
pub(super) fn native_certificate_paths() -> Vec<PathBuf> {
    let file = std::env::var_os("SSL_CERT_FILE").map(PathBuf::from);
    let dirs: Vec<PathBuf> = std::env::var_os("SSL_CERT_DIR")
        .map(|dirs| {
            std::env::split_paths(&dirs)
                .filter(|path| !path.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if file.is_some() || !dirs.is_empty() {
        return file.into_iter().chain(dirs).collect();
    }
    let probe = openssl_probe::probe();
    probe.cert_file.into_iter().chain(probe.cert_dir).collect()
}
