//! Canonical image-filename detection. THE single source of truth for the
//! image-extension set across the Rust workspace: `futo-notes-model::image`
//! re-exports from here, the sync orchestrator classifies blob-vs-note with
//! `is_image_filename`, and the conformance fixtures hold it bit-for-bit
//! against the sanctioned TS hot-path copy in `packages/editor/src/images.ts`.
//!
//! Historically an independent 13-entry copy lived in `invariants.rs` (with
//! `.tiff/.tif/.heif`) and disagreed with the conformance-locked 10-set. D4
//! unified everything on the 10-set below; `invariants.rs` now delegates here.

/// Recognized image extensions (lowercase, no dot). Matches TS
/// `IMAGE_EXTENSIONS`.
pub const IMAGE_EXTENSIONS: [&str; 10] = [
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "heic",
];

/// True if `filename` has a recognized image extension (case-insensitive).
///
/// Mirrors TS `isImageFilename`: the extension is everything after the LAST
/// `.`; a name with no `.` (or a leading-dot name like `.hidden`, whose
/// "extension" is the whole stem) is not an image unless that stem matches.
pub fn is_image_filename(filename: &str) -> bool {
    let dot = match filename.rfind('.') {
        Some(idx) => idx,
        None => return false,
    };
    let ext = filename[dot + 1..].to_lowercase();
    IMAGE_EXTENSIONS.contains(&ext.as_str())
}

/// True if `filename` is a syncable note-tree entry: a `.md` note or a
/// canonical image blob. The sync layer uses this as the note-vs-blob-vs-
/// ignore classifier. Anything else — foreign extensions, or the legacy
/// image formats (`.tiff/.tif/.heif`) that older clients uploaded before D4
/// narrowed [`IMAGE_EXTENSIONS`] — is deliberately left untouched on both the
/// wire and disk: the sync orchestrator never downloads it as a note, never
/// tombstones it, and never errors the cycle over it.
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
        // Dropped by D4 — older clients may still hold these on the server.
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
        // Legacy + foreign extensions are not syncable.
        assert!(!is_syncable_filename("scan.tiff"));
        assert!(!is_syncable_filename("scan.heif"));
        assert!(!is_syncable_filename("archive.zip"));
        assert!(!is_syncable_filename("noextension"));
    }
}
