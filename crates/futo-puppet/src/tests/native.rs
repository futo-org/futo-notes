use crate::native::*;
use serde_json::{json, Value};

#[test]
fn a_touch_point_off_the_middle_is_the_rows_aim_in_screen_units() {
    let tree = from_tree(&json!({
        "scale": 2.0, "screen": {"w": 800, "h": 1600},
        "nodes": [{"role": "switch", "text": "Send crashes automatically", "x": 32, "y": 1500,
                   "w": 740, "h": 104, "aim": {"x": 700, "y": 1552}, "actions": ["tap"],
                   "flags": [], "section": "sheet · list"}]
    }));
    assert_eq!(tree.nodes[0].aim, Some((350.0, 776.0)));
    let rows = Refs::from_json(&Value::Null).rows(&tree.nodes);
    assert_eq!(rows[0]["aim"], json!({"x": 350, "y": 776}));
}

fn node(role: &str, text: &str, id: Option<&str>, y: f64) -> Node {
    Node {
        role: role.into(),
        text: text.into(),
        id: id.map(str::to_owned),
        rect: Rect {
            x: 16.0,
            y,
            w: 370.0,
            h: 52.0,
        },
        aim: None,
        verb: None,
        handlers: vec!["tap".into()],
        flags: vec![],
        section: "list".into(),
    }
}

/// iOS answers in points (scale 1), so its rows arrive as they are; slivers at an edge
/// are dropped either way.
#[test]
fn ios_points_pass_through_and_edge_slivers_are_dropped() {
    let tree = from_tree(&json!({
        "scale": 1, "screen": {"w": 402, "h": 874},
        "nodes": [
            {"role": "row", "text": "welcome, 4 days ago, Welcome\nThe quick brown fox jumps over the lazy dog.",
             "id": "note:welcome", "x": 16, "y": 307, "w": 370, "h": 116, "actions": ["tap", "hold"], "flags": []},
            {"role": "row", "text": "risotto", "id": "note:risotto", "x": 16, "y": 873, "w": 370, "h": 1,
             "actions": ["tap"], "flags": []}
        ]
    }));
    assert_eq!(
        (tree.screen.w, tree.screen.h, tree.scale),
        (402.0, 874.0, 1.0)
    );
    assert_eq!(tree.nodes.len(), 1);
    let rows = Refs::default().rows(&tree.nodes);
    assert_eq!(rows[0]["note"], "welcome");
    assert!(rows[0]["text"].as_str().unwrap().ends_with('…'));
}

#[test]
fn refs_follow_the_element_not_its_position() {
    let nodes = vec![
        node("button", "Settings", Some("nav-settings"), 66.0),
        node("heading", "Notes", None, 120.0),
        node("row", "recipes", Some("folder:recipes"), 168.0),
        node("row", "welcome", Some("note:welcome"), 307.0),
    ];
    let mut refs = Refs::default();
    let first = refs.rows(&nodes);
    assert_eq!(first[2]["ref"], "n3");
    assert_eq!(first[2]["folder"], "recipes");
    assert_eq!(first[3]["note"], "welcome");
    // The list scrolled: the folder row is gone and a new row is first.
    let mut moved = nodes.clone();
    moved[2] = node("row", "work", Some("folder:work"), 168.0);
    let mut refs = Refs::from_json(&refs.to_json());
    let second = refs.rows(&moved);
    assert_eq!(second[2]["ref"], "n5", "a new element gets a new ref");
    assert_eq!(second[3]["ref"], "n4", "a known one keeps its own");
    let change = diff(&first, &second);
    assert_eq!(change["added"][0]["text"], "work");
    assert_eq!(change["removed"][0]["text"], "recipes");
    assert_eq!(change["changed"], json!([]));
}

/// A long-press menu's Delete, then the confirmation dialog it opens, whose Delete is a
/// different button with the same label: it has to read as a new element.
#[test]
fn a_same_label_on_the_next_surface_is_a_new_element() {
    let button = |w: f64| Node {
        role: "button".into(),
        text: "Delete".into(),
        id: None,
        rect: Rect {
            x: 16.0,
            y: 365.0,
            w,
            h: 48.0,
        },
        aim: None,
        verb: None,
        handlers: vec!["tap".into()],
        flags: vec![],
        section: "menu".into(),
    };
    let mut refs = Refs::default();
    let menu = refs.rows(&[button(182.0)]);
    let dialog = refs.rows(&[button(73.0)]);
    assert_ne!(menu[0]["ref"], dialog[0]["ref"]);
    assert_eq!(diff(&menu, &dialog)["added"][0]["text"], "Delete");
}

/// `/tree`'s `controls` name each row's verb: its whole text, or a toggle row's title
/// before its description, the longest label winning.
#[test]
fn a_row_reads_the_verb_whose_label_it_shows() {
    let body = json!({
        "screen": {"w": 360, "h": 800}, "scale": 1,
        "controls": {"Share crash reports": ["ToggleIssueReporting"], "Share": ["ShareNote"],
                     "Delete": ["DeleteNote", "DeleteFolder"]},
        "nodes": [
            {"role": "switch", "text": "Share crash reports Reports are saved locally first",
             "x": 0, "y": 0, "w": 360, "h": 60, "actions": ["tap"], "flags": []},
            {"role": "button", "text": "Delete", "x": 0, "y": 60, "w": 360, "h": 40,
             "actions": ["tap"], "flags": []},
            {"role": "button", "text": "Sharepoint", "x": 0, "y": 100, "w": 360, "h": 40,
             "actions": ["tap"], "flags": []},
            {"role": "heading", "text": "Delete", "x": 0, "y": 140, "w": 360, "h": 40,
             "actions": [], "flags": []}
        ]
    });
    let tree = from_tree(&body);
    let verbs: Vec<_> = tree.nodes.iter().map(|node| node.verb.as_deref()).collect();
    assert_eq!(
        verbs,
        [
            Some("ToggleIssueReporting"),
            Some("DeleteNote|DeleteFolder"),
            None,
            None
        ]
    );
    assert_eq!(
        Refs::default().rows(&tree.nodes)[1]["verb"],
        "DeleteNote|DeleteFolder"
    );
}

/// One rule on every platform, the desktop page's: a row that moved is a change too (SKILL.md's
/// `~ … rect a → b`).
#[test]
fn a_changed_label_state_or_place_is_a_change() {
    let row = |text: &str, flags: Value, y: f64| json!({"ref": "n1", "role": "switch", "text": text, "flags": flags, "rect": {"y": y}, "section": "settings"});
    let change = diff(
        &[row("Sync", json!([]), 10.0)],
        &[row("Sync", json!(["checked"]), 10.0)],
    );
    assert_eq!(change["changed"][0]["flags"], json!([[], ["checked"]]));
    assert_eq!(change["changed"][0]["section"], "settings");
    assert!(change["changed"][0].get("rect").is_none());
    let moved = diff(
        &[row("Sync", json!([]), 10.0)],
        &[row("Sync", json!([]), 90.0)],
    );
    assert_eq!(
        moved["changed"][0]["rect"],
        json!([{"y": 10.0}, {"y": 90.0}])
    );
    assert_eq!(
        diff(
            &[row("Sync", json!([]), 10.0)],
            &[row("Sync", json!([]), 10.0)]
        )["changed"],
        json!([])
    );
}

/// A field shows a new label for every value typed into it: each is an element, and without a
/// bound every one stayed in `.puppet/native-refs.json` for good. One not seen for a while is
/// dropped, and a new ref is never an old one.
#[test]
fn refs_unseen_for_many_reads_are_forgotten_and_never_reused() {
    let field = |text: &str| node("field", text, None, 66.0);
    let mut stored = Refs::default().to_json();
    let mut first = None;
    for typed in 0..150 {
        let mut refs = Refs::from_json(&stored);
        let rows = refs.rows(&[
            node("button", "Done", None, 10.0),
            field(&typed.to_string()),
        ]);
        first.get_or_insert(rows[0]["ref"].clone());
        assert_eq!(
            rows[0]["ref"],
            first.clone().unwrap(),
            "a row on every screen keeps its ref"
        );
        stored = refs.to_json();
    }
    let kept = stored["keys"].as_object().unwrap().len();
    assert!(kept <= 101, "{kept} keys kept");
    let mut refs = Refs::from_json(&stored);
    assert_eq!(
        refs.rows(&[field("0")])[0]["ref"],
        "n152",
        "a forgotten element gets a new ref"
    );
}

#[test]
fn android_semantics_are_read_in_dp() {
    let tree = from_tree(&json!({
        "scale": 2.625, "screen": {"w": 1080, "h": 2400},
        "nodes": [{"role": "text", "text": "", "id": null,
                   "x": 0, "y": 462, "w": 1080, "h": 1900, "actions": ["scroll"], "flags": []},
                  {"role": "row", "text": "ideas", "id": "folder:ideas", "section": "list",
                   "x": 0, "y": 525, "w": 1080, "h": 147, "actions": ["tap", "hold"], "flags": []}],
        "scroll": [{"section": "list", "down": true, "first": 1, "last": 9, "total": 20}]
    }));
    assert_eq!(tree.scale, 2.625);
    assert!((tree.screen.w - 411.43).abs() < 0.01);
    assert_eq!(
        tree.nodes.len(),
        1,
        "the list's own scroll node is not a target"
    );
    assert_eq!(tree.nodes[0].rect.y, 200.0);
    assert_eq!(tree.scroll[0]["total"], 20);
    let rows = Refs::default().rows(&tree.nodes);
    assert_eq!(rows[0]["section"], "list");
    assert_eq!(rows[0]["folder"], "ideas");
    assert_eq!(rows[0]["handlers"], json!(["tap", "hold"]));
    assert!(row_for(&rows, "folder", "ideas").is_some());
    assert!(row_for(&rows, "note", "ideas").is_none());
}
