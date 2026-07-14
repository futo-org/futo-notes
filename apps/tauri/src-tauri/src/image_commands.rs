//! Tauri commands for image import and clipboard paste.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::background_tasks::{blocking, io_error};

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

fn unique_filename(extension: &str) -> String {
    let now = futo_notes_core::files::now_ms();
    let suffix = now.unsigned_abs() % 10_000;
    format!("{now}-{suffix:04}.{extension}")
}

fn write_image(root: &Path, bytes: &[u8], extension: &str) -> Result<String, String> {
    let extension = validate_extension(extension)?;
    let filename = unique_filename(&extension);
    fs::write(root.join(&filename), bytes).map_err(io_error)?;
    Ok(filename)
}

#[tauri::command]
pub async fn fs_save_image(app: AppHandle, source_path: String) -> Result<String, String> {
    blocking(move || {
        let source = PathBuf::from(source_path);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("jpg");
        let extension = validate_extension(extension)?;
        let bytes = fs::read(source).map_err(io_error)?;
        write_image(&crate::vault_location::root(&app)?, &bytes, &extension)
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

        write_image(&crate::vault_location::root(&app)?, &bytes, "png")
    })
    .await
}

#[cfg(test)]
mod tests {
    //! Tests for image import and validation commands.
    use super::*;
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
        let filename = write_image(&root, b"image", "png").unwrap();
        assert!(filename.ends_with(".png"));
        assert_eq!(fs::read(root.join(filename)).unwrap(), b"image");
        fs::remove_dir_all(root).unwrap();
    }
}
