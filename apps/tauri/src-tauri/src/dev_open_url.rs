//! How a debug build opens a link: in the background, in a browser the developer picks.
//!
//! An agent driving the dev app presses "Buy a license", "Log in with FUTO" and
//! "Manage subscription" for real, and each one opens a page. Opened the normal way,
//! the browser comes to the front over whatever the developer is doing, every time.
//! Here the page loads without activating anything (`open_url_behind.rs`), and a web page
//! goes to `FUTO_DEV_BROWSER` (Safari when unset), so those tabs collect in a browser the
//! developer doesn't otherwise use. A `mailto:` or `tel:` link still goes to its own
//! handler, in the background too. Links a person clicks in the dev app go the same
//! way, by design.
//!
//! Release builds never reach this: `src/lib/platform/openExternalUrl.ts` calls it
//! only in a dev bundle. Debug builds only; off macOS the link opens the opener plugin's way.

#[tauri::command]
pub(crate) async fn dev_open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if cfg!(not(debug_assertions)) {
        return Err("dev_open_url exists in debug builds only".into());
    }
    if !crate::open_url_behind::is_openable(&url) {
        return Err(format!("not a link the dev build opens: {url}"));
    }
    crate::background_tasks::blocking(move || {
        let browser = std::env::var("FUTO_DEV_BROWSER")
            .ok()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Safari".into());
        crate::open_url_behind::open_behind(&app, &url, Some(&browser))
    })
    .await
}
