//! The phones' native screens as element rows.
//!
//! The editor web view answers `elements` for itself. Every other screen on a phone is
//! SwiftUI or Compose, which the page cannot see, so each phone's debug listener answers
//! `GET /tree` from the app's own accessibility (iOS: its accessibility tree, hit-tested
//! against its windows, apps/ios/Sources/App/PuppetScreenReader.swift; Android: the merged
//! Compose semantics of every window). This turns that into the rows `elements` prints on
//! desktop, in points on iOS and dp on Android, so a row's centre is where `tap` lands.
//! Refs (`n1`, `n2`, …) outlive the call that made them, keyed by what the element is, so a
//! receipt can say which rows came and went.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One element as the platform reports it, before it has a ref.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub role: String,
    pub text: String,
    pub id: Option<String>,
    pub rect: Rect,
    /// Where a touch activates it, when that is not the middle (an iOS switch row's switch).
    pub aim: Option<(f64, f64)>,
    pub handlers: Vec<String>,
    pub flags: Vec<String>,
    /// The part of the screen it is in: `top bar`, `list`, `sheet · list`, `menu`, …
    pub section: String,
    /// The verb that does what touching it does (`A|B` when two do), from `/tree`'s `controls`.
    pub verb: Option<String>,
}

/// A listener's `/tree`: the screen, what is on it, and where each scrolling part can move.
pub struct Tree {
    pub screen: Rect,
    pub nodes: Vec<Node>,
    pub scale: f64,
    pub scroll: Vec<Value>,
    /// A transition is in flight (iOS): the screen is about to change, whatever it shows.
    pub moving: bool,
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The verbs a control stands for: those whose label is its text, or leads it (a toggle row
/// reads its title and then its description), the longest such label winning. The same rule
/// the desktop page applies to its own rows (`verbsFor`, src/app/puppet/puppetElements.ts).
/// `just check-puppet-verbs` holds the labels to the controls at build time; this only names
/// them on screen.
fn verb_for(text: &str, controls: &[(String, Vec<String>)]) -> Option<String> {
    let exact = controls.iter().find(|(label, _)| label == text);
    let lead = || {
        controls
            .iter()
            .filter(|(label, _)| text.starts_with(&format!("{label} ")))
            .max_by_key(|(label, _)| label.len())
    };
    exact.or_else(lead).map(|(_, verbs)| verbs.join("|"))
}

/// A listener's `/tree` as the screen and its rows, in screen units: device units divided by
/// `scale` (1 on iOS, whose units are points; the density on Android, whose are pixels).
pub fn from_tree(body: &Value) -> Tree {
    let scale = body["scale"].as_f64().filter(|s| *s > 0.0).unwrap_or(1.0);
    let dp = |key: &str, value: &Value| value[key].as_f64().unwrap_or(0.0) / scale;
    let screen = Rect {
        x: 0.0,
        y: 0.0,
        w: dp("w", &body["screen"]),
        h: dp("h", &body["screen"]),
    };
    let strings = |value: &Value| -> Vec<String> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    let controls: Vec<(String, Vec<String>)> = body["controls"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(label, verbs)| (one_line(label), strings(verbs)))
        .collect();
    let nodes = body["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|node| {
            let text = one_line(node["text"].as_str().unwrap_or(""));
            let handlers = strings(&node["actions"]);
            // Only a control stands for a verb: a heading that reads like a button does not.
            let control = handlers
                .iter()
                .any(|action| action == "tap" || action == "hold");
            Node {
                role: node["role"].as_str().unwrap_or("text").to_string(),
                verb: control.then(|| verb_for(&text, &controls)).flatten(),
                text,
                id: node["id"].as_str().map(str::to_owned),
                rect: Rect {
                    x: dp("x", node),
                    y: dp("y", node),
                    w: dp("w", node),
                    h: dp("h", node),
                },
                aim: node["aim"]
                    .is_object()
                    .then(|| (dp("x", &node["aim"]), dp("y", &node["aim"]))),
                handlers,
                flags: strings(&node["flags"]),
                section: node["section"].as_str().unwrap_or("content").to_string(),
            }
        })
        .filter(tappable)
        // A scroll container with nothing to read (the list itself) is not a target: the
        // rows inside it are, and a swipe over them scrolls it.
        .filter(|node| {
            !node.text.is_empty()
                || node.id.is_some()
                || node.handlers.iter().any(|action| action != "scroll")
        })
        .collect();
    Tree {
        screen,
        nodes,
        scale,
        scroll: body["scroll"].as_array().cloned().unwrap_or_default(),
        moving: body["moving"] == json!(true),
    }
}

/// A row showing a sliver at the screen's edge (a point or two) is not one a finger can land
/// on, so it is not on screen for tapping.
const SMALLEST_SHOWN: f64 = 8.0;

fn tappable(node: &Node) -> bool {
    node.rect.w >= SMALLEST_SHOWN && node.rect.h >= SMALLEST_SHOWN
}

/// Longer labels are cut, as the page cuts its own at 24 characters; a phone row keeps more,
/// since a note row's label carries its preview as well as its title.
const SHOWN_TEXT: usize = 40;

fn shown(text: &str) -> String {
    if text.chars().count() <= SHOWN_TEXT {
        return text.to_string();
    }
    let cut: String = text.chars().take(SHOWN_TEXT - 1).collect();
    format!("{cut}…")
}

/// How many reads an element is remembered for after it was last on screen: past that it gets a
/// new ref when it comes back, since refs are never reused. Without a bound, every value a
/// field ever showed stayed a key.
const KEPT_READS: u64 = 100;

/// Stable refs: one per distinct element, remembered across calls in `.puppet/`.
#[derive(Debug, Default)]
pub struct Refs {
    next: u64,
    /// This read's number: each element remembers the last read that saw it.
    read: u64,
    by_key: HashMap<String, (String, u64)>,
}

impl Refs {
    pub fn from_json(value: &Value) -> Refs {
        let keys = value["keys"].as_object().into_iter().flatten();
        Refs {
            next: value["next"].as_u64().unwrap_or(1).max(1),
            read: value["read"].as_u64().unwrap_or(0) + 1,
            by_key: keys
                .filter_map(|(key, kept)| {
                    Some((
                        key.clone(),
                        (kept[0].as_str()?.to_owned(), kept[1].as_u64()?),
                    ))
                })
                .collect(),
        }
    }

    pub fn to_json(&self) -> Value {
        let keys: Map<String, Value> = self
            .by_key
            .iter()
            .filter(|(_, (_, seen))| seen + KEPT_READS > self.read)
            .map(|(key, (reference, seen))| (key.clone(), json!([reference, seen])))
            .collect();
        json!({ "next": self.next.max(1), "read": self.read, "keys": keys })
    }

    fn reference(&mut self, key: String) -> String {
        let read = self.read;
        if let Some((reference, seen)) = self.by_key.get_mut(&key) {
            *seen = read;
            return reference.clone();
        }
        let reference = format!("n{}", self.next.max(1));
        self.next = self.next.max(1) + 1;
        self.by_key.insert(key, (reference.clone(), read));
        reference
    }

    /// The nodes as `elements` rows. An element is known by its accessibility id when it
    /// has one (a list row's `note:`/`folder:`), else by role, label and width, counted
    /// when the same one repeats on one screen. The width tells a menu's "Delete" from the
    /// confirmation dialog's "Delete" that replaces it, which would otherwise read as one
    /// element that never changed; a vertical scroll never changes it.
    pub fn rows(&mut self, nodes: &[Node]) -> Vec<Value> {
        let mut seen: HashMap<String, usize> = HashMap::new();
        nodes
            .iter()
            .map(|node| {
                let base = node.id.clone().unwrap_or_else(|| {
                    format!("{}|{}|{}", node.role, node.text, node.rect.w.round())
                });
                let count = seen.entry(base.clone()).or_insert(0);
                *count += 1;
                let key = if *count == 1 {
                    base
                } else {
                    format!("{base}#{count}")
                };
                // No component: a native view has no source file to name.
                let mut row = json!({
                    "ref": self.reference(key),
                    "component": "",
                    "role": node.role,
                    "text": shown(&node.text),
                    "handlers": node.handlers,
                    "flags": node.flags,
                    "section": node.section,
                    "rect": {
                        "x": node.rect.x.round() as i64,
                        "y": node.rect.y.round() as i64,
                        "w": node.rect.w.round() as i64,
                        "h": node.rect.h.round() as i64,
                    },
                });
                if let Some((x, y)) = node.aim {
                    row["aim"] = json!({ "x": x.round() as i64, "y": y.round() as i64 });
                }
                if let Some(verb) = &node.verb {
                    row["verb"] = json!(verb);
                }
                match node.id.as_deref() {
                    Some(id) if id.starts_with("note:") => row["note"] = json!(&id[5..]),
                    Some(id) if id.starts_with("folder:") => row["folder"] = json!(&id[7..]),
                    _ => {}
                }
                row
            })
            .collect()
    }
}

/// Rows that appeared, rows that went, and rows whose place, text or state changed: the rule the
/// desktop page diffs its own rows by (`diffElements`, src/app/puppet/puppetSnapshots.ts).
pub fn diff(before: &[Value], after: &[Value]) -> Value {
    let by_ref = |rows: &[Value]| -> HashMap<String, Value> {
        rows.iter()
            .filter_map(|row| Some((row["ref"].as_str()?.to_owned(), row.clone())))
            .collect()
    };
    let (old, new) = (by_ref(before), by_ref(after));
    let added: Vec<Value> = after
        .iter()
        .filter(|row| row["ref"].as_str().is_some_and(|r| !old.contains_key(r)))
        .cloned()
        .collect();
    let removed: Vec<Value> = before
        .iter()
        .filter(|row| row["ref"].as_str().is_some_and(|r| !new.contains_key(r)))
        .cloned()
        .collect();
    let changed: Vec<Value> = after
        .iter()
        .filter_map(|row| {
            let was = old.get(row["ref"].as_str()?)?;
            let mut change = json!({ "ref": row["ref"], "component": "", "role": row["role"], "text": row["text"] });
            if was["rect"] != row["rect"] {
                change["rect"] = json!([was["rect"], row["rect"]]);
            }
            if was["text"] != row["text"] {
                change["textChange"] = json!([was["text"], row["text"]]);
            }
            if was["flags"] != row["flags"] {
                change["flags"] = json!([was["flags"], row["flags"]]);
            }
            let differs = change.as_object()?.len() > 4;
            change["section"] = row["section"].clone();
            differs.then_some(change)
        })
        .collect();
    json!({ "added": added, "removed": removed, "changed": changed })
}

/// The row a person would act on for this note or folder, if one is on screen.
pub fn row_for<'a>(rows: &'a [Value], kind: &str, id: &str) -> Option<&'a Value> {
    rows.iter().find(|row| row[kind].as_str() == Some(id))
}
