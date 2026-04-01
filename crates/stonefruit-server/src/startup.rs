use rusqlite::Connection;

use crate::{db, password};

pub fn maybe_seed_dev_password(
    conn: &Connection,
    dev_password: Option<&str>,
) -> Result<bool, String> {
    let Some(password) = dev_password
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };

    password::validate_password(password)?;
    let password_hash = password::hash_password(password)?;

    db::insert_initial_password_hash(conn, &password_hash).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_password_when_auth_is_empty() {
        let conn = db::open_memory_db().unwrap();

        let seeded = maybe_seed_dev_password(&conn, Some("testing123")).unwrap();
        assert!(seeded);
        assert!(db::is_setup_complete(&conn).unwrap());

        let stored_hash: String = conn
            .query_row("SELECT password_hash FROM auth WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        password::verify_password("testing123", &stored_hash).unwrap();
    }

    #[test]
    fn does_not_override_existing_password() {
        let conn = db::open_memory_db().unwrap();
        let original_hash = password::hash_password("original123").unwrap();
        db::insert_initial_password_hash(&conn, &original_hash).unwrap();

        let seeded = maybe_seed_dev_password(&conn, Some("testing123")).unwrap();
        assert!(!seeded);

        let stored_hash: String = conn
            .query_row("SELECT password_hash FROM auth WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        password::verify_password("original123", &stored_hash).unwrap();
    }

    #[test]
    fn ignores_missing_password() {
        let conn = db::open_memory_db().unwrap();

        let seeded = maybe_seed_dev_password(&conn, None).unwrap();
        assert!(!seeded);
        assert!(!db::is_setup_complete(&conn).unwrap());
    }
}
