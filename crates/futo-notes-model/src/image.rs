//! Image filename detection. Ported from `packages/shared/src/sync.ts`.

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
