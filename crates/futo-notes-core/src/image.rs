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
    fn canonical_set_is_ten() {
        assert_eq!(IMAGE_EXTENSIONS.len(), 10);
    }

    #[test]
    fn recognizes_canonical_extensions() {
        for ext in IMAGE_EXTENSIONS {
            assert!(is_image_filename(&format!("photo.{ext}")), "{ext}");
            assert!(is_image_filename(&format!("photo.{}", ext.to_uppercase())));
        }
    }

    #[test]
    fn legacy_extensions_are_not_images() {
        for ext in ["tiff", "tif", "heif"] {
            assert!(!is_image_filename(&format!("scan.{ext}")), "{ext}");
        }
    }

    #[test]
    fn extension_is_after_last_dot() {
        assert!(!is_image_filename("x.tiff.md"));
        assert!(is_image_filename("x.tiff.png"));
        assert!(!is_image_filename("noextension"));
        assert!(!is_image_filename(".hidden"));
    }

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
