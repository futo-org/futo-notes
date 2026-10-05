//! Rust image extensions are conformance-locked to `packages/editor/src/images.ts`.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syncable_classifies_notes_images_and_ignores_the_rest() {
        assert!(is_syncable_filename("note.md"));
        assert!(is_syncable_filename("folder/note.md"));
        assert!(is_syncable_filename("image-123.png"));
        assert!(!is_syncable_filename("scan.tiff"));
        assert!(!is_syncable_filename("scan.heif"));
        assert!(!is_syncable_filename("archive.zip"));
        assert!(!is_syncable_filename("noextension"));
    }
}
