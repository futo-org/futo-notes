//! A code block's header fields: what each keeps of typed text, and what
//! `set_code_block_header` writes of it.
use super::super::Engine;
use super::{ok, range};
use crate::{CodeBlockHeader, DisplayOffset, EditorError};

#[test]
fn a_header_change_reports_its_block_with_the_new_header() {
    let mut engine = Engine::open("a\n```js hl:1\nx\n```\nb");
    let header = CodeBlockHeader {
        at: DisplayOffset(2),
        language: "go".into(),
        name: "main.go".into(),
    };
    let change = engine
        .set_code_block_header(engine.revision(), &header, &mut ok)
        .unwrap()
        .unwrap();
    let block = &change.projection.code_blocks[0];
    assert_eq!(block.range, range(2, 3));
    assert_eq!(block.language.as_deref(), Some("go"));
    assert_eq!(block.name.as_deref(), Some("main.go"));
    assert_eq!(change.selection, range(0, 0));
}

/// What a header field keeps of any typed text is written, unless it is
/// refused for one of the reasons fenced-code.md names: a language that
/// reads as a key (or, on a tilde fence, starts with `~`), a name with
/// outer whitespace or a key at a word start.
#[test]
fn what_a_header_field_keeps_is_written_or_refused_for_a_named_reason() {
    let pieces = [
        "`", " ", "\t", "\n", "\r", "\u{0}", "\u{a0}", "\u{2003}", "name:", "hl:2", "ll:", ":",
        "go", "é", "名", "~", "-", "#", "a",
    ];
    let starts_with_key = |text: &str| {
        ["name:", "hl:", "ll:"]
            .iter()
            .any(|key| text.starts_with(key))
    };
    let mut state: u32 = 0x5eed_c0de;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state as usize
    };
    for _ in 0..4_000 {
        let typed: String = (0..next() % 7)
            .map(|_| pieces[next() % pieces.len()])
            .collect();
        for fence in ["```\nx\n```", "```py hl:2\nx\n```", "~~~\nx\n~~~"] {
            let tilde = fence.starts_with('~');
            let language = crate::typed_code_block_language(&typed);
            let name = crate::typed_code_block_name(&typed);
            let language_refused =
                starts_with_key(&language) || (tilde && language.starts_with('~'));
            let name_refused = name != name.trim()
                || name.char_indices().any(|(at, character)| {
                    character.is_whitespace() && starts_with_key(&name[at + character.len_utf8()..])
                });
            for (language, name, refused) in [
                (language.clone(), String::new(), language_refused),
                (String::new(), name, name_refused),
            ] {
                let mut engine = Engine::open(fence);
                let header = CodeBlockHeader {
                    at: DisplayOffset(0),
                    language: language.clone(),
                    name: name.clone(),
                };
                let written = engine.set_code_block_header(engine.revision(), &header, &mut ok);
                match written {
                    Err(EditorError::InvalidText) => {
                        assert!(
                            refused,
                            "{fence:?} refused {language:?} {name:?} from {typed:?}"
                        )
                    }
                    Ok(_) => {
                        assert!(
                            !refused,
                            "{fence:?} wrote {language:?} {name:?} from {typed:?}"
                        )
                    }
                    Err(error) => panic!("{fence:?} {language:?} {name:?}: {error:?}"),
                }
            }
        }
    }
}

/// A language field keeps whitespace at its end as one space, so `c`,
/// space, `s` reads `c-s`; the header write drops it.
#[test]
fn a_language_field_keeps_one_trailing_space_that_the_header_drops() {
    for (typed, kept, fence) in [
        ("Python ", "Python ", "```Python"),
        ("c s", "c-s", "```c-s"),
        ("c sharp", "c-sharp", "```c-sharp"),
        ("c \t ", "c ", "```c"),
        (" \t", "", "```"),
    ] {
        assert_eq!(crate::typed_code_block_language(typed), kept, "{typed:?}");
        let mut engine = Engine::open("```js\nx\n```");
        let header = CodeBlockHeader {
            at: DisplayOffset(0),
            language: kept.into(),
            name: String::new(),
        };
        let revision = engine.revision();
        engine
            .set_code_block_header(revision, &header, &mut ok)
            .unwrap();
        let written = engine.source_text();
        assert_eq!(written, format!("{fence}\nx\n```"), "{typed:?}");
    }
}
