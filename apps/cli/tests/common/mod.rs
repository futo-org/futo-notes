//! Process-level harness for the `futo-notes` binary.
//!
//! Every test gets its own HOME and XDG config, cache, and state directories,
//! so no test can read or write the developer's real CLI settings or notes.
//! Each process starts with no controlling terminal and no editor variables,
//! so nothing ever prompts on, or opens an editor in, the terminal `cargo test`
//! runs in.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

pub const BIN: &str = env!("CARGO_BIN_EXE_futo-notes");
pub const SERVER_PASSWORD: &str = "testing123";

pub struct Env {
    pub dir: PathBuf,
}

impl Env {
    pub fn new(name: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "futo-cli-test-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("tmp")).unwrap();
        Self { dir }
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.dir.join(relative)
    }

    pub fn vault(&self) -> PathBuf {
        self.dir.join("vault")
    }

    pub fn note(&self, id: &str) -> PathBuf {
        self.vault().join(format!("{id}.md"))
    }

    /// Where a debug build keeps its configuration under this test's HOME.
    pub fn config_file(&self) -> PathBuf {
        self.dir.join("xdg-config/futo-notes-cli-dev/config.json")
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(BIN);
        command
            .env("HOME", &self.dir)
            .env("XDG_CONFIG_HOME", self.dir.join("xdg-config"))
            .env("XDG_CACHE_HOME", self.dir.join("xdg-cache"))
            .env("XDG_STATE_HOME", self.dir.join("xdg-state"))
            .env("TMPDIR", self.dir.join("tmp"))
            .env_remove("VISUAL")
            .env_remove("EDITOR")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        detach_from_terminal(&mut command);
        command
    }

    pub fn run(&self, args: &[&str]) -> Run {
        Run::timed(self.command().args(args))
    }

    pub fn run_stdin(&self, args: &[&str], stdin: &[u8]) -> Run {
        use std::io::Write;
        let started = Instant::now();
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin).unwrap();
        Run::from_output(child.wait_with_output().unwrap(), started)
    }

    /// `init` the vault and return its canonical path.
    pub fn init(&self) -> PathBuf {
        self.run(&["init", self.vault().to_str().unwrap()])
            .assert_ok();
        std::fs::canonicalize(self.vault()).unwrap()
    }

    /// A password command that prints `password` from a file only this test
    /// knows about, so the password itself never appears in an argument.
    pub fn password_command(&self, password: &str) -> String {
        let file = self.dir.join("password.txt");
        std::fs::write(&file, format!("{password}\n")).unwrap();
        format!("cat '{}'", file.display())
    }

    pub fn login(&self, server: &Server) -> Run {
        let command = self.password_command(SERVER_PASSWORD);
        self.run(&[
            "--json",
            "auth",
            "login",
            "--server",
            &server.url,
            "--password-command",
            &command,
        ])
    }

    pub fn ids(&self) -> Vec<String> {
        let mut ids = self
            .run(&["list"])
            .assert_ok()
            .stdout
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        make_writable(&self.dir);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn make_writable(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(entries) = std::fs::read_dir(dir) {
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                make_writable(&entry.path());
            }
        }
    }
}

/// Starts the CLI in a new session with no controlling terminal.
pub fn detach_from_terminal(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setsid is async-signal-safe and touches no shared state.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

pub struct Run {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    pub elapsed: Duration,
}

impl Run {
    pub fn timed(command: &mut Command) -> Self {
        let started = Instant::now();
        Self::from_output(command.output().unwrap(), started)
    }

    fn from_output(output: Output, started: Instant) -> Self {
        Self {
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            elapsed: started.elapsed(),
        }
    }

    pub fn assert_ok(&self) -> &Self {
        self.assert_status(0)
    }

    pub fn assert_status(&self, status: i32) -> &Self {
        assert_eq!(
            self.status, status,
            "stdout: {}\nstderr: {}",
            self.stdout, self.stderr
        );
        self
    }

    /// The single JSON object a `--json` command prints, and nothing else.
    pub fn json(&self) -> Value {
        let lines = self.stdout.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 1, "expected one JSON line: {:?}", self.stdout);
        let value: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["ok"], self.status == 0, "{value}");
        value
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap().to_owned()
    }

    pub fn line(&self) -> &str {
        self.stdout.trim_end_matches('\n')
    }
}

/// A fresh pinned sync server in password mode, private to one test: its own
/// port, database, and blob directory. Stopped by its own PID when dropped.
pub struct Server {
    child: std::process::Child,
    pub url: String,
    _data: Env,
}

impl Server {
    pub fn start() -> Self {
        let binary = std::env::var("FUTO_NOTES_E2EE_SERVER_BIN").expect(
            "FUTO_NOTES_E2EE_SERVER_BIN must name the pinned futo-notes-server; run `just test-cli`",
        );
        let data = Env::new("server");
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let blobs = data.path("blobs");
        std::fs::create_dir_all(&blobs).unwrap();
        let child = Command::new(binary)
            .current_dir(&data.dir)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &data.dir)
            .env("PORT", port.to_string())
            .env("BLOB_DIR", &blobs)
            .env(
                "DATABASE_URL",
                format!("sqlite:{}", data.path("notes.db").display()),
            )
            .env("AUTH_MODE", "password")
            .env("FUTO_NOTES_PASSWORD", SERVER_PASSWORD)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the sync server");
        let server = Self {
            child,
            url: format!("http://127.0.0.1:{port}"),
            _data: data,
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if health_ok(port) {
                return server;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the sync server did not become healthy on port {port}");
    }
}

fn health_ok(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200")
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
