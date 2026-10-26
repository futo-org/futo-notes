//! `futo-puppet` — drive and inspect the running FUTO Notes debug app.
//!
//! One process per call, a command name and one JSON object:
//!
//! ```text
//! futo-puppet actions
//! futo-puppet do OpenNote '{"noteId":"brown fox"}'
//! futo-puppet do '[["Select",{"from":10,"to":15,"expect":"brown"}],["Bold"]]'
//! futo-puppet elements
//! futo-puppet state | doc | at | show | events | diff   '<json>'
//! futo-puppet click '{"x":120,"y":300}'      # desktop: a real mouse click, traced
//! futo-puppet tap '{"x":120,"y":300}'        # iOS/Android: a real touch, traced
//! futo-puppet drag '{"x":..,"y":..,"x2":..,"y2":..}'
//! futo-puppet screenshot                     # the screen as a PNG in .puppet/screens/ (screenshot.rs)
//! ```
//!
//! Every command reaches the same in-page engine (`src/app/puppet`), through the
//! shell's debug channel: the mcp-bridge WebSocket on desktop, the loopback HTTP
//! listener on iOS (`apps/ios/Sources/App/PuppetServer.swift`) and Android
//! (`apps/android/.../puppet/PuppetServer.kt`, reached through `adb forward`).
//! Real input is real: on desktop `click`/`drag` ask the app's debug command
//! (`apps/tauri/src-tauri/src/puppet_input.rs`) to send a platform mouse event to
//! its own window; on the phones `tap`/`drag` aim `axe` at the simulator and
//! `adb shell input` at the device, at the screen point the listener's `/tree`
//! maps a CSS pixel to. Either way it is bracketed by the page's own trace so
//! the answer is the events and the diff, not a screenshot. A phone's native
//! screens (everything but the editor) are read from the platform's
//! accessibility instead (`native.rs`), and their receipts are the screen before
//! and after. Every action's
//! record is appended to `.puppet/trace.jsonl` in the repo. The target
//! comes from the environment, never from flags: `FUTO_PUPPET_TARGET` is
//! `desktop` (default), `ios` or `android`; `FUTO_PUPPET_PORT` pins a phone listener's port,
//! otherwise the worktree slot decides (`scripts/lib/slot.mjs`). A desktop port is accepted
//! only after `scripts/qa-target.mjs` verifies it belongs to a debug build of this
//! worktree (AGENTS.md M24); that yes is remembered for the one process it named, in
//! `.puppet/verified-desktop-app.json`.
//!
//! Design record: docs/research/agent-native-app-design.md.

// A CLI: its output is the product.
#![allow(clippy::print_stdout, clippy::print_stderr)]

mod app;
mod batch;
mod call;
mod desktop_bridge;
mod file;
mod gesture;
mod gesture_arguments;
mod json_text;
mod native;
mod phone_listener;
mod reads;
mod receipts;
mod refusals;
mod relaunch;
mod render_diff;
mod render_reads;
mod run;
mod screen;
mod screenshot;
mod send_verb;
mod shortcuts;
mod suggest;
mod target;
#[cfg(test)]
mod tests;
mod trace;
mod verified_app;

use batch::*;
use call::*;
use desktop_bridge::*;
use file::*;
use gesture::*;
use gesture_arguments::*;
use json_text::*;
use phone_listener::*;
use reads::*;
use receipts::*;
use refusals::*;
use relaunch::*;
use render_diff::*;
use render_reads::*;
use run::*;
use send_verb::*;
use shortcuts::*;
use target::*;
use trace::*;
use verified_app::*;

use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

const USAGE: &str = "usage:
  futo-puppet look                               the whole screen in one read: state, elements, the screen's verbs, the vault's size
  futo-puppet actions
  futo-puppet do <Verb> ['<json args>']
  futo-puppet do '[[\"Verb\",{…}],[\"Verb\"],…]'
  futo-puppet notes                              every note id and folder path in the vault
  futo-puppet search '{\"query\":\"…\"[,\"limit\":N]}'    the app's own search, best match first (default 10)
  futo-puppet file '{\"noteId\":\"…\"[,\"save\":false][,\"lines\":\"40-60\"][,\"find\":\"…\"][,\"around\":N]}'   the note's markdown on disk, every line unless narrowed. It saves the open note's pending edits first (409 if the note asked for has edits that cannot save); \"save\":false reads the disk as it is, saving nothing, so any edits not saved yet are not in it. Its numbers are the file's lines, not doc's
  futo-puppet elements|state|doc|at|show|events|diff ['<json args>']   doc: the note's lines on screen; show {\"text\"}: where that text shows
  futo-puppet click '{\"x\":N,\"y\":N[,\"hold\":seconds][,\"button\":\"right\"][,\"count\":2]}'   (desktop)
  futo-puppet tap '{\"x\":N,\"y\":N[,\"hold\":seconds]}'        (ios, android)
  futo-puppet drag '{\"x\":N,\"y\":N,\"x2\":N,\"y2\":N[,\"duration\":seconds]}'   on a phone, a swipe
  futo-puppet scroll '{\"x\":N,\"y\":N,\"dy\":N[,\"dx\":N]}'   (desktop) mouse wheel over the point, CSS px; dy > 0 scrolls down
  futo-puppet type '{\"text\":\"…\"[,\"delay\":ms]}'   real key presses into whatever has focus: click or tap the field first; on a phone, delay paces them like a person
  futo-puppet press '{\"key\":\"Enter\"}'   a key, \"count\":N times: Enter, Backspace, Tab, Escape, arrows (desktop: any chord, e.g. Mod-b); Back is Android's system Back
  Any gesture takes {\"ref\":\"e12\"} instead of x,y: the centre of that element from elements;
  tap, click and drag take {\"text\":\"…\"}: the middle of that text on screen (a drag, across it).
  Text off screen is reached with ScrollToLine, as a scroll wheel would; Find stays its own verbs.
  On a phone x,y are screen points (iOS) or dp (Android) everywhere, the editor included;
  `elements` lists the whole screen: native rows as n-refs, the editor page's as e-refs.
  futo-puppet step [<Verb> ['<json args>']]   one turn for a program: act once, then observe everything (JSON)
  futo-puppet screenshot                     the screen as a PNG in .puppet/screens/: a colour, a layout, what only pixels say
  futo-puppet relaunch                       (ios, android) close the app and open it again; answers with `look`
Editing verbs take the text, not only offsets: Replace {\"find\":\"old\",\"text\":\"new\"},
Select {\"find\":\"word\"}, Insert {\"after\":\"line\",\"text\":\"…\"} — an anchor cannot go stale.
Add {\"json\":true} to any args for the raw typed form.
Target: FUTO_PUPPET_TARGET=desktop|ios|android (default desktop), FUTO_PUPPET_PORT=<port> (phones only; default: worktree slot).
How to drive the app with this (read first): .claude/skills/puppet/SKILL.md";

const QUERIES: [&str; 12] = [
    "actions",
    "elements",
    "state",
    "notes",
    "search",
    "file",
    "doc",
    "at",
    "show",
    "events",
    "diff",
    "clipboard",
];

const GESTURES: [&str; 6] = ["click", "tap", "drag", "scroll", "type", "press"];

struct Reply {
    status: u16,
    body: Value,
}

impl Reply {
    /// A refusal made on this side, in the app's own shape.
    fn refusal(status: u16, error: impl std::fmt::Display) -> Reply {
        Reply {
            status,
            body: json!({ "ok": false, "error": error.to_string() }),
        }
    }
}

/// Which native shell answers, and therefore which tool lands a real touch.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum NativePlatform {
    Ios,
    Android,
}

impl NativePlatform {
    fn name(self) -> &'static str {
        match self {
            NativePlatform::Ios => "ios",
            NativePlatform::Android => "android",
        }
    }

    /// The command that launches the debug app on `device`, this worktree's claim. Run bare,
    /// the recipes take the first booted simulator or the only device attached.
    fn launch_command(self, device: &str) -> String {
        match self {
            NativePlatform::Ios => format!("SIM={device} just ios-native"),
            NativePlatform::Android => format!("ANDROID_SERIAL={device} just android-native"),
        }
    }
}

enum Target {
    Desktop(u16),
    /// The shell, the port its listener answers on here, and the device it runs on: this
    /// worktree's claim (adb's serial, or the simulator's udid).
    Native(NativePlatform, u16, String),
}

enum Invocation {
    /// The steps, and whether to print the raw receipts (`{"json":true}` in any step's args).
    Do(Vec<(String, Value)>, bool),
    Query(String, Value),
    Gesture(String, Value),
    /// One turn for a program driving the app: optionally run one verb, then observe everything. JSON only.
    Step(Option<(String, Value)>),
    /// The screen as a PNG under `.puppet/screens/` (screenshot.rs).
    Screenshot,
    /// `state`, `elements`, `actions` and `notes` (and `doc` with a note open) in one read.
    Look,
    /// Close the app and open it again, then `look`.
    Relaunch,
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("futo-puppet: {message}");
    ExitCode::from(1)
}

// ---------------------------------------------------------------------------
// Arguments

fn parse_json_object(raw: Option<&str>, what: &str) -> Result<Value, String> {
    let Some(raw) = raw else { return Ok(json!({})) };
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("{what}: not valid JSON ({e})"))?;
    if !value.is_object() {
        return Err(format!("{what}: expected a JSON object, got {value}"));
    }
    Ok(value)
}

/// `do Verb [json]` or `do '[[Verb, args], [Verb], …]'` — both become ordered steps.
fn parse_do(rest: &[String]) -> Result<Vec<(String, Value)>, String> {
    let Some(first) = rest.first() else {
        return Err("do needs a verb or a JSON array of steps".into());
    };
    if first.trim_start().starts_with('[') {
        if let Some(extra) = rest.get(1) {
            return Err(format!(
                "do: a batch is one argument, and each step carries its own args; `{extra}` is left over"
            ));
        }
        let steps: Value =
            serde_json::from_str(first).map_err(|e| format!("do: not valid JSON ({e})"))?;
        let Some(steps) = steps.as_array().filter(|steps| !steps.is_empty()) else {
            return Err("do: expected a JSON array of one or more steps".into());
        };
        return steps
            .iter()
            .map(|step| {
                let parts = match step {
                    Value::Array(parts) => parts.as_slice(),
                    _ => std::slice::from_ref(step),
                };
                match parts {
                    [Value::String(verb)] => Ok((verb.clone(), json!({}))),
                    [Value::String(verb), args @ Value::Object(_)] => {
                        Ok((verb.clone(), args.clone()))
                    }
                    _ => Err(format!(
                        "do: each step is [\"Verb\"] or [\"Verb\", {{…}}], got {step}"
                    )),
                }
            })
            .collect();
    }
    // `do 'OpenNote {"noteId":"x"}'`: the verb and its JSON quoted as one argument.
    if let Some((verb, args)) = first.trim().split_once(char::is_whitespace) {
        if let Ok(args @ Value::Object(_)) = serde_json::from_str::<Value>(args) {
            // A gesture or a read is its own command, not a verb.
            let command = if GESTURES.contains(&verb) || QUERIES.contains(&verb) {
                verb.to_string()
            } else {
                format!("do {verb}")
            };
            return Err(format!(
                "do: `{first}` is a command and its arguments in one string; they go as two: {command} {}",
                shell_json(&args)
            ));
        }
    }
    Ok(vec![(
        first.clone(),
        parse_json_object(rest.get(1).map(String::as_str), first)?,
    )])
}

fn parse_invocation(args: &[String]) -> Result<Invocation, String> {
    let command = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or_default();
    // An argument past what the command takes is a mistake, not something to ignore.
    let (most, takes) = match command {
        Some("do" | "step") => (2, "a verb and one JSON object"),
        Some("screenshot" | "look" | "relaunch") => (0, "no arguments"),
        _ => (1, "one JSON object"),
    };
    if let (Some(command), Some(extra)) = (command, rest.get(most)) {
        return Err(format!(
            "{command} takes {takes}; `{extra}` is one too many"
        ));
    }
    match command {
        Some("do") => {
            let mut steps = parse_do(rest)?;
            // `{"json":true}` is the raw form here as for every other command, and no verb's.
            let raw = steps
                .iter_mut()
                .fold(false, |raw, (_, args)| take_json_switch(args) || raw);
            Ok(Invocation::Do(steps, raw))
        }
        Some(command) if QUERIES.contains(&command) => Ok(Invocation::Query(
            command.to_string(),
            parse_json_object(rest.first().map(String::as_str), command)?,
        )),
        Some(gesture) if GESTURES.contains(&gesture) => {
            let gesture_args = parse_json_object(rest.first().map(String::as_str), gesture)?;
            match gesture_argument_error(gesture, &gesture_args) {
                Some(error) => Err(error),
                None => Ok(Invocation::Gesture(gesture.to_string(), gesture_args)),
            }
        }
        Some("step") => match rest.first() {
            None => Ok(Invocation::Step(None)),
            Some(first) if first.trim_start().starts_with('[') => {
                Err("step runs one verb: step <Verb> ['<json args>']; a batch is `do`".into())
            }
            Some(_) => {
                let (verb, mut verb_args) = parse_do(rest)?.remove(0);
                // Its output is always JSON: the switch is the CLI's alone.
                take_json_switch(&mut verb_args);
                Ok(Invocation::Step(Some((verb, verb_args))))
            }
        },
        Some("screenshot") => Ok(Invocation::Screenshot),
        Some("look") => Ok(Invocation::Look),
        Some("relaunch") => Ok(Invocation::Relaunch),
        _ => Err(USAGE.to_string()),
    }
}

/// `{"json":true}` is the CLI's own switch; it never travels to the app.
fn take_json_switch(args: &mut Value) -> bool {
    args.as_object_mut()
        .and_then(|object| object.remove("json"))
        == Some(Value::Bool(true))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => code,
        Err(message) => fail(message),
    }
}
