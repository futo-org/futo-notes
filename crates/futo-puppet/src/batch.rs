//! A `do` batch: refusing positions an earlier step has shifted, and printing the receipts with
//! the screen shown once, as the batch left it.

use super::*;

/// The arguments that name a document position, and therefore go stale behind an edit.
const POSITIONS: [&str; 3] = ["at", "from", "to"];

/// Text arguments that pin a position to text, so a shifted one refuses instead of landing.
const TEXT_PROOFS: [&str; 4] = ["expect", "find", "after", "before"];

/// Did this receipt come from an editor verb that changed the text?
pub(crate) fn wrote_document(receipt: &Value) -> bool {
    receipt["wrote"].is_object()
        || (receipt["editor"].is_object() && receipt["diff"]["doc"].is_object())
}

/// A position is true for exactly one version of the document. The moment a step
/// in the same batch edits the text, every position after the edit has moved — and
/// the next step lands on whatever now sits there, reports 200 and a diff, and
/// nothing says it touched the wrong words. An evaluation run bolded `quick`,
/// then italicised the four characters that used to be `lazy` and shipped it.
///
/// So the batch refuses any step that names a position (`at`, `from`, `to`) without a proof
/// before sending it: `find`/`after`/`before`, `expect` or `docVersion` survives an edit, and a
/// raw position read beforehand does not. Line numbers are not held to this: an edit moves them
/// only when it adds or removes lines, which no receipt counts, and no line verb takes a proof.
/// The ways out are the ones the verb's schema in `menu` takes.
pub(crate) fn stale_offsets_refusal(
    step: usize,
    verb: &str,
    args: &Value,
    edited_by: (usize, &str),
    menu: &Value,
) -> Option<String> {
    let proven =
        args["docVersion"].is_number() || TEXT_PROOFS.iter().any(|proof| args[*proof].is_string());
    if proven || !POSITIONS.iter().any(|key| args[*key].is_number()) {
        return None;
    }
    let takes = |key: &str| verb_takes(menu, verb, key);
    let mut ways = Vec::new();
    if takes("after") {
        ways.push(format!(
            "anchor it by text, {verb} {{\"after\":\"<the text to write after>\"}}"
        ));
    } else if takes("find") {
        ways.push(format!(
            "anchor it by text, {verb} {{\"find\":\"<the exact text you mean>\"}}"
        ));
    }
    if takes("expect") {
        ways.push(
            "prove the range with \"expect\":\"<the text at from-to>\", which refuses when it \
             has moved"
                .into(),
        );
    }
    ways.push("send it in a call of its own once `doc` shows where the text is now".into());
    Some(format!(
        "step {} {verb} {}: step {} {} already changed the document, so the positions you read \
         before it have shifted and this one would land on whatever moved into their place. \
         Instead {}. Nothing was sent.",
        step + 1,
        compact(args),
        edited_by.0 + 1,
        edited_by.1,
        ways.join("; or "),
    ))
}

/// A batch's receipts, raw or as text, and what stopped it: `stopped` is the line for the step
/// that had no receipt (refused before it was sent, or its call failed), and the steps after
/// it or after a refusal never ran.
pub(crate) fn print_receipts(
    receipts: &[Value],
    steps: &[(String, Value)],
    stopped: Option<&str>,
    net: Option<&Value>,
    raw: bool,
) {
    if raw {
        println!("{}", pretty(&Value::Array(receipts.to_vec())));
        if let Some(stopped) = stopped {
            eprintln!("futo-puppet: {stopped}");
        }
        return;
    }
    print!("{}", render_batch(receipts, steps, stopped, net));
}

/// With `net`, the screen's change from before the first step to after the last, a batch shows
/// each step's verdict and facts and then the screen once, as the batch left it: a row that a
/// later step took away again is not on screen to act on. Without it, each step in full.
pub(crate) fn render_batch(
    receipts: &[Value],
    steps: &[(String, Value)],
    stopped: Option<&str>,
    net: Option<&Value>,
) -> String {
    let mut out: String = receipts
        .iter()
        .map(|receipt| render_step(receipt, net.is_none()))
        .collect();
    let mut next = receipts.len();
    if let Some(line) = stopped {
        out.push_str(&format!("{line}\n"));
        next += 1;
    }
    let stopped = stopped.is_some()
        || receipts
            .last()
            .is_some_and(|receipt| receipt["status"].as_u64() >= Some(400));
    if stopped && next < steps.len() {
        let rest: Vec<&str> = steps[next..]
            .iter()
            .map(|(verb, _)| verb.as_str())
            .collect();
        out.push_str(&format!("not run: {}\n", rest.join(", ")));
    }
    if let Some(net) = net {
        out.push_str("the screen now, against before the batch:\n");
        out.push_str(&screen_line(net));
        let rows = render_diff_rows(net);
        out.push_str(if rows.is_empty() {
            "no row changed\n"
        } else {
            &rows
        });
    }
    out
}

/// The desktop page's own diff from before a batch's first step to the page once it has stopped
/// moving: the rows as the batch left them, including any that landed after the last step
/// answered (a sidebar sliding shut finishes after `ToggleSidebar` does). None when no step was
/// recorded or the page no longer holds that snapshot, and the batch then shows every step in
/// full.
pub(crate) fn desktop_net(target: &Target, receipts: &[Value]) -> Option<Value> {
    let action = receipts
        .iter()
        .find_map(|receipt| receipt["result"]["action"].as_u64())?;
    let record = call(target, "diff", &json!({ "action": action })).ok()?;
    let from = record.body["before"].as_u64()?;
    let diff_from = |snapshot: u64| {
        call(target, "diff", &json!({ "from": snapshot }))
            .ok()
            .filter(|reply| reply.status == 200)
    };
    let moved = |reply: &Reply| {
        ["added", "removed", "changed"].iter().any(|change| {
            reply.body["elements"][change]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        })
    };
    // One snapshot per poll, and the page keeps 40: a slow poll and a short ceiling keep the
    // batch's first one; if it is gone anyway, `diff_from(from)` fails and the steps print in full.
    let (poll, ceiling) = (SETTLE_POLL_DESKTOP * 2, SETTLE_CEILING / 2);
    let started = Instant::now();
    let mut last = diff_from(from)?.body["after"].as_u64()?;
    let mut still_since = Instant::now();
    while still_since.elapsed() < SETTLE_QUIET_DESKTOP && started.elapsed() < ceiling {
        std::thread::sleep(poll);
        let since = diff_from(last)?;
        if moved(&since) {
            still_since = Instant::now();
        }
        last = since.body["after"].as_u64()?;
    }
    let net = diff_from(from)?;
    let mut screen = json!({ "elements": net.body["elements"] });
    if net.body["screen"].is_array() {
        screen["screen"] = net.body["screen"].clone();
    }
    Some(screen)
}
