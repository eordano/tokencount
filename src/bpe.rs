use unicode_normalization::UnicodeNormalization;

use crate::byte_level;
use crate::frozen;

enum Normalizer {
    None,
    Replace { pattern: String, content: String },
    Prepend(String),
    Nfc,
    Sequence(Vec<Normalizer>),
}

fn apply_normalizer(norm: &Normalizer, text: &str) -> String {
    match norm {
        Normalizer::None => text.to_string(),
        Normalizer::Replace { pattern, content } => text.replace(pattern.as_str(), content.as_str()),
        Normalizer::Prepend(prefix) => format!("{}{}", prefix, text),
        Normalizer::Nfc => text.nfc().collect(),
        Normalizer::Sequence(norms) => {
            let mut s = text.to_string();
            for n in norms {
                s = apply_normalizer(n, &s);
            }
            s
        }
    }
}

struct SplitPattern {
    regex: fancy_regex::Regex,
}

enum PreTokenizer {
    None,
    Sequence(Vec<PreTokenizerStep>),
}

enum PreTokenizerStep {
    Split(SplitPattern),
    ByteLevel { table: Box<[char; 256]> },
}

fn apply_pre_tokenizer(pt: &PreTokenizer, text: &str) -> Vec<String> {
    match pt {
        PreTokenizer::None => {
            vec![text.to_string()]
        }
        PreTokenizer::Sequence(steps) => {
            let mut chunks = vec![text.to_string()];
            for step in steps {
                let mut next_chunks = Vec::new();
                for chunk in &chunks {
                    match step {
                        PreTokenizerStep::Split(sp) => {
                            next_chunks.extend(split_isolated(&sp.regex, chunk));
                        }
                        PreTokenizerStep::ByteLevel { table } => {
                            for c in &chunks {
                                next_chunks.push(byte_level::encode_bytes(
                                    c.as_bytes(),
                                    table,
                                ));
                            }
                            break;
                        }
                    }
                }
                chunks = next_chunks;
            }
            chunks
        }
    }
}

fn split_isolated(regex: &fancy_regex::Regex, text: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut last_end = 0;

    for m in regex.find_iter(text) {
        let m = match m {
            Ok(m) => m,
            Err(_) => continue,
        };
        if m.start() > last_end {
            result.push(text[last_end..m.start()].to_string());
        }
        result.push(m.as_str().to_string());
        last_end = m.end();
    }
    if last_end < text.len() {
        result.push(text[last_end..].to_string());
    }
    result
}

const NORM_NONE: u8 = 0;
const NORM_REPLACE: u8 = 1;
const NORM_PREPEND: u8 = 2;
const NORM_NFC: u8 = 3;
const NORM_SEQUENCE: u8 = 4;

const STEP_SPLIT: u8 = 1;
const STEP_BYTE_LEVEL: u8 = 2;

pub struct HfTokenizer {
    data: &'static [u8],
    byte_fallback: bool,
    post_add: usize,
    normalizer: Normalizer,
    pre_tokenizer: PreTokenizer,
    vocab_off: usize,
    vocab_count: usize,
    merges_off: usize,
    merge_left_off: usize,
    merge_right_off: usize,
}

impl HfTokenizer {
    pub fn from_frozen(data: &'static [u8]) -> Result<Self, String> {
        let mut off = 0;
        let byte_fallback = data[off] != 0;
        off += 1;
        let post_add = frozen::read_u32(data, off) as usize;
        off += 4;
        let (normalizer, norm_len) = deserialize_normalizer(data, off)?;
        off += norm_len;
        let (pre_tokenizer, pt_len) = deserialize_pre_tokenizer(data, off)?;
        off += pt_len;
        let vocab_count = frozen::read_u32(data, off) as usize;
        off += 4;
        let vocab_off = off;
        off += vocab_count * 4;
        let merges_off = off;
        off += frozen::frozen_map_byte_len(&data[off..]);
        let merge_left_off = off;
        off += frozen::frozen_set_byte_len(&data[off..]);
        let merge_right_off = off;

        Ok(HfTokenizer {
            data,
            byte_fallback,
            post_add,
            normalizer,
            pre_tokenizer,
            vocab_off,
            vocab_count,
            merges_off,
            merge_left_off,
            merge_right_off,
        })
    }

    pub fn count_tokens(&self, text: &str) -> usize {
        if text.is_empty() { return 0; }
        let normalized = apply_normalizer(&self.normalizer, text);
        let chunks = apply_pre_tokenizer(&self.pre_tokenizer, &normalized);
        let mut total = self.post_add;
        for chunk in &chunks {
            if !chunk.is_empty() { total += self.bpe_count(chunk); }
        }
        total
    }

    fn bpe_count(&self, chunk: &str) -> usize {
        let initial: Vec<String> = if self.byte_fallback {
            self.initial_tokens(chunk)
        } else {
            chunk.chars().map(|c| c.to_string()).collect()
        };
        let n = initial.len();
        if n <= 1 { return n; }
        if n > 512 {
            return self.bpe_count_chunked(&initial);
        }
        self.bpe_merge_count(&initial)
    }

    fn initial_tokens(&self, chunk: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        for ch in chunk.chars() {
            if self.vocab_contains_char(ch) {
                tokens.push(ch.to_string());
            } else {
                let mut buf = [0u8; 4];
                let bytes = ch.encode_utf8(&mut buf).as_bytes();
                for &b in bytes {
                    tokens.push(format!("<0x{:02X}>", b));
                }
            }
        }
        tokens
    }

    fn bpe_count_chunked(&self, tokens: &[String]) -> usize {
        let merge_left = &self.data[self.merge_left_off..];
        let merge_right = &self.data[self.merge_right_off..];
        let n = tokens.len();
        let mut total = 0;
        let mut start = 0;
        let target_chunk = 256;
        let mut i = target_chunk.min(n.saturating_sub(1));
        while i < n {
            let scan_start = i;
            let scan_end = n.min(i + target_chunk);
            let mut found = false;
            for j in scan_start..scan_end {
                if j == 0 { continue; }
                if !frozen::frozen_set_contains(merge_left, tokens[j - 1].as_bytes())
                    || !frozen::frozen_set_contains(merge_right, tokens[j].as_bytes())
                {
                    total += self.bpe_merge_count(&tokens[start..j]);
                    start = j;
                    i = j + target_chunk;
                    found = true;
                    break;
                }
            }
            if !found { break; }
        }
        if start < n {
            total += self.bpe_merge_count(&tokens[start..]);
        }
        total
    }

    fn bpe_merge_count(&self, initial: &[String]) -> usize {
        if initial.is_empty() { return 0; }
        let n = initial.len();
        if n == 1 { return 1; }

        let merges_table = &self.data[self.merges_off..];

        // Lay out all initial tokens contiguously in a byte buffer so that
        // adjacent tokens in the linked list are adjacent in memory.  Merging
        // two neighbors then becomes a zero-copy range extension — no format!
        // allocation — matching the pattern used in tiktoken.rs.
        let total_bytes: usize = initial.iter().map(|s| s.len()).sum();
        let mut buf = Vec::with_capacity(total_bytes);
        let mut parts: Vec<(usize, usize)> = Vec::with_capacity(n);
        for s in initial {
            let start = buf.len();
            buf.extend_from_slice(s.as_bytes());
            parts.push((start, buf.len()));
        }

        let mut next: Vec<usize> = (1..=n).collect();
        let mut prev: Vec<usize> = Vec::with_capacity(n);
        prev.push(usize::MAX);
        for i in 1..n { prev.push(i - 1); }
        let mut alive = vec![true; n];
        let mut gen: Vec<u32> = vec![0; n];
        let mut heap = std::collections::BinaryHeap::new();

        let pair_rank = |i: usize, parts: &[(usize, usize)], next: &[usize]| -> Option<u64> {
            let j = next[i];
            if j >= n { return None; }
            frozen::frozen_map_get_pair(
                merges_table,
                &buf[parts[i].0..parts[i].1],
                &buf[parts[j].0..parts[j].1],
            ).map(|r| r as u64)
        };

        for i in 0..n - 1 {
            if let Some(rank) = pair_rank(i, &parts, &next) {
                heap.push(std::cmp::Reverse((rank, i, 0u32)));
            }
        }

        let mut count = n;

        while let Some(std::cmp::Reverse((rank, i, g))) = heap.pop() {
            if !alive[i] || gen[i] != g { continue; }
            let j = next[i];
            if j >= n || !alive[j] { continue; }

            let current_rank = match frozen::frozen_map_get_pair(
                merges_table,
                &buf[parts[i].0..parts[i].1],
                &buf[parts[j].0..parts[j].1],
            ) {
                Some(r) => r as u64,
                None => continue,
            };
            if current_rank != rank { continue; }

            parts[i].1 = parts[j].1;
            gen[i] += 1;

            alive[j] = false;
            let k = next[j];
            next[i] = k;
            if k < n { prev[k] = i; }
            count -= 1;

            if prev[i] != usize::MAX && alive[prev[i]] {
                let p = prev[i];
                if let Some(r) = pair_rank(p, &parts, &next) {
                    heap.push(std::cmp::Reverse((r, p, gen[p])));
                }
            }
            if next[i] < n {
                if let Some(r) = pair_rank(i, &parts, &next) {
                    heap.push(std::cmp::Reverse((r, i, gen[i])));
                }
            }
        }

        count
    }

    fn vocab_contains_char(&self, ch: char) -> bool {
        if self.vocab_count == 0 {
            return false;
        }
        let target = ch as u32;
        let base = self.vocab_off;
        let mut lo = 0usize;
        let mut hi = self.vocab_count;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let cp = frozen::read_u32(self.data, base + mid * 4);
            if cp == target {
                return true;
            } else if cp < target {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        false
    }
}

fn deserialize_normalizer(data: &[u8], off: usize) -> Result<(Normalizer, usize), String> {
    let tag = data[off];
    let mut pos = off + 1;
    match tag {
        NORM_NONE => Ok((Normalizer::None, 1)),
        NORM_REPLACE => {
            let (pattern, len1) = read_length_prefixed_str(data, pos)?;
            pos += len1;
            let (content, len2) = read_length_prefixed_str(data, pos)?;
            pos += len2;
            Ok((Normalizer::Replace { pattern, content }, pos - off))
        }
        NORM_PREPEND => {
            let (prepend, len) = read_length_prefixed_str(data, pos)?;
            pos += len;
            Ok((Normalizer::Prepend(prepend), pos - off))
        }
        NORM_NFC => Ok((Normalizer::Nfc, 1)),
        NORM_SEQUENCE => {
            let count = frozen::read_u32(data, pos) as usize;
            pos += 4;
            let mut norms = Vec::with_capacity(count);
            for _ in 0..count {
                let (n, len) = deserialize_normalizer(data, pos)?;
                pos += len;
                norms.push(n);
            }
            if norms.is_empty() {
                Ok((Normalizer::None, pos - off))
            } else {
                Ok((Normalizer::Sequence(norms), pos - off))
            }
        }
        _ => Err(format!("unknown normalizer tag: {}", tag)),
    }
}

fn deserialize_pre_tokenizer(data: &[u8], off: usize) -> Result<(PreTokenizer, usize), String> {
    let mut pos = off;
    let step_count = frozen::read_u32(data, pos) as usize;
    pos += 4;

    if step_count == 0 {
        return Ok((PreTokenizer::None, pos - off));
    }

    let mut steps = Vec::with_capacity(step_count);
    for _ in 0..step_count {
        let step_tag = data[pos];
        pos += 1;
        match step_tag {
            STEP_SPLIT => {
                let (pattern, len) = read_length_prefixed_str(data, pos)?;
                pos += len;
                let regex = fancy_regex::Regex::new(&pattern)
                    .map_err(|e| format!("invalid pre-tokenizer regex: {e}"))?;
                steps.push(PreTokenizerStep::Split(SplitPattern { regex }));
            }
            STEP_BYTE_LEVEL => {
                steps.push(PreTokenizerStep::ByteLevel {
                    table: Box::new(byte_level::byte_to_char_table()),
                });
            }
            _ => return Err(format!("unknown pre-tokenizer step tag: {}", step_tag)),
        }
    }

    Ok((PreTokenizer::Sequence(steps), pos - off))
}

fn read_length_prefixed_str(data: &[u8], off: usize) -> Result<(String, usize), String> {
    let len = frozen::read_u32(data, off) as usize;
    let s = std::str::from_utf8(&data[off + 4..off + 4 + len])
        .map_err(|e| format!("invalid UTF-8 in frozen blob: {e}"))?
        .to_string();
    Ok((s, 4 + len))
}
