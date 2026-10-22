//! Shortcut arguments: an argument of a verb that stands for the steps run after it (`actions`'
//! `shortcuts`), such as `answer`, which presses the dialog's own button.

use super::*;

/// A verb whose control asks first takes `answer`, and on every platform that is the
/// dialog's own button, pressed next: a shortcut the CLI adds, so no app does again what
/// its dialog does, and the dialog's code (its delete, its toast) is what runs.
pub(crate) fn answer_through_dialog(actions: &mut Value) {
    for action in actions["actions"].as_array_mut().into_iter().flatten() {
        if action["schema"]["properties"].get("answer").is_some() {
            action["shortcuts"]["answer"] =
                json!({"confirm": [["ConfirmDialog"]], "dismiss": [["DismissDialog"]]});
        }
    }
}

/// What a shortcut argument does for the agent, in the verbs it stands for:
/// `SetNewFolderName {"name":"<name>"}, SubmitNewFolder`. A shortcut whose steps depend on
/// the value lists each value's.
pub(crate) fn shortcut_text(argument: &str, steps: &Value) -> String {
    let placeholder = json!(format!("<{argument}>"));
    let list = |steps: &Value| {
        steps
            .as_array()
            .into_iter()
            .flatten()
            .map(|step| {
                let (verb, args) = shortcut_step(step, &placeholder);
                if args.as_object().is_some_and(Map::is_empty) {
                    verb
                } else {
                    format!("{verb} {}", compact(&args))
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    match steps.as_object() {
        Some(by_value) => by_value
            .iter()
            .map(|(value, steps)| format!("{value}: {}", list(steps)))
            .collect::<Vec<_>>()
            .join("; "),
        None => list(steps),
    }
}

/// One `[Verb, {args}]` of a shortcut, with `"$"` (in the verb's place or as an argument's
/// value) standing for the value the agent gave.
fn shortcut_step(step: &Value, value: &Value) -> (String, Value) {
    let fill = |part: &Value| {
        if part == "$" {
            value.clone()
        } else {
            part.clone()
        }
    };
    let verb = match fill(&step[0]) {
        Value::String(verb) => verb,
        other => other.to_string(),
    };
    let args = match &step[1] {
        Value::Object(args) => {
            Value::Object(args.iter().map(|(k, v)| (k.clone(), fill(v))).collect())
        }
        _ => json!({}),
    };
    (verb, args)
}

/// The steps a call's shortcut arguments stand for, run after its verb (`actions`'
/// `shortcuts`). None when it uses none.
pub(crate) fn shortcut_steps(menu: &Value, verb: &str, args: &Value) -> Option<Steps> {
    let shortcuts = menu["actions"]
        .as_array()?
        .iter()
        .find(|action| action["name"] == verb)?["shortcuts"]
        .as_object()?;
    let given = args.as_object()?;
    let mut steps = Vec::new();
    for (argument, template) in shortcuts {
        let Some(value) = given.get(argument) else {
            continue;
        };
        let template = match template.as_object() {
            Some(by_value) => by_value.get(value.as_str().unwrap_or_default())?,
            None => template,
        };
        steps.extend(
            template
                .as_array()?
                .iter()
                .map(|step| shortcut_step(step, value)),
        );
    }
    (!steps.is_empty()).then_some(steps)
}

/// A `do`'s ordered steps: each verb and its arguments.
pub(crate) type Steps = Vec<(String, Value)>;
