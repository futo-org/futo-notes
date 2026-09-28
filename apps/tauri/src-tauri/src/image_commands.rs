//! Tauri commands for image import and clipboard paste.

use std::path::Path;

use futo_notes_core::files::vault_fs;
use tauri::AppHandle;

use crate::background_tasks::blocking;

// Canonical set lives in `futo_notes_core::image` (shared with the sync layer,
// the note domain, and the conformance-locked `@futo-notes/editor` hot path);
// no local copy to drift.
use futo_notes_core::image::IMAGE_EXTENSIONS;

fn validate_extension(extension: &str) -> Result<String, String> {
    if extension.len() > 10 {
        return Err("image extension too long".to_owned());
    }
    if extension.contains(['/', '\\', '\0']) || extension.contains("..") {
        return Err("image extension contains invalid characters".to_owned());
    }
    let extension = extension.to_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("disallowed image extension: {extension}"));
    }
    Ok(extension)
}

/// Saved by the vault engine like a note, so a folder that refuses the write marks
/// the vault unusable (`vault_fs::access_refused`). `create_new` never replaces a
/// file: a second image in the same millisecond takes the next number, the way
/// the native shells name theirs.
fn write_image(root: &Path, bytes: &[u8], extension: &str, now_ms: i64) -> Result<String, String> {
    let extension = validate_extension(extension)?;
    let mut filename = format!("image-{now_ms}.{extension}");
    for number in 2..100 {
        if vault_fs::create_new(root, &filename, bytes)? {
            return Ok(filename);
        }
        filename = format!("image-{now_ms}-{number}.{extension}");
    }
    Err("no free image filename".to_owned())
}

/// Image bytes the webview holds — a drop, a pick, a pasted file. They arrive as
/// the raw IPC body with the extension in a header, as plugin-fs `writeFile` sends
/// them; the postMessage fallback delivers the same bytes as a JSON array.
#[tauri::command]
pub async fn fs_save_image(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let extension = request
        .headers()
        .get("image-extension")
        .and_then(|value| value.to_str().ok())
        .ok_or("missing image extension")?
        .to_owned();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_u64().map(|byte| byte as u8))
            .collect(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected image bytes".to_owned()),
    };
    blocking(move || {
        write_image(
            &crate::vault_location::root(&app)?,
            &bytes,
            &extension,
            futo_notes_core::files::now_ms(),
        )
    })
    .await
}

#[tauri::command]
pub async fn fs_paste_clipboard_image(app: AppHandle) -> Result<String, String> {
    blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;

        let image = app
            .clipboard()
            .read_image()
            .map_err(|error| format!("Clipboard read failed: {error}"))?;
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 {
            return Err("No image in clipboard".to_owned());
        }

        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|error| format!("PNG header error: {error}"))?;
            writer
                .write_image_data(image.rgba())
                .map_err(|error| format!("PNG write error: {error}"))?;
        }

        write_image(
            &crate::vault_location::root(&app)?,
            &bytes,
            "png",
            futo_notes_core::files::now_ms(),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    //! Tests for image import and validation commands.
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-tauri-media-{}-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn extension_allowlist_is_case_insensitive_and_traversal_safe() {
        assert_eq!(validate_extension("Png").unwrap(), "png");
        assert!(validate_extension("../png").is_err());
        assert!(validate_extension("bad\0png").is_err());
        assert!(validate_extension("abcdefghijklmnop").is_err());
        assert!(validate_extension("exe").is_err());
    }

    #[test]
    fn image_write_returns_a_vault_relative_filename() {
        let root = temp_dir();
        let filename = write_image(&root, b"image", "PNG", 42).unwrap();
        assert_eq!(filename, "image-42.png");
        assert_eq!(fs::read(root.join(filename)).unwrap(), b"image");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn images_saved_in_the_same_millisecond_are_both_kept() {
        let root = temp_dir();
        let first = write_image(&root, b"first", "png", 42).unwrap();
        let second = write_image(&root, b"second", "png", 42).unwrap();
        assert_eq!(second, "image-42-2.png");
        assert_eq!(fs::read(root.join(first)).unwrap(), b"first");
        assert_eq!(fs::read(root.join(second)).unwrap(), b"second");
        fs::remove_dir_all(root).unwrap();
    }
}
