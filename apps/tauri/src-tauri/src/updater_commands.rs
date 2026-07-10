//! Tauri command and capability policy for desktop self-updates.

pub(crate) fn self_update_supported(os: &str, appimage_present: bool) -> bool {
    match os {
        "linux" => appimage_present,
        "macos" | "windows" => true,
        _ => false,
    }
}

#[tauri::command]
pub async fn app_self_update_supported() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    self_update_supported(std::env::consts::OS, std::env::var("APPIMAGE").is_ok())
}

#[cfg(test)]
mod tests {
    //! Tests for updater capability policy.
    use super::*;

    #[test]
    fn support_matches_packaging_model() {
        assert!(self_update_supported("linux", true));
        assert!(!self_update_supported("linux", false));
        assert!(self_update_supported("macos", false));
        assert!(self_update_supported("windows", false));
        assert!(!self_update_supported("android", true));
    }
}
