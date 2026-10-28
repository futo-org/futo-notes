//! Real key presses for `just puppet type` / `press` on desktop.
//!
//! The editor's `Type` and `Press` verbs dispatch DOM events to the editor's own
//! handlers, which is as far as a page can reach: what the browser does by itself
//! with a key nobody handled (move the caret across a wrapped line, type through
//! the input method) they can only imitate. These are the keyboard's own events,
//! handed to THIS window's web view the way the platform hands it a real key, so the
//! engine runs its key handling and text input and the page sees trusted events:
//! on macOS an `NSEvent` per key down and up through the WKWebView's responder
//! methods, on Linux a `GdkEventKey` to the WebKitGTK widget, on Windows a DevTools
//! `Input.dispatchKeyEvent` on the WebView2. It is the same route `puppet_input.rs`
//! takes for the mouse, with the same guarantees: nothing goes to the window server,
//! compositor or OS input queue, so no other process can receive a key (AGENTS.md
//! M24), and the window is never activated, so the human keeps focus.
//!
//! A key is described once, as the page will see it ([`Key`]), and each platform reads
//! its own numbers for that key off [`PHYSICAL_KEYS`] — all of it pure, so every
//! platform's mapping is tested on every platform (M26). Debug builds only.

use serde::Deserialize;

mod key_tables;

// How each platform hands a key to its web view: `send_key`.
#[cfg(target_os = "macos")]
#[path = "puppet_keys/macos.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "puppet_keys/linux.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "puppet_keys/windows.rs"]
mod platform;

#[cfg(any(target_os = "linux", test))]
use key_tables::ISO_LEFT_TAB;
use key_tables::{physical, NAMED, US_KEYS};
use platform::send_key;

/// One `type` or `press`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Keys {
    kind: String,
    /// `type`: the text, a key per character; a newline is Return.
    text: Option<String>,
    /// `press`: one key, with modifiers as the editor's keymap names them (`Mod-b`,
    /// `Shift-Tab`); `Mod` is Command on macOS and Control elsewhere, as in the keymap.
    key: Option<String>,
    /// `press`: how many times.
    count: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Modifiers {
    shift: bool,
    alt: bool,
    control: bool,
    /// Command on macOS, the Windows/Super key elsewhere.
    meta: bool,
}

/// One key press as the page sees it, whatever the platform.
#[derive(Debug, Clone, PartialEq)]
struct Key {
    /// `KeyboardEvent.code`: the physical key on a US layout, empty for a character no
    /// US key makes (an accent, an emoji), which arrives as text, as an input method sends it.
    code: &'static str,
    /// `KeyboardEvent.key`: the character the key gives with the modifiers held, or its
    /// name (`Enter`, `ArrowLeft`).
    key: String,
    modifiers: Modifiers,
}

impl Key {
    /// The character the key gives with no modifier held; the name for a named key.
    #[cfg(any(target_os = "macos", test))]
    fn unmodified(&self) -> String {
        US_KEYS
            .iter()
            .find(|(.., code)| *code == self.code)
            .map_or_else(|| self.key.clone(), |(plain, ..)| plain.to_string())
    }

    /// What the key types into a field: nothing under Control or Meta, nothing for a named
    /// key but Return.
    #[cfg(any(target_os = "windows", test))]
    fn text(&self) -> String {
        match self.key.as_str() {
            _ if self.modifiers.control || self.modifiers.meta => String::new(),
            "Enter" => "\r".into(),
            name if NAMED.iter().any(|(named, ..)| *named == name) => String::new(),
            character => character.into(),
        }
    }
}

/// `Mod` in a chord: Command on macOS, Control elsewhere, as ProseMirror's keymap reads it.
const MOD_IS_META: bool = cfg!(target_os = "macos");

/// The key a character is typed with.
fn character_key(character: char) -> Key {
    if character == '\n' {
        return named("Enter").expect("Enter is named");
    }
    let (code, shift) = match US_KEYS
        .iter()
        .find(|(plain, shifted, _)| *plain == character || *shifted == character)
    {
        Some((plain, _, code)) => (*code, *plain != character),
        None => ("", false),
    };
    Key {
        code,
        key: character.to_string(),
        modifiers: Modifiers {
            shift,
            ..Modifiers::default()
        },
    }
}

fn named(name: &str) -> Option<Key> {
    NAMED
        .iter()
        .find(|(key, ..)| *key == name)
        .map(|(key, ..)| Key {
            code: key,
            key: key.to_string(),
            modifiers: Modifiers::default(),
        })
}

/// `Mod-Shift-z`, `Shift-Tab`, `Enter`, `a`: the editor keymap's names. `Mod` is Meta when
/// `mod_is_meta` (macOS), Control otherwise.
fn chord(spec: &str, mod_is_meta: bool) -> Result<Key, String> {
    let mut parts: Vec<&str> = spec.split('-').collect();
    // A trailing `-` is the minus key itself (`Mod--`).
    let name = if spec.ends_with("--") || spec == "-" {
        parts.retain(|part| !part.is_empty());
        "-"
    } else {
        parts.pop().unwrap_or_default()
    };
    let mut modifiers = Modifiers::default();
    for part in parts
        .iter()
        .filter(|part| !part.is_empty() && **part != "-")
    {
        match *part {
            "Mod" if mod_is_meta => modifiers.meta = true,
            "Mod" => modifiers.control = true,
            "Cmd" | "Meta" => modifiers.meta = true,
            "Shift" => modifiers.shift = true,
            "Alt" | "Option" => modifiers.alt = true,
            "Ctrl" | "Control" => modifiers.control = true,
            other => {
                return Err(format!(
                    "no modifier key called {other:?} — Mod, Shift, Alt, Ctrl or Meta"
                ))
            }
        }
    }
    let mut key = match named(name) {
        Some(key) => key,
        None => {
            let mut characters = name.chars();
            match (characters.next(), characters.next()) {
                (Some(character), None) => character_key(character),
                _ => {
                    let names: Vec<&str> = NAMED.iter().map(|(key, ..)| *key).collect();
                    return Err(format!(
                        "no keyboard has a key called {name:?} — one character, or {}",
                        names.join(", ")
                    ));
                }
            }
        }
    };
    if modifiers.shift && key.key.chars().all(|c| c.is_ascii_lowercase()) {
        key.key = key.key.to_uppercase();
    }
    key.modifiers = Modifiers {
        shift: key.modifiers.shift || modifiers.shift,
        ..modifiers
    };
    Ok(key)
}

/// The keys one request presses, in order. Pure, so the sequence is testable
/// without a window.
fn keys(request: &Keys, mod_is_meta: bool) -> Result<Vec<Key>, String> {
    match request.kind.as_str() {
        "type" => {
            let text = request
                .text
                .as_deref()
                .filter(|text| !text.is_empty())
                .ok_or("type needs {\"text\":\"…\"}")?;
            Ok(text.chars().map(character_key).collect())
        }
        "press" => {
            let key = chord(
                request
                    .key
                    .as_deref()
                    .ok_or("press needs {\"key\":\"Enter\"}")?,
                mod_is_meta,
            )?;
            let count = request.count.unwrap_or(1);
            let most = crate::puppet_input::MAX_REPEATS;
            if !(1..=most).contains(&count) {
                return Err(format!(
                    "press's \"count\" is how many times, from 1 to {most}, not {count}"
                ));
            }
            Ok(vec![key; count as usize])
        }
        other => Err(format!("no such key gesture: {other}")),
    }
}

/// macOS: the virtual key code, the characters, and the characters ignoring modifiers,
/// as `NSEvent` carries them. With Command or Control held AppKit reports a key's plain
/// character.
#[cfg(any(target_os = "macos", test))]
fn mac_key(key: &Key) -> (u16, String, String) {
    let virtual_key = physical(key.code).map_or(0, |(mac, ..)| mac);
    if let Some((_, character, _)) = NAMED.iter().find(|(name, ..)| *name == key.code) {
        return (virtual_key, character.to_string(), character.to_string());
    }
    let unmodified = key.unmodified();
    let characters = if key.modifiers.meta || key.modifiers.control {
        unmodified.clone()
    } else {
        key.key.clone()
    };
    (virtual_key, characters, unmodified)
}

/// Linux: the keyval WebKitGTK reads `key` from and the hardware keycode it reads `code`
/// from (0 for a character no US key makes: its keyval alone carries it).
#[cfg(any(target_os = "linux", test))]
fn gdk_key(key: &Key) -> (u32, u16) {
    let keycode = physical(key.code).map_or(0, |(_, x11, _)| x11);
    if key.code == "Tab" && key.modifiers.shift {
        return (ISO_LEFT_TAB, keycode);
    }
    if let Some((.., keyval)) = NAMED.iter().find(|(name, ..)| *name == key.key) {
        return (*keyval, keycode);
    }
    let character = key.key.chars().next().unwrap_or(' ');
    // gdk_unicode_to_keyval: Latin-1 is its own keyval, the rest is 0x01000000 + code point.
    let keyval = match u32::from(character) {
        point @ (0x20..=0x7e | 0xa0..=0xff) => point,
        point => 0x0100_0000 | point,
    };
    (keyval, keycode)
}

/// Windows: the DevTools `Input.dispatchKeyEvent` pair for one key, down then up. A key
/// that types something goes down as `keyDown` with its text, one that does not as
/// `rawKeyDown`, as Chrome's own automation sends them.
#[cfg(any(target_os = "windows", test))]
fn devtools_key_events(key: &Key) -> [serde_json::Value; 2] {
    let modifiers = [
        (key.modifiers.alt, 1),
        (key.modifiers.control, 2),
        (key.modifiers.meta, 4),
        (key.modifiers.shift, 8),
    ]
    .iter()
    .filter(|(held, _)| *held)
    .map(|(_, bit)| bit)
    .sum::<u32>();
    let virtual_key = physical(key.code).map_or(0, |(.., windows)| windows);
    let event = |kind: &str| {
        serde_json::json!({
            "type": kind,
            "modifiers": modifiers,
            "key": key.key,
            "code": key.code,
            "windowsVirtualKeyCode": virtual_key,
            "nativeVirtualKeyCode": virtual_key,
        })
    };
    let text = key.text();
    let mut down = event(if text.is_empty() {
        "rawKeyDown"
    } else {
        "keyDown"
    });
    if !text.is_empty() {
        down["text"] = text.clone().into();
        down["unmodifiedText"] = text.into();
    }
    [down, event("keyUp")]
}

#[tauri::command]
pub(crate) async fn puppet_key(window: tauri::WebviewWindow, keys: Keys) -> Result<(), String> {
    if cfg!(not(debug_assertions)) {
        return Err("puppet_key exists in debug builds only".into());
    }
    let pressed = self::keys(&keys, MOD_IS_META)?;
    crate::background_tasks::blocking(move || {
        let (sender, receiver) = std::sync::mpsc::channel();
        window
            .with_webview(move |webview| {
                sender
                    .send(
                        pressed
                            .iter()
                            .map(|key| send_key(&webview, key))
                            .collect::<Result<Vec<_>, _>>(),
                    )
                    .ok();
            })
            .map_err(|error| error.to_string())?;
        let sent = receiver
            .recv()
            .map_err(|_| "the main thread dropped the key events".to_string())??;
        sent.into_iter().try_for_each(crate::puppet_input::settled)
    })
    .await
}

#[cfg(test)]
mod tests;
