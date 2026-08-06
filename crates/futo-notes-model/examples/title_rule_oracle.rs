use std::io::{self, Read};

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TitleRuleOutcome {
    sanitized: String,
    issue_kinds: Vec<&'static str>,
}

fn main() {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("read title-rule corpus from stdin");
    let titles: Vec<String> = serde_json::from_str(&input).expect("title-rule corpus is JSON");
    let outcomes = titles
        .iter()
        .map(|title| TitleRuleOutcome {
            sanitized: futo_notes_model::sanitize_title(title),
            issue_kinds: futo_notes_model::validate_title(title)
                .iter()
                .map(|issue| issue.kind.as_str())
                .collect(),
        })
        .collect::<Vec<_>>();
    serde_json::to_writer(io::stdout(), &outcomes).expect("write title-rule outcomes as JSON");
}
