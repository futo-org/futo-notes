#[derive(Default)]
pub(super) struct EventStream {
    buffer: String,
}

impl EventStream {
    pub(super) fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        self.buffer = self.buffer.replace("\r\n", "\n");
        let mut events = Vec::new();
        while let Some(end) = self.buffer.find("\n\n") {
            let frame = self.buffer[..end].to_owned();
            self.buffer.drain(..end + 2);
            if let Some(event) = frame
                .lines()
                .find_map(|line| line.strip_prefix("event:").map(str::trim))
            {
                events.push(event.to_owned());
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&str]) -> Vec<String> {
        let mut stream = EventStream::default();
        chunks
            .iter()
            .flat_map(|chunk| stream.push(chunk.as_bytes()))
            .collect()
    }

    #[test]
    fn parses_multiple_named_events() {
        assert_eq!(
            events(&["event: ready\ndata: \n\nevent: change\ndata: {}\n\n"]),
            ["ready", "change"]
        );
    }

    #[test]
    fn ignores_comment_heartbeats() {
        assert_eq!(
            events(&[": keep-alive\n\nevent: ping\ndata: \n\n"]),
            ["ping"]
        );
    }

    #[test]
    fn handles_crlf_and_network_chunk_boundaries() {
        assert_eq!(
            events(&["event: chan", "ge\r\ndata: {}\r\n\r\n"]),
            ["change"]
        );
    }

    #[test]
    fn multiline_data_dispatches_one_event() {
        assert_eq!(
            events(&["event: change\ndata: line1\ndata: line2\n\n"]),
            ["change"]
        );
    }
}
