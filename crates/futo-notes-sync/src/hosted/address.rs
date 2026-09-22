//! Where the hosted service lives.

/// The FUTO hosted sync service. Compiled in, so nobody has to type a server
/// address to use hosted sync (ADR 0003, decision 2). Store builds get the
/// production name; internal builds (debug, TestFlight, Android prerelease,
/// desktop internal) set `FUTO_HOSTED_SERVER_BAKED` at build time to the
/// staging load balancer instead, so launch needs no client release to change
/// the hostname.
pub const HOSTED_SERVER: &str = match option_env!("FUTO_HOSTED_SERVER_BAKED") {
    Some(baked) => baked,
    None => "https://notes-sync.futo.org",
};

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

    /// This build has no `FUTO_HOSTED_SERVER_BAKED`, so `HOSTED_SERVER` falls
    /// back to the production name — but the constant only ever resolves to
    /// one of the two sanctioned hosted addresses (C3), never a typo or a
    /// stray local value baked in by mistake.
    #[test]
    fn the_baked_address_is_one_of_the_two_sanctioned_names() {
        assert!(
            HOSTED_SERVER == "https://notes-sync.futo.org"
                || HOSTED_SERVER == "https://staging-notes-sync.futo.org",
            "unexpected baked hosted address: {HOSTED_SERVER}"
        );
    }
}
