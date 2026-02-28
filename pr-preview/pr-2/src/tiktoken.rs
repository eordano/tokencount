/// OpenAI tiktoken-compatible tokenizer for o200k_base encoding.
///
/// Uses a compile-time frozen hash table (built by build.rs) for rank lookup.
/// The regex pattern for o200k_base is compiled from a constant.
///
/// Tokenization: regex pre-tokenize → byte-level BPE using rank lookup.
use crate::frozen;

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

    fn bpe_count(&self, piece: &[u8]) -> usize {
        if piece.is_empty() {
            return 0;
        }
        if piece.len() == 1 {
            return 1;
        }

        // Track byte ranges instead of Vec<Vec<u8>> to avoid allocations.
        // Each part is a (start, end) into `piece`.
        let mut parts: Vec<(usize, usize)> = (0..piece.len()).map(|i| (i, i + 1)).collect();
        let mut merge_buf = Vec::with_capacity(64);

        loop {
            if parts.len() <= 1 {
                break;
            }

            let mut best_rank = u32::MAX;
            let mut best_idx = 0;

            for i in 0..parts.len() - 1 {
                merge_buf.clear();
                merge_buf.extend_from_slice(&piece[parts[i].0..parts[i].1]);
                merge_buf.extend_from_slice(&piece[parts[i + 1].0..parts[i + 1].1]);
                if let Some(rank) = frozen::frozen_map_get(self.data, &merge_buf) {
                    if rank < best_rank {
                        best_rank = rank;
                        best_idx = i;
                    }
                }
            }

            if best_rank == u32::MAX {
                break;
            }

            parts[best_idx].1 = parts[best_idx + 1].1;
            parts.remove(best_idx + 1);
        }

        parts.len()
    }
}
