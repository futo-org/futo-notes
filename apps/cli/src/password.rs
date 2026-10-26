//! Where the sync password comes from: the configured password command, else a
//! no-echo prompt on the controlling terminal. Never an argument, never the
//! configuration, never an environment variable this CLI defines, never output.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{CliError, CliResult, Code};
use crate::i18n::{t, tf};

const COMMAND_DEADLINE: Duration = Duration::from_secs(60);

pub fn obtain(command: Option<&str>, json: bool) -> CliResult<String> {
    match command {
        Some(command) => run_command(command, command_deadline()),
        // `--json` never prompts, and with no terminal there is nobody to ask:
        // fail at once rather than wait on input a timer can never give.
        None if json => Err(auth_failed(t("cli.errors.passwordNoTerminal"))),
        None => rpassword::prompt_password(format!("{} ", t("cli.prompt.password")))
            .map_err(|_| auth_failed(t("cli.errors.passwordNoTerminal"))),
    }
}

fn auth_failed(message: String) -> CliError {
    CliError::new(Code::AuthFailed, message)
}

/// Split like the editor command (no shell), so a stored command line cannot
/// expand variables or chain other commands.
pub fn split_command(command: &str) -> Option<Vec<String>> {
    shlex::split(command).filter(|words| !words.is_empty())
}

fn command_deadline() -> Duration {
    // Debug builds only, so tests can prove the deadline without a minute's wait.
    if cfg!(debug_assertions) {
        if let Some(ms) = std::env::var("FUTO_NOTES_CLI_TEST_PASSWORD_DEADLINE_MS")
            .ok()
            .and_then(|value| value.parse().ok())
        {
            return Duration::from_millis(ms);
        }
    }
    COMMAND_DEADLINE
}

fn run_command(command: &str, deadline: Duration) -> CliResult<String> {
    let failed = |reason: &str| {
        auth_failed(tf(
            "cli.errors.passwordCommandFailed",
            &[("reason", &t(reason))],
        ))
    };
    let words = split_command(command).ok_or_else(|| failed("cli.errors.passwordCommandParse"))?;
    // stdin and stderr are inherited so `pass` or `gpg` can prompt; stdout is
    // the password and is never echoed anywhere.
    let mut child = Command::new(&words[0])
        .args(&words[1..])
        .stdin(Stdio::inherit())
        .stderr(Stdio::inherit())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| failed("cli.errors.passwordCommandStart"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed("cli.errors.passwordCommandTimeout"));
            }
            Err(_) => return Err(failed("cli.errors.passwordCommandStart")),
        }
    };
    if !status.success() {
        return Err(failed("cli.errors.passwordCommandExit"));
    }
    let bytes = reader
        .join()
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| failed("cli.errors.passwordCommandStart"))?;
    let mut password =
        String::from_utf8(bytes).map_err(|_| failed("cli.errors.passwordCommandEmpty"))?;
    if password.ends_with('\n') {
        password.pop();
    }
    if password.is_empty() {
        return Err(failed("cli.errors.passwordCommandEmpty"));
    }
    Ok(password)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_trailing_newline_is_removed() {
        let password = run_command("printf 'pw \\n\\n'", COMMAND_DEADLINE).unwrap();
        assert_eq!(password, "pw \n");
    }

    #[test]
    fn a_failing_empty_or_slow_command_is_auth_failed() {
        for command in ["false", "printf ''", "printf '\\n'", "no-such-binary-futo"] {
            let error = run_command(command, COMMAND_DEADLINE).unwrap_err();
            assert_eq!(error.code, Code::AuthFailed, "{command}");
        }
        let started = Instant::now();
        let error = run_command("sleep 5", Duration::from_millis(200)).unwrap_err();
        assert_eq!(error.code, Code::AuthFailed);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn the_command_runs_without_a_shell() {
        // `$HOME` stays literal: no shell expanded it.
        let password = run_command("printf %s $HOME", COMMAND_DEADLINE).unwrap();
        assert_eq!(password, "$HOME");
    }
}
