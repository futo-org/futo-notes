//! Which sign-in a server wants, read from its capability document.

use super::HostedError;
use crate::server::Http;

/// How the app should log in to a given server.
///
/// Chosen from the capability document alone, never from the address: a
/// self-hosted server running in OIDC mode gets the same Log in with FUTO
/// sheet as the hosted service, and one build works against any deployment
/// (ADR 0003, decision 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInFlow {
    /// Log in with FUTO, through the Login Hand-off. `sells_subscriptions`
    /// is the capability document's `billing`: when it is true the account
    /// needs an entitlement before it may write, so the wizard has a
    /// subscribe step. A self-hosted OIDC server sells nothing and skips it.
    Hosted { sells_subscriptions: bool },
    /// Today's server-address-and-password form.
    Password,
    /// Passwordless dev-mode login, for development and tests.
    Dev,
}

/// Reads `GET /` and says how to log in.
pub async fn probe_sign_in_flow(server: &str) -> Result<SignInFlow, HostedError> {
    let http = Http::new(server).map_err(|error| HostedError::Network(error.message))?;
    let capabilities = http
        .capabilities()
        .await
        .map_err(|error| match error.status {
            Some(status) => HostedError::Server(format!("HTTP {status}: {}", error.message)),
            None => HostedError::Network(error.message),
        })?;
    Ok(sign_in_flow(&capabilities.auth_mode, capabilities.billing))
}

/// Pure mapping, so every combination is testable without a server.
fn sign_in_flow(auth_mode: &str, billing: bool) -> SignInFlow {
    match auth_mode {
        "oidc" => SignInFlow::Hosted {
            sells_subscriptions: billing,
        },
        "dev" => SignInFlow::Dev,
        // Anything this build does not recognise gets the password form,
        // which is what the engine already does when it drives login.
        _ => SignInFlow::Password,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oidc_plus_billing_is_the_hosted_service() {
        assert_eq!(
            sign_in_flow("oidc", true),
            SignInFlow::Hosted {
                sells_subscriptions: true
            }
        );
    }

    /// A self-hoster running OIDC gets the same sheet and no subscribe step.
    #[test]
    fn oidc_without_billing_is_hosted_sign_in_that_sells_nothing() {
        assert_eq!(
            sign_in_flow("oidc", false),
            SignInFlow::Hosted {
                sells_subscriptions: false
            }
        );
    }

    #[test]
    fn password_and_dev_modes_keep_their_own_logins() {
        assert_eq!(sign_in_flow("password", false), SignInFlow::Password);
        assert_eq!(sign_in_flow("dev", false), SignInFlow::Dev);
    }

    /// `billing: true` cannot conjure a hand-off out of a password server:
    /// there is no route to hand off to.
    #[test]
    fn an_unknown_mode_falls_back_to_the_password_form() {
        assert_eq!(sign_in_flow("password", true), SignInFlow::Password);
        assert_eq!(sign_in_flow("saml", true), SignInFlow::Password);
        assert_eq!(sign_in_flow("", false), SignInFlow::Password);
    }
}
