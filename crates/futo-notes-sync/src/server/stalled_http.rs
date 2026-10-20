use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const EVENT_STREAM_HEADERS: &[u8] =
    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
const SUCCESS_HEADERS: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
Content-Length: 64\r\nConnection: close\r\n\r\n";
const ERROR_HEADERS: &[u8] = b"HTTP/1.1 500 Internal Server Error\r\n\
Content-Type: application/json\r\nConnection: close\r\n\r\n";
const READY_EVENT: &[u8] = b"event: ready\ndata:\n\n";
const WAKE_REQUEST: &[u8] = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";

#[derive(Clone, Copy)]
pub(crate) enum StallPoint {
    ResponseHeaders,
    SuccessfulResponseBody,
    EventStreamBody,
    ErrorBody,
}

impl StallPoint {
    fn headers(self) -> Option<&'static [u8]> {
        match self {
            Self::ResponseHeaders => None,
            Self::SuccessfulResponseBody => Some(SUCCESS_HEADERS),
            Self::EventStreamBody => Some(EVENT_STREAM_HEADERS),
            Self::ErrorBody => Some(ERROR_HEADERS),
        }
    }

    fn body_after_release(self) -> Option<&'static [u8]> {
        match self {
            Self::EventStreamBody => Some(READY_EVENT),
            Self::ResponseHeaders | Self::SuccessfulResponseBody | Self::ErrorBody => None,
        }
    }
}

pub(crate) struct HangingServer {
    pub(crate) base_url: String,
    wake_address: SocketAddr,
    request_received: Receiver<()>,
    release: Option<Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl HangingServer {
    pub(crate) fn new(stall_point: StallPoint) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let wake_address = listener.local_addr().unwrap();
        let base_url = format!("http://{wake_address}");
        let (request_received_tx, request_received) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            serve_until_released(listener, stall_point, request_received_tx, release_rx)
        });
        Self {
            base_url,
            wake_address,
            request_received,
            release: Some(release),
            handle: Some(handle),
        }
    }

    pub(crate) async fn wait_for_request(&self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.request_received.try_recv() {
                Ok(()) => return,
                Err(TryRecvError::Empty) if Instant::now() < deadline => {
                    tokio::task::yield_now().await;
                    std::thread::yield_now();
                }
                Err(TryRecvError::Empty) => panic!("test server did not receive a request"),
                Err(TryRecvError::Disconnected) => {
                    panic!("test server stopped before receiving a request")
                }
            }
        }
    }

    pub(crate) fn release(&mut self) {
        self.release.take();
    }
}

fn serve_until_released(
    listener: TcpListener,
    stall_point: StallPoint,
    request_received: Sender<()>,
    release: Receiver<()>,
) {
    let (mut stream, _) = listener.accept().unwrap();
    read_request_headers(&mut stream);
    write_response_part(&mut stream, stall_point.headers()).unwrap();
    request_received.send(()).unwrap();

    let _ = release.recv();
    let _ = write_response_part(&mut stream, stall_point.body_after_release());
}

fn write_response_part(stream: &mut TcpStream, bytes: Option<&[u8]>) -> std::io::Result<()> {
    let Some(bytes) = bytes else {
        return Ok(());
    };
    stream.write_all(bytes)?;
    stream.flush()
}

fn wake_listener(address: SocketAddr) -> Option<TcpStream> {
    let mut stream = TcpStream::connect(address).ok()?;
    stream.write_all(WAKE_REQUEST).ok()?;
    stream.flush().ok()?;
    Some(stream)
}

impl Drop for HangingServer {
    fn drop(&mut self) {
        self.release();
        let _wake_connection = wake_listener(self.wake_address);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn read_request_headers(stream: &mut TcpStream) {
    let mut request = Vec::new();
    let mut chunk = [0; 1024];
    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0, "request ended before its headers");
        request.extend_from_slice(&chunk[..read]);
    }
}

// Yields until the spawned request task observes its (paused-clock) timeout
// firing and runs to completion; there is no event to await, only progress.
pub(crate) async fn allow_timeout_task_to_finish<T>(task: &tokio::task::JoinHandle<T>) {
    for _ in 0..10 {
        if task.is_finished() {
            return;
        }
        tokio::task::yield_now().await;
    }
}

// Yields long enough for reqwest's connection task to send the request and
// park in a pending read, so a later clock advance hits the armed timeout.
pub(crate) async fn allow_network_task_to_settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}
