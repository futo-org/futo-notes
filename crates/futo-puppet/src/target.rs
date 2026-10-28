//! Which app a call reaches. `FUTO_PUPPET_TARGET` picks desktop, iOS or Android; the worktree
//! slot (`scripts/lib/slot.mjs`) picks the port; a phone's device is this worktree's claim
//! (`scripts/qa.mjs`). A desktop port must also pass verified_app.rs.

use super::*;

/// Two levels above this crate, spelled without `..`: every path printed for an agent to open
/// starts here, and Windows can only canonicalize a `..` away into a verbatim `\\?\C:\…` path.
pub(crate) fn repo_root() -> PathBuf {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .ancestors()
        .nth(2)
        .unwrap_or(manifest_dir)
        .to_path_buf()
}

pub(crate) fn node(script: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("node")
        .arg(repo_root().join(script))
        .args(args)
        .output()
        .map_err(|e| format!("could not run node {script}: {e}"))
}

fn slot_port(name: &str) -> Result<u16, String> {
    let output = node("scripts/lib/slot.mjs", &[name])?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| format!("scripts/lib/slot.mjs {name} printed no port"))
}

fn port_from_env(name: &str) -> Result<Option<u16>, String> {
    match std::env::var(name) {
        Ok(raw) => raw
            .trim()
            .parse()
            .map(Some)
            .map_err(|_| format!("{name}='{raw}' is not a port")),
        Err(_) => Ok(None),
    }
}

const DESKTOP_PORT_SCAN: u16 = 100;

fn listening(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(50)).is_ok()
}

/// Never pinned by `FUTO_PUPPET_PORT`: that is the phone listener's port, and
/// `eval "$(node scripts/lib/slot.mjs env)"` exports it, so a desktop that read it sent every
/// call to the phone port and `qa-target.mjs` refused them all (2026-10-07).
fn resolve_desktop_port() -> Result<u16, String> {
    // The app verified last time is nearly always still the answer; trying it first
    // also skips the slot lookup, another node start. No `listening` probe first: the bridge
    // logs a bare connect as a failed WebSocket handshake, an [ERROR] line on every call.
    let remembered = remembered_app().and_then(|app| u16::try_from(app["port"].as_u64()?).ok());
    if let Some(port) = remembered.filter(|&port| desktop_port_is_this_worktree(port)) {
        return Ok(port);
    }
    let base = slot_port("mcp")?;
    for port in base..base + DESKTOP_PORT_SCAN {
        if listening(port) && desktop_port_is_this_worktree(port) {
            return Ok(port);
        }
    }
    Err(format!("no debug desktop app of this worktree found on ports {base}-{}; start one with `just tauri-dev`", base + DESKTOP_PORT_SCAN - 1))
}

pub(crate) fn resolve_target() -> Result<Target, String> {
    let platform = match std::env::var("FUTO_PUPPET_TARGET")
        .as_deref()
        .unwrap_or("desktop")
    {
        "desktop" => return Ok(Target::Desktop(resolve_desktop_port()?)),
        "ios" => NativePlatform::Ios,
        "android" => NativePlatform::Android,
        other => {
            return Err(format!(
                "FUTO_PUPPET_TARGET='{other}' — use desktop, ios or android"
            ))
        }
    };
    // Both native shells answer on the worktree's puppet port: iOS binds it directly, Android
    // listens on a local socket inside the device that this one is forwarded to.
    let port = match port_from_env("FUTO_PUPPET_PORT")? {
        Some(port) => port,
        // Separate host ports: a simulator shares this Mac's loopback while an emulator is
        // reached through `adb forward`, so one number for both blocked a worktree from
        // running the second.
        None if platform == NativePlatform::Ios => slot_port("puppet")?,
        None => match port_from_env("FUTO_PUPPET_ANDROID_PORT")? {
            Some(port) => port,
            None => slot_port("puppetAndroid")?,
        },
    };
    // The device the claim recorded, while its port takes a connection (the app's listener on
    // iOS, which http() holds to the simulator): no node. Anything else (no claim, nothing
    // recorded, an app not running) asks qa.mjs, which claims, boots or re-reads the device.
    let device = match (platform, recorded_device(platform)) {
        (NativePlatform::Android, recorded) => forwarded_device(recorded, port)?,
        (NativePlatform::Ios, Some(device)) if listening(port) => device,
        (NativePlatform::Ios, _) => claimed_device(platform)?,
    };
    Ok(Target::Native(platform, port, device))
}

/// This worktree's emulator, with `port` forwarded to its listener. A forward to another
/// device is refused: a worktree in the same slot has the same port, and a call through its
/// forward reaches its emulator. A missing one (an emulator or adb restart drops it) is made
/// with `--no-rebind`, which never takes another worktree's; this device's forward to
/// anything else (an older build's TCP listener) is pointed at the listener.
fn forwarded_device(recorded: Option<String>, port: u16) -> Result<String, String> {
    let forwards = adb(&["forward", "--list"])?;
    let forward = forward_of(&forwards, port);
    if let Some(device) =
        recorded.filter(|device| forward == Some((device.as_str(), ANDROID_LISTENER)))
    {
        return Ok(device);
    }
    let device = claimed_device(NativePlatform::Android)?;
    let local = format!("tcp:{port}");
    match forward {
        Some((owner, _)) if owner != device => return Err(port_held_by(port, owner, &device)),
        Some((_, ANDROID_LISTENER)) => {}
        Some(_) => {
            adb(&["-s", &device, "forward", &local, ANDROID_LISTENER])?;
        }
        None => {
            adb(&[
                "-s",
                &device,
                "forward",
                "--no-rebind",
                &local,
                ANDROID_LISTENER,
            ])?;
        }
    }
    Ok(device)
}

/// The device id `scripts/qa.mjs` recorded in this worktree's claim for `platform` (the `id` of
/// the first `~/.futo-notes-qa/devices/<platform>-*.json` whose `worktree` is this checkout),
/// read without starting node.
fn recorded_device(platform: NativePlatform) -> Option<String> {
    let dir = PathBuf::from(std::env::var_os("HOME")?).join(".futo-notes-qa/devices");
    let prefix = format!("{}-", platform.name());
    let mut owners: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".json"))
        })
        .collect();
    owners.sort();
    let root = repo_root();
    let owner = owners.iter().find_map(|path| {
        let owner: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        (std::path::Path::new(owner["worktree"].as_str()?) == root).then_some(owner)
    })?;
    owner["id"].as_str().map(str::to_owned)
}

/// This worktree's device for `platform`, from `scripts/qa.mjs device`: adb's serial on
/// Android, the simulator's udid on iOS, which it records in the claim for `recorded_device`.
/// A worktree with none claims its pool device there, as `just qa-claim` does (never one
/// another live worktree owns), and a claimed device that is off is booted; what that did
/// shows on stderr. So a phone command reaches this worktree's device and no other, whatever
/// `$ANDROID_SERIAL` or the booted simulators say.
fn claimed_device(platform: NativePlatform) -> Result<String, String> {
    let output = Command::new("node")
        .arg(repo_root().join("scripts/qa.mjs"))
        .args(["device", platform.name()])
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| format!("could not run node scripts/qa.mjs: {e}"))?;
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    match reply["id"].as_str() {
        Some(id) if output.status.success() => Ok(id.to_string()),
        _ => Err(format!(
            "no {} device for this worktree (scripts/qa.mjs device {}, above)",
            platform.name(),
            platform.name()
        )),
    }
}

/// The local socket PuppetServer.kt listens on inside the device (an Android app gets no launch
/// environment, so it cannot take the worktree's port). It accepts only adbd, which is how
/// `adb forward` connects: no other app on the device can drive this one.
const ANDROID_LISTENER: &str = "localabstract:futo-puppet";

/// The serial and the device end `adb forward --list` forwards host `port` to.
pub(crate) fn forward_of(forwards: &str, port: u16) -> Option<(&str, &str)> {
    let local = format!("tcp:{port}");
    forwards.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let serial = fields.next()?;
        if fields.next()? != local {
            return None;
        }
        Some((serial, fields.next()?))
    })
}

fn port_held_by(port: u16, owner: &str, device: &str) -> String {
    format!(
        "127.0.0.1:{port} is forwarded to {owner}, not {device}, this worktree's: another \
         worktree in the same slot holds the port. Use a free one for this worktree: \
         FUTO_PUPPET_ANDROID_PORT=<port> just puppet …"
    )
}

/// One `adb` command's output.
fn adb(args: &[&str]) -> Result<String, String> {
    let output = Command::new("adb")
        .args(args)
        .output()
        .map_err(|e| format!("could not run adb: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "adb {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
