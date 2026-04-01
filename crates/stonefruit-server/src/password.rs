pub const MIN_PASSWORD_LENGTH: usize = 8;
pub const MAX_PASSWORD_LENGTH: usize = 256;

pub fn validate_password(password: &str) -> Result<(), String> {
    if password.len() < MIN_PASSWORD_LENGTH {
        return Err(format!(
            "Password must be at least {MIN_PASSWORD_LENGTH} characters"
        ));
    }
    if password.len() > MAX_PASSWORD_LENGTH {
        return Err(format!(
            "Password must be at most {MAX_PASSWORD_LENGTH} characters"
        ));
    }
    Ok(())
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt =
        argon2::password_hash::SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    let argon2 = argon2::Argon2::default();
    argon2::PasswordHasher::hash_password(&argon2, password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_password(password: &str, stored_hash: &str) -> Result<(), String> {
    let parsed_hash = argon2::PasswordHash::new(stored_hash).map_err(|e| e.to_string())?;
    argon2::PasswordVerifier::verify_password(
        &argon2::Argon2::default(),
        password.as_bytes(),
        &parsed_hash,
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify_round_trip() {
        let hash = hash_password("testing123").unwrap();
        verify_password("testing123", &hash).unwrap();
    }

    #[test]
    fn validate_rejects_short_passwords() {
        let err = validate_password("short").unwrap_err();
        assert!(err.contains("at least"));
    }
}
