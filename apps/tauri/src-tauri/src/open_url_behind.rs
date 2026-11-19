//! Opening a link without bringing its browser forward: Mod+click and a middle click on a
//! web address in a note, as a browser's own background tab.
//!
//! macOS only: `open -g` loads the page in the default browser (or `browser`) and activates
//! nothing. Windows and Linux offer no dependable way to open a browser behind the window, so
//! there the link opens the opener plugin's way, in front.
//!
//! The page asks for it through `src/lib/platform/openExternalUrl.ts`; the debug build's own
//! opener (`dev_open_url.rs`) shares the scheme guard and the `open` call.

/// What the opener plugin's default permission lets the page open; nothing else
/// reaches the shell, and none of them can be read as an `open` option.
const SCHEMES: [&str; 4] = ["http:", "https:", "mailto:", "tel:"];

#[tauri::command]
pub(crate) async fn open_url_behind(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_openable(&url) {
        return Err(format!("not a link the app opens behind: {url}"));
    }
    crate::background_tasks::blocking(move || open_behind(&app, &url, None)).await
}

pub(crate) fn is_openable(url: &str) -> bool {
    SCHEMES.iter().any(|scheme| has_scheme(url, scheme))
}

fn has_scheme(url: &str, scheme: &str) -> bool {
    url.get(..scheme.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
}

/// Open `url` behind the window: a web page in `browser` when one is named, everything else
/// (and every page with none named) in its default handler.
#[cfg(target_os = "macos")]
pub(crate) fn open_behind(
    _app: &tauri::AppHandle,
    url: &str,
    browser: Option<&str>,
) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/open")
        .args(open_arguments(url, browser))
        .output()
        .map_err(crate::background_tasks::io_error)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn open_arguments<'a>(url: &'a str, browser: Option<&'a str>) -> Vec<&'a str> {
    let is_web_page = has_scheme(url, "http:") || has_scheme(url, "https:");
    match browser {
        Some(browser) if is_web_page => vec!["-g", "-a", browser, url],
        _ => vec!["-g", url],
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn open_behind(
    app: &tauri::AppHandle,
    url: &str,
    _browser: Option<&str>,
) -> Result<(), String> {
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

    #[cfg(target_os = "macos")]
    #[test]
    fn a_page_opens_behind_in_the_default_browser_unless_one_is_named() {
        assert_eq!(
            open_arguments("https://x.test", None),
            ["-g", "https://x.test"]
        );
        assert_eq!(
            open_arguments("https://x.test", Some("Safari")),
            ["-g", "-a", "Safari", "https://x.test"]
        );
        assert_eq!(
            open_arguments("mailto:a@x.test", Some("Safari")),
            ["-g", "mailto:a@x.test"]
        );
    }
}
