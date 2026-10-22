//! One invocation carried out: the target, the call, and its answer printed.

use super::*;

/// How long `step` waits for an opened note's document to arrive before observing anyway.
const OPEN_NOTE_LOAD_CEILING: Duration = Duration::from_millis(1500);

pub(crate) fn run(args: &[String]) -> Result<ExitCode, String> {
    let invocation = parse_invocation(args)?;
    let target = resolve_target()?;
    match invocation {
        Invocation::Do(steps, raw) => run_batch(&target, steps, raw),
        Invocation::Query(command, mut query_args) => {
            let raw = take_json_switch(&mut query_args);
            let reply = query(&target, &command, &query_args)?;
            Ok(print_reply(&reply, raw, |body| {
                render_query(&command, body)
            }))
        }
        Invocation::Gesture(name, mut gesture_args) => {
            let raw = take_json_switch(&mut gesture_args);
            let reply = match target {
                Target::Native(..) => screen::gesture(&target, &name, &gesture_args)?,
                Target::Desktop(_) => desktop_gesture(&target, &name, gesture_args)?,
            };
            if reply.status == 200 {
                append_trace("gesture", &reply.body);
            }
            if raw {
                println!("{}", pretty(&reply.body));
            } else {
                print!("{}", render_gesture(&name, &reply));
            }
            Ok(exit_code(reply.status == 200))
        }
        Invocation::Step(verb) => run_step(&target, verb),
        Invocation::Screenshot => {
            println!("{}", screenshot::capture(&target)?);
            Ok(ExitCode::SUCCESS)
        }
        Invocation::Look => {
            print!("{}", look(&target)?);
            Ok(ExitCode::SUCCESS)
        }
        Invocation::Relaunch => {
            let receipt = relaunch(&target)?;
            append_trace("relaunch", &json!({ "receipt": receipt }));
            print!("{receipt}");
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// A `do`'s steps in order, each with this screen's menu read once for it. A refusal stops the
/// batch, and so does a step whose call failed once an earlier step ran: what ran is printed,
/// and the exit is 2, never the 1 that says nothing reached the app.
fn run_batch(target: &Target, mut steps: Steps, raw: bool) -> Result<ExitCode, String> {
    let mut receipts = Vec::new();
    // The line for the step that has no receipt: refused before it was sent, or failed.
    let mut stopped: Option<String> = None;
    let mut failed = false;
    // A phone's screen before the first step and after the last, for the batch's net change.
    let mut first_screen: Option<screen::View> = None;
    let mut last_screen: Option<screen::View> = None;
    // Which earlier step in this batch moved the text under later positions.
    let mut edited_by: Option<(usize, String)> = None;
    let mut step = 0;
    while step < steps.len() {
        let (verb, verb_args) = steps[step].clone();
        let menu = menu(target);
        let stale = match (&menu, &edited_by) {
            (Ok(menu), Some((at, editor))) => {
                stale_offsets_refusal(step, &verb, &verb_args, (*at, editor), menu)
            }
            _ => None,
        };
        if let Some(refusal) = stale {
            stopped = Some(format!("REFUSED {verb} (not sent): {refusal}"));
            break;
        }
        let ran = menu.and_then(|menu| {
            // A shortcut argument stands for the steps after its verb: they run once it has.
            // The verb is sent with it (its schema takes it, its run ignores it), so the
            // batch a refusal prints to reach a row keeps it.
            let then = shortcut_steps(&menu, &verb, &verb_args);
            run_verb(target, &menu, &verb, &verb_args).map(|ran| (ran, then))
        });
        let ((reply, views), then) = match ran {
            Ok(ran) => ran,
            Err(error) if receipts.is_empty() => return Err(error),
            Err(error) => {
                stopped = Some(format!("FAILED {verb}: {error}"));
                failed = true;
                break;
            }
        };
        if let Some((before, after)) = views {
            first_screen.get_or_insert(before);
            last_screen = Some(after);
        }
        let refused = reply.status >= 400;
        if !refused && wrote_document(&reply.body) && edited_by.is_none() {
            edited_by = Some((step, verb.clone()));
        }
        let receipt = json!({ "verb": verb, "status": reply.status, "result": reply.body });
        append_trace("do", &receipt);
        receipts.push(receipt);
        if refused {
            break;
        }
        if let Some(then) = then {
            steps.splice(step + 1..step + 1, then);
        }
        step += 1;
    }
    let net = match (target, &first_screen, &last_screen) {
        // An app that stopped answering would only time out again.
        _ if receipts.len() < 2 || failed => None,
        (Target::Native(..), Some(first), Some(last)) => Some(screen::change(first, last)),
        (Target::Desktop(_), ..) => desktop_net(target, &receipts),
        _ => None,
    };
    print_receipts(&receipts, &steps, stopped.as_deref(), net.as_ref(), raw);
    let refused = receipts
        .last()
        .is_some_and(|receipt| receipt["status"].as_u64() >= Some(400));
    Ok(exit_code(stopped.is_none() && !refused))
}

/// One turn for a program: run one verb as `do` does, then observe everything, as JSON.
fn run_step(target: &Target, verb: Option<(String, Value)>) -> Result<ExitCode, String> {
    let receipt = match verb {
        Some((verb, verb_args)) => {
            let (reply, _) = run_verb(target, &menu(target)?, &verb, &verb_args)?;
            let receipt = json!({ "verb": verb, "status": reply.status, "result": reply.body });
            append_trace("do", &receipt);
            receipt
        }
        None => Value::Null,
    };
    // A note opens asynchronously: an observation taken before its document has
    // loaded shows a ready editor with an empty document, and a driver would act on
    // nothing. ponytail: an empty note is indistinguishable from a loading one, so it
    // costs the whole wait; a loaded-note signal from the shell would remove that.
    // A desktop verb's receipt already waits for any note switch it started to land
    // (`settledRun`), so after one there is nothing left to wait for.
    let switch_settled = matches!(target, Target::Desktop(_)) && !receipt.is_null();
    let deadline = if switch_settled {
        Instant::now()
    } else {
        Instant::now() + OPEN_NOTE_LOAD_CEILING
    };
    let observation = loop {
        let observation = call(target, "observe", &json!({}))?;
        let body = &observation.body;
        // `editor:new` is an untitled buffer: empty by definition, nothing to wait for.
        let opened_note = body["screen"]
            .as_str()
            .is_some_and(|s| s.starts_with("editor:") && s != "editor:new");
        // The note has arrived once the editor holds it, and a large note streams its
        // tail in after that.
        let shown = body["screen"]
            .as_str()
            .and_then(|s| s.strip_prefix("editor:"));
        let loading = opened_note
            && (body["editor"]["ready"] != Value::Bool(true)
                || body["editor"]["note"].as_str() != shown
                || body["editor"]["loading"] == Value::Bool(true));
        if !loading || Instant::now() > deadline {
            break observation;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    println!(
        "{}",
        compact(&json!({ "receipt": receipt, "observation": observation.body }))
    );
    Ok(ExitCode::SUCCESS)
}

/// Success, or 2: the app refused, or a batch stopped before its end.
fn exit_code(ok: bool) -> ExitCode {
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(2)
    }
}

/// A read's reply: rendered when it succeeded, its JSON when asked for or refused. Any refusal
/// exits 2.
fn print_reply(reply: &Reply, raw: bool, render: impl FnOnce(&Value) -> String) -> ExitCode {
    if raw || reply.status != 200 {
        println!("{}", pretty(&reply.body));
    } else {
        print!("{}", render(&reply.body));
    }
    exit_code(reply.status == 200)
}
