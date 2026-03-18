use crate::cli::ResetPasswordArgs;
use crate::server_api;
use anyhow::{bail, Context, Result};
use std::fs;
use std::io::{self, BufRead};
use std::path::Path;

pub fn run(args: ResetPasswordArgs) -> Result<()> {
    // Read admin token from data directory
    let token_path = Path::new(&args.data_path).join(".admin-token");
    let admin_token = fs::read_to_string(&token_path)
        .with_context(|| {
            format!(
                "could not read admin token from {}. Is the server running and is --data-path correct?",
                token_path.display()
            )
        })?
        .trim()
        .to_string();

    if admin_token.is_empty() {
        bail!("admin token file is empty — restart the server to regenerate it");
    }

    // Resolve new password
    let new_password = if args.password_stdin {
        io::stdin()
            .lock()
            .lines()
            .next()
            .transpose()?
            .unwrap_or_default()
    } else if let Some(pw) = args.password {
        pw
    } else {
        // Prompt interactively
        eprint!("New password: ");
        let pw = rpassword::read_password().context("failed to read password")?;
        if pw.is_empty() {
            bail!("password cannot be empty");
        }
        eprint!("Confirm password: ");
        let confirm = rpassword::read_password().context("failed to read password")?;
        if pw != confirm {
            bail!("passwords do not match");
        }
        pw
    };

    if new_password.len() < 8 {
        bail!("password must be at least 8 characters");
    }

    server_api::reset_password(&args.base_url, &admin_token, &new_password)?;

    println!("Password reset successfully. All existing sessions have been revoked.");
    Ok(())
}
