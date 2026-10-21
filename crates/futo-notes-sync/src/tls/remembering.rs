use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, SignatureScheme};

#[derive(Clone)]
struct VerifiedChain {
    end_entity: CertificateDer<'static>,
    intermediates: Vec<CertificateDer<'static>>,
    server_name: ServerName<'static>,
    ocsp_response: Vec<u8>,
}

impl VerifiedChain {
    fn is_same_chain(&self, other: &Self) -> bool {
        self.end_entity == other.end_entity
            && self.intermediates == other.intermediates
            && self.server_name == other.server_name
    }

    fn verify(&self, verifier: &dyn ServerCertVerifier, now: UnixTime) -> bool {
        verifier
            .verify_server_cert(
                &self.end_entity,
                &self.intermediates,
                &self.server_name,
                &self.ocsp_response,
                now,
            )
            .is_ok()
    }
}

pub(crate) struct RememberingVerifier {
    verifier: Arc<dyn ServerCertVerifier>,
    verified_chains: Mutex<Vec<VerifiedChain>>,
}

impl RememberingVerifier {
    pub(crate) fn new(verifier: Arc<dyn ServerCertVerifier>) -> Self {
        Self {
            verifier,
            verified_chains: Mutex::default(),
        }
    }

    pub(crate) fn trusts_every_verified_chain(&self) -> bool {
        let now = UnixTime::now();
        let remembered = self.verified_chains().clone();
        remembered
            .iter()
            .all(|chain| chain.verify(self.verifier.as_ref(), now))
    }

    fn verified_chains(&self) -> MutexGuard<'_, Vec<VerifiedChain>> {
        self.verified_chains
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl fmt::Debug for RememberingVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RememberingVerifier")
            .field("verifier", &self.verifier)
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for RememberingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let verified = self.verifier.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )?;
        let chain = VerifiedChain {
            end_entity: end_entity.clone().into_owned(),
            intermediates: intermediates
                .iter()
                .map(|certificate| certificate.clone().into_owned())
                .collect(),
            server_name: server_name.to_owned(),
            ocsp_response: ocsp_response.to_vec(),
        };
        let mut verified_chains = self.verified_chains();
        match verified_chains
            .iter_mut()
            .find(|known| known.is_same_chain(&chain))
        {
            Some(known) => known.ocsp_response = chain.ocsp_response,
            None => verified_chains.push(chain),
        }
        Ok(verified)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.verifier.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.verifier.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.verifier.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.verifier.requires_raw_public_keys()
    }
}
