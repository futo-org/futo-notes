use super::*;

fn request(json: &str) -> Keys {
    serde_json::from_str(json).expect("valid keys")
}

#[test]
fn typed_text_is_a_key_per_character_with_shift_where_a_us_keyboard_needs_it() {
    let typed = keys(&request(r#"{"kind":"type","text":"aB!\n"}"#), true).unwrap();
    let summary: Vec<_> = typed
        .iter()
        .map(|key| (key.code, key.key.clone(), key.text(), key.modifiers.shift))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("KeyA", "a".into(), "a".into(), false),
            ("KeyB", "B".into(), "B".into(), true),
            ("Digit1", "!".into(), "!".into(), true),
            ("Enter", "Enter".into(), "\r".into(), false)
        ]
    );
    // A character no US key makes still types itself, on no key.
    let accent = character_key('é');
    assert_eq!((accent.code, accent.text()), ("", "é".to_string()));
}

#[test]
fn mod_is_command_on_macos_and_control_elsewhere() {
    let mac = chord("Mod-b", true).unwrap();
    assert!(mac.modifiers.meta && !mac.modifiers.control);
    let elsewhere = chord("Mod-b", false).unwrap();
    assert!(elsewhere.modifiers.control && !elsewhere.modifiers.meta);
    assert_eq!((elsewhere.code, elsewhere.key.as_str()), ("KeyB", "b"));
    // A shortcut types nothing; Shift alone still types.
    assert_eq!(elsewhere.text(), "");
    assert_eq!(chord("Shift-a", false).unwrap().text(), "A");
    assert!(chord("Ctrl-b", true).unwrap().modifiers.control);
    assert!(chord("Cmd-b", false).unwrap().modifiers.meta);
}

#[test]
fn a_chord_names_its_modifiers() {
    let back = chord("Shift-Tab", true).unwrap();
    assert!(back.modifiers.shift);
    assert_eq!(back.code, "Tab");
    let redo = chord("Mod-Shift-z", true).unwrap();
    assert!(redo.modifiers.meta && redo.modifiers.shift);
    assert_eq!(redo.key, "Z");
    assert_eq!(chord("Mod--", true).unwrap().code, "Minus");
    assert!(chord("Hyper-a", true).unwrap_err().contains("Hyper"));
    assert!(chord("F13", true).unwrap_err().contains("F13"));
}

#[test]
fn press_repeats_and_refuses_nothing_to_press() {
    assert_eq!(
        keys(
            &request(r#"{"kind":"press","key":"Backspace","count":3}"#),
            true
        )
        .unwrap()
        .len(),
        3
    );
    for count in [0, 1_000_000] {
        let json = format!(r#"{{"kind":"press","key":"Enter","count":{count}}}"#);
        assert!(keys(&request(&json), true).is_err(), "{json}");
    }
    assert!(keys(&request(r#"{"kind":"type","text":""}"#), true).is_err());
    assert!(serde_json::from_str::<Keys>(r#"{"kind":"type","x":1}"#).is_err());
}

#[test]
fn macos_reads_the_virtual_key_and_the_plain_character_under_a_shortcut() {
    let typed: Vec<_> = keys(&request(r#"{"kind":"type","text":"aB!\n"}"#), true)
        .unwrap()
        .iter()
        .map(mac_key)
        .collect();
    assert_eq!(
        typed,
        vec![
            (0, "a".into(), "a".into()),
            (11, "B".into(), "b".into()),
            (18, "!".into(), "1".into()),
            (36, "\r".into(), "\r".into())
        ]
    );
    assert_eq!(mac_key(&chord("Mod-Shift-z", true).unwrap()).1, "z");
    assert_eq!(mac_key(&chord("ArrowLeft", true).unwrap()).1, "\u{f702}");
    assert_eq!(mac_key(&chord("Mod--", true).unwrap()).0, 27);
}

#[test]
fn gdk_reads_the_keyval_and_the_us_keycode() {
    assert_eq!(
        gdk_key(&chord("Ctrl-b", false).unwrap()),
        (u32::from('b'), 56)
    );
    assert_eq!(gdk_key(&character_key('B')), (u32::from('B'), 56));
    assert_eq!(gdk_key(&chord("Enter", false).unwrap()), (0xff0d, 36));
    assert_eq!(
        gdk_key(&chord("Shift-Tab", false).unwrap()),
        (ISO_LEFT_TAB, 23)
    );
    assert_eq!(gdk_key(&character_key(' ')), (0x20, 65));
    assert_eq!(gdk_key(&character_key('é')), (0xe9, 0));
    assert_eq!(gdk_key(&character_key('→')), (0x0100_2192, 0));
}

#[test]
fn devtools_sends_text_with_a_typing_key_and_none_with_a_shortcut() {
    let [down, up] = devtools_key_events(&character_key('B'));
    assert_eq!(
        (
            down["type"].as_str(),
            down["text"].as_str(),
            down["modifiers"].as_u64()
        ),
        (Some("keyDown"), Some("B"), Some(8))
    );
    assert_eq!(down["windowsVirtualKeyCode"], 0x42);
    assert_eq!((up["type"].as_str(), up.get("text")), (Some("keyUp"), None));
    let [bold, _] = devtools_key_events(&chord("Mod-b", false).unwrap());
    assert_eq!(
        (
            bold["type"].as_str(),
            bold.get("text"),
            bold["modifiers"].as_u64()
        ),
        (Some("rawKeyDown"), None, Some(2))
    );
    let [enter, _] = devtools_key_events(&chord("Enter", false).unwrap());
    assert_eq!(
        (
            enter["text"].as_str(),
            enter["windowsVirtualKeyCode"].as_u64()
        ),
        (Some("\r"), Some(13))
    );
}
