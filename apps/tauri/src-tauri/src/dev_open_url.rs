//! How a debug build opens a link: in the background, in a browser the developer picks.
//!
//! An agent driving the dev app presses "Buy a license", "Log in with FUTO" and
//! "Manage subscription" for real, and each one opens a page. Opened the normal way,
//! the browser comes to the front over whatever the developer is doing, every time.
//! Here `open -g` loads the page without activating anything, and a web page goes to
//! `FUTO_DEV_BROWSER` (Safari when unset), so those tabs collect in a browser the
//! developer doesn't otherwise use. A `mailto:` or `tel:` link still goes to its own
//! handler, in the background too. Links a person clicks in the dev app go the same
//! way, by design.
//!
//! Release builds never reach this: `src/lib/platform/openExternalUrl.ts` calls it
//! only in a dev bundle and uses the opener plugin otherwise. Debug builds only, and
//! macOS only; elsewhere it opens the link the opener plugin's way.

/// What the opener plugin's default permission lets the page open; nothing else
/// reaches the shell, and none of them can be read as an `open` option.
const SCHEMES: [&str; 4] = ["http:", "https:", "mailto:", "tel:"];

#[tauri::command]
pub(crate) async fn dev_open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if cfg!(not(debug_assertions)) {
        return Err("dev_open_url exists in debug builds only".into());
    }
    if !is_openable(&url) {
        return Err(format!("not a link the app opens: {url}"));
    }
    crate::background_tasks::blocking(move || open(&app, &url)).await
}

fn is_openable(url: &str) -> bool {
    SCHEMES.iter().any(|scheme| has_scheme(url, scheme))
}

fn has_scheme(url: &str, scheme: &str) -> bool {
    url.get(..scheme.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
}

#[cfg(target_os = "macos")]
fn open(_app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("/usr/bin/open");
    command.arg("-g");
    if has_scheme(url, "http:") || has_scheme(url, "https:") {
        let browser = std::env::var("FUTO_DEV_BROWSER")
            .ok()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Safari".into());
        command.args(["-a", &browser]);
    }
    let output = command
        .arg(url)
        .output()
        .map_err(crate::background_tasks::io_error)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn open(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_opener_plugins_schemes_pass() {
        assert!(is_openable("https://futo.org/notes"));
        assert!(is_openable("HTTP://example.com"));
        assert!(is_openable("mailto:support@futo.org"));
        assert!(!is_openable("-a Calculator"));
        assert!(!is_openable("file:///etc/passwd"));
        assert!(!is_openable("javascript:alert(1)"));
        assert!(!is_openable("http"));
    }
}
