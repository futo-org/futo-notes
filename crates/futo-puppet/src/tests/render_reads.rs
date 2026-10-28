use super::*;

#[test]
fn actions_render_one_line_per_verb_with_the_arguments_it_takes() {
    let body = json!({
        "screen": "editor:brown fox",
        "actions": [
            {"name": "OpenNote", "schema": {"type":"object","properties":{"mode":{"type":"string","enum":["current","foreground"]},"noteId":{"type":"string"}},"required":["noteId"]}},
            {"name": "Bold", "schema": {"type":"object","properties":{},"required":[]}},
            {"name": "AppendLine", "schema": {"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}, "convenience": true}
        ]
    });
    assert_eq!(
        render_actions(&body),
        "screen: editor:brown fox\nOpenNote    {noteId: string, mode?: current|foreground}\nBold\nAppendLine  {text: string}  (convenience, not real input)\n"
    );
}

#[test]
fn elements_render_as_an_outline_by_section() {
    let body = json!({
        "snapshot": 12, "viewport": {"w": 1280, "h": 800},
        "elements": [
            {"ref":"e4","component":null,"role":"editor","text":"the quick…","handlers":["pointerdown=cm","keydown=cm"],"flags":["focused"],"rect":{"x":240,"y":36,"w":1040,"h":764},"section":"main"},
            {"ref":"e1","component":"TabsStrip.svelte","role":"tab","text":"brown fox","handlers":["click=selectTab"],"flags":[],"rect":{"x":0,"y":0,"w":180,"h":36},"section":"top bar"},
            {"ref":"e2","component":"TabsStrip.svelte","role":"button","text":"New tab","handlers":["click=newTab"],"flags":[],"rect":{"x":190,"y":0,"w":30,"h":36},"section":"top bar"}
        ],
        "scroll": [{"section": "main", "down": true}]
    });
    assert_eq!(
        render_elements(&body),
        "snapshot 12 · 3 on screen · 1280×800 px\n\
         top bar\n  \
         e1  TabsStrip  tab     \"brown fox\"  click  0,0 180×36\n  \
         e2  TabsStrip  button  \"New tab\"    click  190,0 30×36\n\
         main · more below\n  \
         e4  -  editor  \"the quick…\"  press keys focused  240,36 1040×764\n"
    );
}

/// The lines on screen, each with its caret positions and kind, and the saved markdown only
/// where it differs from what the screen shows; the header says which lines of how many.
#[test]
fn doc_renders_lines_with_their_positions_kind_and_markdown() {
    let body = json!({"docVersion": 5, "onScreen": {"first": 1, "last": 4}, "more": {"above": false, "below": true}, "lines": [
        {"line": 1, "at": 0, "end": 1, "kind": "frontmatter", "text": "title: Groceries\ntags: [a]"},
        {"line": 2, "at": 14, "end": 18, "kind": "task ☐", "text": "milk"},
        {"line": 3, "at": 22, "end": 35, "kind": "bullet", "indent": 1, "text": "nested Sam"},
        {"line": 4, "at": 38, "end": 38, "kind": "paragraph", "text": "a b", "md": "a\nb"}]});
    assert_eq!(
        render_doc(&body),
        "docVersion 5 · lines 1–4 on screen · more below · line at-end│kind│text, md│ the saved markdown where it differs\n\
         L1     0-1│frontmatter│title: Groceries⏎tags: [a]\n\
         L2   14-18│task ☐│milk\n\
         L3   22-35│  bullet│nested Sam\n\
         L4   38-38│paragraph│a b\n\
         \u{20}       md│a⏎b\n"
    );
}

#[test]
fn doc_of_one_line_renders_its_runs_objects_and_tags() {
    let body = json!({"docVersion": 5, "line": 2, "at": 49, "end": 70, "kind": "paragraph",
        "text": "Call Sam [[Lease plan]]", "md": "Call **Sam** [[Lease plan]]",
        "runs": [{"at": 49, "text": "Call "}, {"at": 54, "text": "Sam", "marks": ["bold"]},
                 {"at": 57, "text": " "}, {"at": 58, "node": "wikilink", "text": "[[Lease plan]]", "target": "Lease plan"}],
        "tags": [{"from": 60, "to": 64, "tag": "#tag"}]});
    assert_eq!(
        render_doc(&body),
        "docVersion 5\n\
         L2   49-70│paragraph│Call Sam [[Lease plan]]\n\
         \u{20}  md│Call **Sam** [[Lease plan]]\n\
         \u{20}    49 \"Call \"\n\
         \u{20}    54 \"Sam\" bold\n\
         \u{20}    57 \" \"\n\
         \u{20}    58 wikilink \"[[Lease plan]]\" target=\"Lease plan\"\n\
         \u{20} tag 60-64 #tag\n"
    );
}

/// A collapsed folder hides its whole subtree from every DOM query, so the
/// sidebar cannot answer "is it still there?". The vault can.
#[test]
fn notes_render_as_counts_then_folders_then_ids() {
    let body = json!({
        "notes": ["welcome", "work/standup"],
        "folders": ["recipes", "work"],
    });
    assert_eq!(
        render_notes(&body),
        "2 notes · 2 folders · the vault, whatever the sidebar is showing\n\
         folder  recipes   (no notes)\n\
         folder  work\n\
         note    welcome\n\
         note    work/standup\n"
    );
}

#[test]
fn search_renders_ranked_ids() {
    let body = json!({"query": "landlord", "hits": ["personal/home/lease notes", "inbox/misc"]});
    assert_eq!(
        render_search(&body),
        "2 hits for \"landlord\" · best first\n  1  personal/home/lease notes\n  2  inbox/misc\n"
    );
    assert!(matches!(
        parse_invocation(&strings(&["search", r#"{"query":"x"}"#])).unwrap(),
        Invocation::Query(..)
    ));
}

/// A note none of which shows says so, rather than printing nothing.
#[test]
fn doc_with_nothing_on_screen_says_so() {
    let body = json!({"docVersion": 5, "onScreen": null, "more": null, "lines": []});
    assert_eq!(
        render_doc(&body),
        "docVersion 5 · no line on screen · line at-end│kind│text, md│ the saved markdown where it differs\n"
    );
}
