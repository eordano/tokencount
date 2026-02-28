/// OpenAI tiktoken-compatible tokenizer for o200k_base encoding.
///
/// Uses a compile-time frozen hash table (built by build.rs) for rank lookup.
/// The regex pattern for o200k_base is compiled from a constant.
///
/// Tokenization: regex pre-tokenize → byte-level BPE using rank lookup.
/// BPE merges use a priority queue + linked-list skip structure for O(n log n).
use crate::frozen;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// The pre-tokenization regex for o200k_base (from tiktoken's published data).
const O200K_PAT: &str = concat!(
    r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+",
    r"('s|'S|'t|'T|'re|'rE|'Re|'RE|'ve|'vE|'Ve|'VE|'m|'M|'ll|'lL|'Ll|'LL|'d|'D)?",
    r"|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*",
    r"('s|'S|'t|'T|'re|'rE|'Re|'RE|'ve|'vE|'Ve|'VE|'m|'M|'ll|'lL|'Ll|'LL|'d|'D)?",
    r"|\p{N}{1,3}",
    r"| ?[^\s\p{L}\p{N}]+[\r\n/]*",
    r"|\s*[\r\n]+",
    r"|\s+(?!\S)",
    r"|\s+",
);

pub struct TiktokenTokenizer {
    regex: fancy_regex::Regex,
    data: &'static [u8],
}

impl TiktokenTokenizer {
    pub fn new(data: &'static [u8]) -> Self {
        let regex = fancy_regex::Regex::new(O200K_PAT).expect("invalid o200k regex");
        TiktokenTokenizer { regex, data }
    }

    pub fn count_tokens(&self, text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }
        let mut total = 0;
        for m in self.regex.find_iter(text) {
            let m = match m {
                Ok(m) => m,
                Err(_) => continue,
            };
            total += self.bpe_count(m.as_str().as_bytes());
        }
        total
    }

    /// Byte-level BPE merge count using a priority queue + linked-list skip
    /// structure.  O(n log n) instead of the naive O(n²) linear-scan approach.
    fn bpe_count(&self, piece: &[u8]) -> usize {
        if piece.is_empty() {
            return 0;
        }
        let n = piece.len();
        if n == 1 {
            return 1;
        }

        // Each part is a [start, end) byte range into `piece`.
        let mut parts: Vec<(usize, usize)> = (0..n).map(|i| (i, i + 1)).collect();

        // Linked list for O(1) neighbor traversal after merges.
        let mut next: Vec<usize> = (1..=n).collect();
        let mut prev: Vec<usize> = (0..n).map(|i| if i == 0 { usize::MAX } else { i - 1 }).collect();
        let mut alive = vec![true; n];

        // Generation counters to cheaply invalidate stale heap entries.
        let mut gen: Vec<u32> = vec![0; n];

        // Min-heap of (rank, part_index, generation_at_push).
        let mut heap: BinaryHeap<Reverse<(u32, usize, u32)>> = BinaryHeap::with_capacity(n);

        // Helper: rank of merging parts[i] with its right neighbor.
        let pair_rank = |i: usize, parts: &[(usize, usize)], next: &[usize]| -> Option<u32> {
            let j = next[i];
            if j >= n { return None; }
            frozen::frozen_map_get_concat(
                self.data,
                &piece[parts[i].0..parts[i].1],
                &piece[parts[j].0..parts[j].1],
            )
        };

        // Seed the heap with all adjacent pairs.
        for i in 0..n - 1 {
            if let Some(rank) = pair_rank(i, &parts, &next) {
                heap.push(Reverse((rank, i, 0)));
            }
        }

        let mut count = n;

        while let Some(Reverse((rank, i, g))) = heap.pop() {
            if !alive[i] || gen[i] != g { continue; }
            let j = next[i];
            if j >= n || !alive[j] { continue; }

            // Verify the rank is still current (parts[i] may have grown).
            let current_rank = match frozen::frozen_map_get_concat(
                self.data,
                &piece[parts[i].0..parts[i].1],
                &piece[parts[j].0..parts[j].1],
            ) {
                Some(r) => r,
                None => continue,
            };
            if current_rank != rank { continue; }

            // Merge: extend i to cover j's byte range, remove j from the list.
            parts[i].1 = parts[j].1;
            gen[i] += 1;
            alive[j] = false;
            let k = next[j];
            next[i] = k;
            if k < n { prev[k] = i; }
            count -= 1;

            // Re-evaluate the pair (prev[i], i) — left neighbor changed.
            if prev[i] != usize::MAX && alive[prev[i]] {
                let p = prev[i];
                if let Some(r) = pair_rank(p, &parts, &next) {
                    heap.push(Reverse((r, p, gen[p])));
                }
            }
            // Re-evaluate the pair (i, next[i]) — i's content changed.
            if next[i] < n {
                if let Some(r) = pair_rank(i, &parts, &next) {
                    heap.push(Reverse((r, i, gen[i])));
                }
            }
        }

        count
    }
}
