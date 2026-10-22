//! May this CLI drive the desktop app listening on a port? `scripts/qa-target.mjs` decides
//! (AGENTS.md M24), and a yes is remembered in `.puppet/verified-desktop-app.json` for the one
//! process it named.

use super::*;

const VERIFIED_APP_FILE: &str = ".puppet/verified-desktop-app.json";

/// The only sanctioned answer to "may I drive whatever listens on this port?" (M24).
///
/// `scripts/qa-target.mjs` decides, and costs ~100 ms of node per call, so a yes is
/// remembered for exactly the process it was about: the pid listening on the port, its
/// start time and executable (so a reused pid never matches), and the raw contents of its
/// vault override (the one input to the verdict that can change while the process runs).
/// Anything different re-verifies; a refusal is never remembered.
pub(crate) fn desktop_port_is_this_worktree(port: u16) -> bool {
    let Some((pid, process)) = listener_process(port) else {
        // No lsof or ss: no identity to remember a verdict by, so ask every time.
        return node("scripts/qa-target.mjs", &["port", &port.to_string()])
            .is_ok_and(|o| o.status.success());
    };
    let cache = repo_root().join(VERIFIED_APP_FILE);
    if remembered_app()
        .as_ref()
        .is_some_and(|entry| vouches_for(entry, port, pid, &process, &vault_override))
    {
        return true;
    }
    let Ok(output) = node(
        "scripts/qa-target.mjs",
        &["pid", &pid.to_string(), "--json"],
    ) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    if let Some(data_dir) = verdict["dataDir"].as_str() {
        let raw_override = vault_override(data_dir);
        // Remember only the vault qa-target just approved, not one written since.
        let override_vault = raw_override
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|o| o["notesDir"].as_str().map(str::to_owned));
        if verdict["verdict"] == "verified"
            && override_vault.as_deref() == verdict["notesDir"].as_str()
        {
            let entry = json!({ "port": port, "pid": pid, "process": process,
                                "dataDir": data_dir, "vaultOverride": raw_override });
            std::fs::create_dir_all(cache.parent().unwrap_or(&cache)).ok();
            std::fs::write(&cache, entry.to_string()).ok();
        }
    }
    true
}

pub(crate) fn remembered_app() -> Option<Value> {
    let text = std::fs::read_to_string(repo_root().join(VERIFIED_APP_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// A remembered verdict holds only for the same listener, the same process and the same vault.
fn vouches_for(
    entry: &Value,
    port: u16,
    pid: u32,
    process: &str,
    vault_override: &dyn Fn(&str) -> Option<String>,
) -> bool {
    let Some(data_dir) = entry["dataDir"].as_str() else {
        return false;
    };
    entry["port"] == json!(port)
        && entry["pid"] == json!(pid)
        && entry["process"] == json!(process)
        && entry["vaultOverride"] == json!(vault_override(data_dir))
}

/// The pid listening on `port`, and `ps`'s start time plus executable path for it. `lsof`, or
/// on a Linux without it `ss`, as `scripts/qa-target.mjs` asks.
#[cfg(not(windows))]
pub(crate) fn listener_process(port: u16) -> Option<(u32, String)> {
    let run = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let pid = run(
        "lsof",
        &["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"],
    )
    .and_then(|pids| pids.lines().next()?.trim().parse().ok())
    .or_else(|| ss_listener_pid(&run("ss", &["-ltnpH", &format!("sport = :{port}")])?))?;
    let process = run("ps", &["-p", &pid.to_string(), "-o", "lstart=,comm="])?;
    (!process.is_empty()).then_some((pid, process))
}

/// The pid in `ss -ltnp`'s `users:(("name",pid=123,fd=4))`.
#[cfg(not(windows))]
pub(crate) fn ss_listener_pid(listeners: &str) -> Option<u32> {
    let (_, after) = listeners.split_once("pid=")?;
    after
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

/// Windows has neither `lsof` nor `ps`: the same answer from the system's TCP table and the
/// process itself — its creation time (so a reused pid never matches) and executable path.
#[cfg(windows)]
pub(crate) fn listener_process(port: u16) -> Option<(u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: the first call reports the size the table needs; the second fills a buffer of
    // that size (u32-aligned, as the table is), and the rows are read within its count.
    let pid = unsafe {
        let mut size = 0;
        let listeners = |buffer: *mut std::ffi::c_void, size: &mut u32| {
            GetExtendedTcpTable(
                buffer,
                size,
                0,
                u32::from(AF_INET),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        listeners(std::ptr::null_mut(), &mut size);
        let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
        if listeners(buffer.as_mut_ptr().cast(), &mut size) != 0 {
            return None;
        }
        let table = &*buffer.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
        // The port sits in the low 16 bits, in network byte order.
        rows.iter()
            .find(|row| u16::from_be(row.dwLocalPort as u16) == port)?
            .dwOwningPid
    };
    // SAFETY: a handle opened here and closed before returning; the path buffer's length goes
    // in and the written length comes back.
    let process = unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut times = [FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        }; 4];
        let [created, exited, kernel, user] = &mut times;
        let mut path = [0u16; 1024];
        let mut length = path.len() as u32;
        let read = GetProcessTimes(handle, created, exited, kernel, user) != 0
            && QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut length) != 0;
        CloseHandle(handle);
        if !read {
            return None;
        }
        let started =
            (u64::from(times[0].dwHighDateTime) << 32) | u64::from(times[0].dwLowDateTime);
        format!(
            "{started} {}",
            String::from_utf16_lossy(&path[..length as usize])
        )
    };
    Some((pid, process))
}

/// The app's persisted vault choice, which qa-target reads to refuse the real vault.
fn vault_override(data_dir: &str) -> Option<String> {
    std::fs::read_to_string(PathBuf::from(data_dir).join("notes-dir-override.json")).ok()
}

#[cfg(test)]
mod verified_app_tests {
    use super::vouches_for;

    #[cfg(not(windows))]
    #[test]
    fn ss_names_the_pid_listening_where_lsof_is_missing() {
        let line =
            r#"LISTEN 0 128 127.0.0.1:9823 0.0.0.0:* users:(("futo-notes-taur",pid=49460,fd=20))"#;
        assert_eq!(super::ss_listener_pid(line), Some(49460));
        assert_eq!(
            super::ss_listener_pid("LISTEN 0 4096 127.0.0.1:43299 0.0.0.0:*"),
            None
        );
    }
    use serde_json::json;

    const PROCESS: &str = "Thu Sep 24 11:42:21 2026     /repo/target/debug/futo-notes-tauri";

    fn entry() -> serde_json::Value {
        json!({ "port": 9269, "pid": 26881, "process": PROCESS,
                "dataDir": "/repo/.tauri-data", "vaultOverride": null })
    }

    #[test]
    fn a_remembered_yes_holds_only_for_the_same_process_and_vault() {
        let no_override = |_: &str| None;
        assert!(vouches_for(&entry(), 9269, 26881, PROCESS, &no_override));
        // A pid mismatch: the app restarted.
        assert!(!vouches_for(&entry(), 9269, 31337, PROCESS, &no_override));
        // A stale entry: the pid was reused by a process that started later.
        let later = PROCESS.replace("11:42:21", "11:50:02");
        assert!(!vouches_for(&entry(), 9269, 26881, &later, &no_override));
        // Another port, or the vault moved since qa-target looked.
        assert!(!vouches_for(&entry(), 9270, 26881, PROCESS, &no_override));
        let moved = |_: &str| Some(r#"{"notesDir":"/Users/me/Documents/futo-notes"}"#.to_string());
        assert!(!vouches_for(&entry(), 9269, 26881, PROCESS, &moved));
        assert!(!vouches_for(&json!({}), 9269, 26881, PROCESS, &no_override));
    }
}
