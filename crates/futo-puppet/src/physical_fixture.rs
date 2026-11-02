//! Separate opt-in fixture transport. Never enters simulator/pool resolution.
use super::*;

const USAGE: &str = "physical-fixture capture --manifest <path> | read|close --run <UUID>";

pub(crate) fn dispatch(args: &[String]) -> Option<Result<ExitCode, String>> {
    if args.first().map(String::as_str) != Some("physical-fixture") {
        return None;
    }
    Some(run_fixture(&args[1..]))
}

fn run_fixture(args: &[String]) -> Result<ExitCode, String> {
    let [operation, flag, value] = args else {
        return Err(USAGE.into());
    };
    let valid = match operation.as_str() {
        "capture" => flag == "--manifest" && !value.is_empty(),
        "read" | "close" => flag == "--run" && valid_uuid(value),
        _ => false,
    };
    if !valid {
        return Err(USAGE.into());
    }
    let output = node(
        "scripts/qa/physical-fixture-cli.mjs",
        &[operation, flag, value],
    )?;
    let receipt: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "physical-fixture returned no receipt: {error}; {}",
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    append_trace("physical-fixture", &receipt);
    if receipt["ok"] != true {
        println!(
            "REFUSED physical-fixture {operation}: {}",
            receipt["error"]
                .as_str()
                .unwrap_or("missing refusal reason")
        );
    } else if operation == "read" {
        println!("{}", pretty(&receipt));
    } else {
        let result = &receipt["receipt"];
        println!(
            "OK physical-fixture {operation} · run {}\nstatus {}\nevidence {}",
            result["runID"].as_str().unwrap_or("unknown"),
            result["status"].as_str().unwrap_or("unknown"),
            result["output"]
                .as_str()
                .or_else(|| result["evidenceRetained"].as_str())
                .unwrap_or("retained")
        );
        if let Some(acceptance) = result["acceptance"].as_str() {
            println!("acceptance {acceptance}");
        }
    }
    Ok(if output.status.success() && receipt["ok"] == true {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte)
            }
        })
}
