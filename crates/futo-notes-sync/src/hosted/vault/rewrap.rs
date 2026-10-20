//! Changing the vault password and issuing a new recovery key.

use super::*;

impl HostedSetup {
    /// Sets a new vault password on a vault this device is already holding
    /// the key to (ADR 0003, decision 10; parent spec user story 31).
    ///
    /// **It asks for no current secret.** The device has the vault key, so
    /// there is nothing to prove — and a device set up by scanning a QR code
    /// never knew the old password to be asked for it. The vault key itself is
    /// unchanged, which is the whole reason every other device carries on
    /// untouched: their copy of that key still opens every note, and they are
    /// never told anything happened (parent spec user story 33).
    ///
    /// Only the password envelope is rebuilt. The recovery envelope goes back
    /// unchanged in the same write, because a `PUT` replaces the whole of the
    /// key material and leaving it out would delete a working recovery door
    /// (server ADR 0006, rule 2).
    pub async fn change_vault_password(&self, new_password: &str) -> Result<(), HostedError> {
        if new_password.chars().count() < MIN_VAULT_PASSWORD_CHARS {
            return Err(HostedError::VaultPasswordTooShort {
                minimum: MIN_VAULT_PASSWORD_CHARS as u32,
            });
        }
        let password = new_password.to_owned();
        self.rewrap(move |vault_key, known| {
            let mut material = e2ee::wrap_vault_key_argon2id(vault_key, &password)?;
            material.recovery_key_salt = known.recovery_key_salt.clone();
            material.recovery_key_kdf = known.recovery_key_kdf.clone();
            material.recovery_encrypted_vault_key = known.recovery_encrypted_vault_key.clone();
            Ok((material, None))
        })
        .await
        .map(|_| ())
    }

    /// Issues a new recovery key and answers with it, once (ADR 0003, decision
    /// 10; parent spec user story 32).
    ///
    /// **The old key stops working the moment this lands**: the recovery
    /// envelope it opened is replaced by one wrapped under the new key, and
    /// there is only ever one. Like [`HostedSetup::create_vault`], nothing
    /// here keeps a copy of what it returns.
    ///
    /// Only the recovery envelope is rebuilt; the password envelope goes back
    /// unchanged, so the vault password a person already knows still works.
    pub async fn new_recovery_key(&self) -> Result<String, HostedError> {
        let recovery_key = self
            .rewrap(|vault_key, known| {
                let mut material = known.clone();
                let recovery_key = RecoveryKey::generate();
                material.set_recovery_envelope(vault_key, &recovery_key)?;
                Ok((material, Some(recovery_key.to_string())))
            })
            .await?;
        Ok(recovery_key.expect("a new recovery key is always produced"))
    }

    /// The shape both of the above share: re-wrap one envelope of the material
    /// this device last read, carry the other back untouched, and write both
    /// guarded by the revision that read came with.
    ///
    /// A stale guard is [`HostedError::VaultKeyChangedElsewhere`] and nothing
    /// else — no retry loop here, because retrying would overwrite whatever
    /// the other device did without anyone being told. What is adopted instead
    /// is the authoritative material the server sent with its refusal, so the
    /// person's own second press re-wraps from that and lands.
    async fn rewrap<F>(&self, build: F) -> Result<Option<String>, HostedError>
    where
        F: FnOnce(
                &[u8; KEY_BYTES],
                &KeyMaterial,
            ) -> Result<(KeyMaterial, Option<String>), E2eeError>
            + Send
            + 'static,
    {
        let vault_key = self
            .stored_vault_key()
            .await?
            .ok_or(HostedError::VaultLocked)?;
        let known = self.known_material().await?;
        let previous = known.key_updated_at.clone().ok_or_else(|| {
            HostedError::Server(
                "the server did not say when this vault's key material was last written".into(),
            )
        })?;

        let (mut material, produced) = blocking(move || build(&vault_key, &known))
            .await?
            .map_err(crypto)?;
        // The revision token travels as `previous_key_updated_at`; carrying a
        // second copy inside the material would say the same thing twice, in a
        // field the server writes rather than reads.
        material.key_updated_at = None;

        let collection = self.collection().await?;
        let written = self
            .authorized()
            .await?
            .rewrap_key(&collection, &material, &previous)
            .await
            .map_err(hosted_error)?;
        match written {
            KeyRewrap::Written(stored) => {
                self.remember_material(Some(stored));
                Ok(produced)
            }
            KeyRewrap::Stale(current) => {
                self.remember_material(Some(current));
                Err(HostedError::VaultKeyChangedElsewhere)
            }
        }
    }
}
