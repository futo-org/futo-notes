//! Where the hosted service lives.

/// The FUTO hosted sync service. Compiled in, so nobody has to type a server
/// address to use hosted sync (ADR 0003, decision 2). For the internal MVP the
/// name points at the staging load balancer, which is why launch needs no
/// client release to change it.
pub const HOSTED_SERVER: &str = "https://notes-sync.futo.org";

/// Debug-build override, matching the shells' existing pattern of a dev-only
/// server default: a debug build honours `FUTO_HOSTED_SERVER` so a developer
/// or a test can point the hosted flow at a local server, and a release build
/// ignores it entirely.
pub fn hosted_server() -> String {
    resolve(
        cfg!(debug_assertions),
        std::env::var("FUTO_HOSTED_SERVER").ok().as_deref(),
    )
}

/// Pure selection, so both branches are testable without a build flag — the
/// same shape as the Android shell's `defaultServer(isDebug)`.
fn resolve(debug: bool, override_url: Option<&str>) -> String {
    match override_url.map(str::trim).filter(|url| !url.is_empty()) {
        Some(url) if debug => url.to_owned(),
        _ => HOSTED_SERVER.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_build_always_uses_the_baked_address() {
        assert_eq!(resolve(false, Some("http://127.0.0.1:3077")), HOSTED_SERVER);
        assert_eq!(resolve(false, None), HOSTED_SERVER);
    }

    #[test]
    fn a_debug_build_takes_the_override_when_one_is_set() {
        assert_eq!(
            resolve(true, Some("http://127.0.0.1:3077")),
            "http://127.0.0.1:3077"
        );
    }

    #[test]
    fn an_empty_or_absent_override_is_no_override() {
        assert_eq!(resolve(true, None), HOSTED_SERVER);
        assert_eq!(resolve(true, Some("")), HOSTED_SERVER);
        assert_eq!(resolve(true, Some("   ")), HOSTED_SERVER);
    }
}
