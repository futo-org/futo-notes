//! Rust image extensions are conformance-locked to `packages/editor/src/images.ts`.
//! Moved out of `futo-notes-core` (which re-exports it as `image`) so the editor
//! engine reuses the rules without depending on the filesystem crate.

pub const IMAGE_EXTENSIONS: [&str; 10] = [
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "heic",
];

pub fn is_image_filename(filename: &str) -> bool {
    let dot = match filename.rfind('.') {
        Some(idx) => idx,
        None => return false,
    };
    let ext = filename[dot + 1..].to_lowercase();
    IMAGE_EXTENSIONS.contains(&ext.as_str())
}

pub fn is_syncable_filename(filename: &str) -> bool {
    filename.ends_with(".md") || is_image_filename(filename)
}

/// A source the shell loads as-is rather than as a vault file. Mirrors
/// `isRemoteImageSource` in `src/features/images/vaultImageSrc.ts`.
pub fn is_remote_image_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://") || source.starts_with("data:")
}

/// A remote source a native shell may fetch for display: `http(s)` only.
/// `data:` is remote but is never fetched (#330).
pub fn is_http_image_source(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

/// A note's stored reference to a vault image: an image filename that is not a
/// remote source. This is what a picker/paste flow writes into source.
pub fn is_vault_image_reference(reference: &str) -> bool {
    !is_remote_image_source(reference) && is_image_filename(reference)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_notes_images_and_remote_sources() {
        assert!(is_syncable_filename("folder/note.md"));
        assert!(is_syncable_filename("image-123.png"));
        assert!(!is_syncable_filename("scan.tiff"));
        assert!(!is_syncable_filename("noextension"));
        assert!(is_vault_image_reference("pics/a b.JPG"));
        assert!(!is_vault_image_reference("https://x.test/a.png"));
        assert!(!is_vault_image_reference("note.md"));
        assert!(is_http_image_source("https://x.test/a.png"));
        assert!(is_http_image_source("http://x.test/a.png"));
        assert!(!is_http_image_source("data:image/png;base64,AAAA"));
        assert!(!is_http_image_source("HTTPS://x.test/a.png"));
        assert!(!is_http_image_source("a.png"));
    }
}
