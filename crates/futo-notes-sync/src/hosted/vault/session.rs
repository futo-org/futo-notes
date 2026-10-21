//! Connecting sync from the unlocked vault, signing out, and restoring a saved session.

use super::*;

impl HostedSetup {
    /// Hands this device's hosted secrets to the sync engine, so cycles can
    /// run. The step after [`SetupStep::Ready`], and the mirror image of
    /// [`HostedSetup::sign_out`].
    ///
    /// Every door out of the wizard ends here — a vault password, a recovery
    /// key, or a paired device — because all three end with the same two
    /// secrets in the same place. It is safe to call again: connecting an
    /// already-connected session rebuilds it from the same facts, which is what
    /// makes it callable whenever a shell notices the vault is unlocked rather
    /// than only at the one moment it became so.
    ///
    /// Refuses rather than half-connecting: a device with no vault key is
    /// [`HostedError::VaultLocked`], and one with no session is
    /// [`HostedError::NotSignedIn`].
    ///
    /// This is also where a device stops being a self-hosted one. Reaching the
    /// line below means all three hosted facts are in hand — a live session, a
    /// vault key, a collection — which is the first moment it is certain the
    /// wizard actually finished, so the self-hosted sync password goes
    /// ([`VaultSecrets::delete_sync_password`]). Before that line and not
    /// after, for two reasons: opening the hosted screen on a self-hosted
    /// device must not cost someone the password they still need, and a
    /// connect that then fails because the phone is offline must still leave
    /// the next launch resuming *this* vault rather than dialing the old
    /// server.
    pub async fn connect_sync(&self, sync: &SyncSession, root: &Path) -> Result<(), HostedError> {
        let session = self
            .restored_session()
            .await?
            .ok_or(HostedError::NotSignedIn)?;
        let vault_key = self
            .stored_vault_key()
            .await?
            .ok_or(HostedError::VaultLocked)?;
        let collection_id = self.collection().await?;
        let secrets = self.secrets()?;
        blocking_secrets(secrets, |store| store.delete_sync_password()).await?;
        sync.connect_hosted(
            root,
            crate::HostedCredentials {
                server_url: self.server_url().to_owned(),
                token: session.token,
                user_id: session.user_id,
                collection_id,
                vault_key,
            },
        )
        .await
        .map_err(|error| HostedError::Server(error.to_string()))
    }

    /// Whether this device has a hosted vault it can resume: **both** secrets
    /// in the secret store, read locally with no request of any kind.
    ///
    /// This is the cold-start question, and it is deliberately not
    /// [`HostedSetup::current_step`] or [`HostedSetup::connect_sync`] — both of
    /// those validate the saved token with `current_user` and resolve the
    /// collection, so on a fresh process both reach the network before they can
    /// answer anything. A shell restoring a session at launch has to know
    /// whether this vault is hosted *before* it is willing to spend a round
    /// trip, and offline it has to know without one at all.
    ///
    /// Both or neither: a token with no vault key cannot decrypt, and a vault
    /// key with no token cannot authenticate, so either one alone is not a
    /// session to resume. A setup with no secret store attached refuses rather
    /// than answering `false`, which a shell would read as "not hosted".
    pub async fn has_saved_vault(&self) -> Result<bool, HostedError> {
        let secrets = self.secrets()?;
        blocking_secrets(secrets, |store| {
            Ok(store.vault_key()?.is_some() && store.session_token()?.is_some())
        })
        .await
    }

    /// Signs out: revoke the session on the server, forget both secrets, and
    /// demote this vault's sync state exactly as disconnect does — one action,
    /// with no locked-but-signed-in halfway state left behind (ADR 0003,
    /// decision 9). The notes on disk are untouched.
    ///
    /// The server call is best-effort. A person who taps Sign out on a plane
    /// is signed out of this device either way; the session ages out on its
    /// own.
    pub async fn sign_out(&self, sync: &SyncSession, root: &Path) -> Result<(), HostedError> {
        if let Ok(http) = self.authorized().await {
            let _ = http.logout().await;
        }
        *self.session.lock().expect("hosted session lock") = None;
        *self.collection_id.lock().expect("hosted collection lock") = None;

        let secrets = self.secrets()?;
        let forgotten = blocking_secrets(secrets, |store| {
            let key = store.delete_vault_key();
            let token = store.delete_session_token();
            key.and(token)
        })
        .await;

        sync.disconnect(root)
            .await
            .map_err(|error| HostedError::Server(error.to_string()))?;
        forgotten
    }

    /// This attempt's collection, once one has been resolved.
    pub fn collection_id(&self) -> Option<String> {
        self.collection_id
            .lock()
            .expect("hosted collection lock")
            .clone()
    }

    /// The session this setup is acting as, adopting the token this device
    /// saved if the attempt has none of its own. A saved token the server no
    /// longer accepts is deleted rather than retried on every start; the vault
    /// key is left exactly where it is, because an expired session is a trip
    /// to the browser and never a vault reset.
    pub(in crate::hosted) async fn restored_session(
        &self,
    ) -> Result<Option<HostedSession>, HostedError> {
        if let Some(session) = self.session() {
            return Ok(Some(session));
        }
        // A setup with no secret store has nothing saved to adopt; only the
        // steps that must keep a secret refuse outright.
        let Some(secrets) = self.secrets.clone() else {
            return Ok(None);
        };
        let Some(token) = blocking_secrets(secrets, |store| store.session_token()).await? else {
            return Ok(None);
        };
        match self.http()?.token(token.clone()).current_user().await {
            Ok(Some(user)) => {
                let session = HostedSession {
                    user_id: user.id,
                    email: user.email,
                    name: user.name,
                    token,
                };
                *self.session.lock().expect("hosted session lock") = Some(session.clone());
                Ok(Some(session))
            }
            Ok(None) | Err(HostedError::SignInAgain) => {
                let secrets = self.secrets()?;
                blocking_secrets(secrets, |store| store.delete_session_token()).await?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}
