/// Strict JSONL framing per pi's RPC spec: records are delimited by LF (0x0A) only.
/// Unicode line separators (U+2028/U+2029) inside JSON strings must not split records,
/// and an optional trailing CR (from CRLF writers) is stripped from each line.
#[derive(Default)]
pub struct LineFramer {
    buf: Vec<u8>,
}

impl LineFramer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a chunk of bytes; returns every complete line accumulated so far
    /// (LF removed, trailing CR stripped, blank lines skipped).
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0usize;
        for i in 0..self.buf.len() {
            if self.buf[i] != b'\n' {
                continue;
            }
            let mut end = i;
            if end > start && self.buf[end - 1] == b'\r' {
                end -= 1;
            }
            if end > start {
                if let Ok(s) = std::str::from_utf8(&self.buf[start..end]) {
                    if !s.trim().is_empty() {
                        lines.push(s.to_string());
                    }
                }
            }
            start = i + 1;
        }
        self.buf.drain(..start);
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_lf_only() {
        let mut f = LineFramer::new();
        let lines = f.push(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(lines, vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn handles_chunk_split_mid_line() {
        let mut f = LineFramer::new();
        assert!(f.push(b"{\"a\":").is_empty());
        let lines = f.push(b"1}\n");
        assert_eq!(lines, vec!["{\"a\":1}"]);
    }

    #[test]
    fn strips_trailing_cr() {
        let mut f = LineFramer::new();
        let lines = f.push(b"{\"a\":1}\r\n");
        assert_eq!(lines, vec!["{\"a\":1}"]);
    }

    #[test]
    fn unicode_line_separator_does_not_split() {
        let mut f = LineFramer::new();
        // U+2028 inside a JSON string: must stay part of the same record.
        let payload = "{\"t\":\"a\u{2028}b\"}\n".as_bytes().to_vec();
        let lines = f.push(&payload);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains('\u{2028}'));
    }

    #[test]
    fn skips_blank_lines() {
        let mut f = LineFramer::new();
        let lines = f.push(b"\n\r\n{\"a\":1}\n\n");
        assert_eq!(lines, vec!["{\"a\":1}"]);
    }

    #[test]
    fn multibyte_utf8_across_chunks() {
        let mut f = LineFramer::new();
        let s = "{\"t\":\"привет\"}\n".as_bytes().to_vec();
        let (a, b) = s.split_at(9); // split inside a multibyte char
        assert!(f.push(a).is_empty());
        let lines = f.push(b);
        assert_eq!(lines, vec!["{\"t\":\"привет\"}"]);
    }
}
