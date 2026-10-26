use super::*;

#[cfg(windows)]
#[test]
fn windows_names_the_process_listening_on_a_port() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (pid, process) = listener_process(port).expect("this test's own listener");
    assert_eq!(pid, std::process::id());
    let exe = std::env::current_exe().unwrap();
    assert!(process.ends_with(&*exe.to_string_lossy()), "{process}");
    assert!(listener_process(port.wrapping_add(1)).is_none_or(|(other, _)| other != pid));
}

pub(super) fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

mod arguments;
mod batch;
mod file;
mod gesture_arguments;
mod gestures;
mod look_and_relaunch;
mod native;
mod receipts;
mod refusals;
mod render_reads;
mod shortcuts;
mod transports;
