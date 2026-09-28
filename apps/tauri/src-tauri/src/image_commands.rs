//! Tauri commands for image import and clipboard paste.

use std::path::Path;

use futo_notes_core::files::vault_fs;
use tauri::ipc::InvokeBody;
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
/// the vault unusable (`vault_fs::access_refused`). The random part keeps two
/// devices that add an image in the same millisecond from syncing one name, and
/// `create_new` never replaces a file.
fn write_image(root: &Path, bytes: &[u8], extension: &str, now_ms: i64) -> Result<String, String> {
    let extension = validate_extension(extension)?;
    let suffix = hex::encode(rand::random::<[u8; 6]>());
    let filename = format!("image-{now_ms}-{suffix}.{extension}");
    if vault_fs::create_new(root, &filename, bytes)? {
        Ok(filename)
    } else {
        Err(format!("image name already taken: {filename}"))
    }
}

/// Image bytes arrive as the raw IPC body, the way plugin-fs `writeFile` sends
/// them; the postMessage fallback delivers the same bytes as a JSON array.
fn image_bytes(body: &InvokeBody) -> Result<Vec<u8>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| value.as_u64().and_then(|byte| u8::try_from(byte).ok()))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| "image bytes must each be 0-255".to_owned()),
        InvokeBody::Json(_) => Err("expected image bytes".to_owned()),
    }
}

/// Image bytes the webview holds — a drop, a pick, a pasted file.
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
    let bytes = image_bytes(request.body())?;
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
        assert!(filename.starts_with("image-42-") && filename.ends_with(".png"));
        assert_eq!(fs::read(root.join(filename)).unwrap(), b"image");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn images_saved_in_the_same_millisecond_get_different_names() {
        let root = temp_dir();
        let first = write_image(&root, b"first", "png", 42).unwrap();
        let second = write_image(&root, b"second", "png", 42).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(root.join(first)).unwrap(), b"first");
        assert_eq!(fs::read(root.join(second)).unwrap(), b"second");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_bytes_arrive_raw_or_as_a_json_array_of_bytes() {
        assert_eq!(image_bytes(&InvokeBody::Raw(vec![1, 2])).unwrap(), [1, 2]);
        let array = InvokeBody::Json(serde_json::json!([0, 255]));
        assert_eq!(image_bytes(&array).unwrap(), [0, 255]);
        assert!(image_bytes(&InvokeBody::Json(serde_json::json!([256]))).is_err());
        assert!(image_bytes(&InvokeBody::Json(serde_json::json!(["1"]))).is_err());
        assert!(image_bytes(&InvokeBody::Json(serde_json::json!({ "bytes": [1] }))).is_err());
    }
}
