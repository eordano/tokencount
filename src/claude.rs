/// Claude tokenizer — double-array trie, pre-built at compile time by build.rs.
///
/// O(1) per byte: transition t = base[s] + byte, valid if (check[t] & MASK) == s.
/// Terminal flag packed into bit 31 of check.
const TRIE_BIN: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/trie.bin"));

const TERM_BIT: u32 = 0x8000_0000;
const IDX_MASK: u32 = 0x7FFF_FFFF;

pub struct DATrie {
    root: u32,
    base: &'static [u8],
    check: &'static [u8],
    array_size: usize,
}

impl DATrie {
    pub fn new() -> Self {
        let array_size = read_u32(TRIE_BIN, 0) as usize;
        let root = read_u32(TRIE_BIN, 4);
        let base_start = 8;
        let check_start = base_start + array_size * 4;
        DATrie {
            root,
            base: &TRIE_BIN[base_start..check_start],
            check: &TRIE_BIN[check_start..check_start + array_size * 4],
            array_size,
        }
    }

    #[inline(always)]
    fn transition(&self, s: u32, byte: u8) -> Option<(u32, bool)> {
        let off = s as usize * 4;
        if unlikely(off + 4 > self.base.len()) {
            return None;
        }
        let t = read_u32(self.base, off) as usize + byte as usize;
        if t >= self.array_size {
            return None;
        }
        let c = read_u32(self.check, t * 4);
        if c == u32::MAX || (c & IDX_MASK) != s {
            return None;
        }
        Some((t as u32, c & TERM_BIT != 0))
    }

    #[inline]
    fn match_len(&self, bytes: &[u8], pos: usize) -> usize {
        let (first, first_term) = match self.transition(self.root, bytes[pos]) {
            Some(v) => v,
            None => return 1,
        };
        let mut best = if first_term { 1 } else { 0 };
        let mut cur = first;
        for (offset, &b) in bytes[pos + 1..].iter().enumerate() {
            match self.transition(cur, b) {
                Some((next, is_term)) => {
                    cur = next;
                    if is_term {
                        best = offset + 2; // offset+2 == (i - pos + 1) where i = pos+1+offset
                    }
                }
                None => break,
            }
        }
        if best == 0 { 1 } else { best }
    }

    pub fn count_tokens(&self, text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }
        let bytes = text.as_bytes();
        let mut count = 0;
        let mut pos = 0;
        while pos < bytes.len() {
            pos += self.match_len(bytes, pos);
            count += 1;
        }
        count
    }
}

#[cold]
#[inline(never)]
fn unlikely(b: bool) -> bool {
    b
}

#[inline(always)]
fn read_u32(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}
