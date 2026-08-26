use std::collections::VecDeque;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

const TERM_BIT: u32 = 0x8000_0000;

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

/// FNV-1a hash, forced to odd (never zero).
///
/// The frozen hash tables use `slot_hash == 0` as the empty-slot sentinel
/// for linear-probe termination. `h | 1` guarantees a populated slot can
/// never be mistaken for an empty one.
fn fnv_hash(data: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h | 1 // never zero -- 0 is the empty-slot sentinel
}

fn main() {
    println!("cargo:rerun-if-changed=data/claude-vocab.json");
    println!("cargo:rerun-if-env-changed=TOKEN_COUNT_MODELS");
    println!("cargo:rerun-if-env-changed=TOKENCOUNT_ALLOW_PARTIAL");

    let out_dir = env::var("OUT_DIR").unwrap();
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();

    build_claude_trie(&manifest_dir, &out_dir);
    build_frozen_models(&manifest_dir, &out_dir);
}

fn build_claude_trie(manifest_dir: &str, out_dir: &str) {
    let vocab_path = Path::new(manifest_dir).join("data/claude-vocab.json");
    let json_str = fs::read_to_string(&vocab_path).expect("data/claude-vocab.json not found");
    let vocab: Vec<String> =
        serde_json::from_str(&json_str).expect("Failed to parse vocabulary JSON");

    let mut node_children: Vec<Vec<(u8, u32)>> = vec![vec![]];
    let mut node_terminal: Vec<bool> = vec![false];

    for token in &vocab {
        let mut cur: u32 = 0;
        for &byte in token.as_bytes() {
            let existing = node_children[cur as usize]
                .iter()
                .find(|(k, _)| *k == byte);
            cur = if let Some(&(_, idx)) = existing {
                idx
            } else {
                let idx = node_children.len() as u32;
                node_children.push(vec![]);
                node_terminal.push(false);
                node_children[cur as usize].push((byte, idx));
                idx
            };
        }
        node_terminal[cur as usize] = true;
    }

    for children in &mut node_children {
        children.sort_by_key(|(k, _)| *k);
    }

    let num_nodes = node_children.len();
    let root_da = 0usize;
    let initial_size = num_nodes + 512;
    let mut base = vec![0u32; initial_size];
    let mut check = vec![u32::MAX; initial_size];
    let mut occupied = vec![false; initial_size];

    let mut da_pos = vec![0u32; num_nodes];
    da_pos[0] = root_da as u32;
    occupied[root_da] = true;

    let mut queue = VecDeque::new();
    queue.push_back(0usize);

    while let Some(trie_node) = queue.pop_front() {
        let s = da_pos[trie_node] as usize;
        let ch = &node_children[trie_node];

        if ch.is_empty() {
            continue;
        }

        let keys: Vec<u8> = ch.iter().map(|&(k, _)| k).collect();
        let b = find_base(&keys, &occupied);

        let max_pos = b + 256;
        if max_pos >= base.len() {
            let new_size = max_pos + 512;
            base.resize(new_size, 0);
            check.resize(new_size, u32::MAX);
            occupied.resize(new_size, false);
        }

        base[s] = b as u32;

        for &(key, child_trie_idx) in ch {
            let t = b + key as usize;
            let term = if node_terminal[child_trie_idx as usize] {
                TERM_BIT
            } else {
                0
            };
            check[t] = s as u32 | term;
            occupied[t] = true;
            da_pos[child_trie_idx as usize] = t as u32;
            queue.push_back(child_trie_idx as usize);
        }
    }

    let actual_size = occupied
        .iter()
        .rposition(|&o| o)
        .map_or(0, |i| i + 1);
    base.truncate(actual_size);
    check.truncate(actual_size);

    let mut output = Vec::with_capacity(8 + actual_size * 8);
    output.extend_from_slice(&(actual_size as u32).to_le_bytes());
    output.extend_from_slice(&(root_da as u32).to_le_bytes());
    for &b in &base {
        output.extend_from_slice(&b.to_le_bytes());
    }
    for &c in &check {
        output.extend_from_slice(&c.to_le_bytes());
    }

    let dest = Path::new(out_dir).join("trie.bin");
    fs::write(&dest, &output).expect("Failed to write trie.bin");
}

fn find_base(keys: &[u8], occupied: &[bool]) -> usize {
    let len = occupied.len();
    let first_key = keys[0] as usize;
    let mut b = 0usize;
    'outer: loop {
        let fpos = b + first_key;
        if fpos < len && occupied[fpos] {
            b += 1;
            continue;
        }
        for &k in keys.iter().skip(1) {
            let pos = b + k as usize;
            if pos < len && occupied[pos] {
                b += 1;
                continue 'outer;
            }
        }
        return b;
    }
}

/// OpenAI's published `o200k_base` rank table -- the source of the `openai`
/// tokenizer. Not redistributed here; the build reads it from
/// `$TOKEN_COUNT_MODELS/o200k_base.tiktoken`.
const O200K_URL: &str = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken";

/// HuggingFace tokenizer sources as `(embedded name, upstream repo)`.
///
/// The embedded name is both the Rust const in `embedded_models.rs` and the
/// subdirectory the build looks in: `$TOKEN_COUNT_MODELS/<name>/tokenizer.json`.
/// Must stay in sync with `repoToDir` in flake.nix, which fetches each repo at
/// a pinned hash and points `TOKEN_COUNT_MODELS` at the assembled directory.
const HF_MODELS: &[(&str, &str)] = &[
    ("gemini", "Xenova/gemma-2-tokenizer"),
    ("deepseek", "deepseek-ai/DeepSeek-V3"),
    ("qwen", "Qwen/Qwen3-0.6B"),
    ("llama", "Xenova/llama4-tokenizer"),
    ("mistral", "mistralai/Mistral-Nemo-Instruct-2407"),
    ("grok", "Xenova/grok-1-tokenizer"),
    ("minimax", "MiniMaxAI/MiniMax-Text-01"),
];

/// A tokenizer table the build wanted but could not find.
struct Missing {
    /// Path relative to `$TOKEN_COUNT_MODELS`.
    rel: String,
    /// Where to obtain it.
    url: String,
}

/// Whether the caller explicitly asked for a degraded, Claude-only binary.
///
/// Without this, a build with no model data is a hard error: silently shipping
/// a binary that advertises 9 tokenizers and supports 1 is worse than not
/// building at all.
fn allow_partial() -> bool {
    match env::var("TOKENCOUNT_ALLOW_PARTIAL") {
        Ok(v) => {
            let v = v.trim();
            !v.is_empty() && !v.eq_ignore_ascii_case("0") && !v.eq_ignore_ascii_case("false")
        }
        Err(_) => false,
    }
}

/// A `concat!(env!("OUT_DIR"), "/<name>")` expression for the generated source.
///
/// The generated file is `include!`d into the crate, so an interpolated
/// `OUT_DIR` would be re-parsed by rustc as a Rust string literal: on Windows
/// the path is `D:\a\tokencount\...`, and `\a` / `\b` are unknown escapes
/// while `\t` / `\r` are valid ones that silently corrupt the path. Letting
/// `env!` supply the directory at compile time sidesteps escaping entirely,
/// and matches how `src/claude.rs` reaches `trie.bin`.
fn out_dir_literal(file_name: &str) -> String {
    format!("concat!(env!(\"OUT_DIR\"), \"/{}\")", file_name)
}

fn build_frozen_models(manifest_dir: &str, out_dir: &str) {
    let models_dir = env::var("TOKEN_COUNT_MODELS")
        .ok()
        .filter(|d| !d.trim().is_empty());

    let out = Path::new(out_dir);
    let mut codegen = String::new();
    let mut missing: Vec<Missing> = Vec::new();
    let mut embedded: Vec<&str> = vec!["claude"];

    // A relative TOKEN_COUNT_MODELS is resolved against the crate root, not
    // against whatever directory cargo happened to run the build script in.
    let models_path = models_dir.as_deref().map(|d| {
        let p = Path::new(d);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            Path::new(manifest_dir).join(p)
        }
    });
    let models_path = models_path.as_deref();

    // Tiktoken (OpenAI o200k_base)
    let tiktoken_path = models_path.map(|d| d.join("o200k_base.tiktoken"));
    match tiktoken_path.filter(|p| p.exists()) {
        Some(path) => {
            println!("cargo:rerun-if-changed={}", path.display());
            let blob = build_tiktoken_frozen(&path);
            let dest = out.join("o200k_frozen.bin");
            fs::write(&dest, &blob).expect("Failed to write o200k_frozen.bin");
            codegen.push_str(&format!(
                "pub const O200K: Option<&[u8]> = Some(include_bytes!({}));\n",
                out_dir_literal("o200k_frozen.bin")
            ));
            embedded.push("openai");
        }
        None => {
            codegen.push_str("pub const O200K: Option<&[u8]> = None;\n");
            missing.push(Missing {
                rel: "o200k_base.tiktoken".to_string(),
                url: O200K_URL.to_string(),
            });
        }
    }

    // HF BPE models
    for &(model, repo) in HF_MODELS {
        let const_name = model.to_uppercase();
        let tokenizer_path = models_path.map(|d| d.join(model).join("tokenizer.json"));
        match tokenizer_path.filter(|p| p.exists()) {
            Some(path) => {
                println!("cargo:rerun-if-changed={}", path.display());
                let blob = build_hf_frozen(&path);
                let filename = format!("{}_frozen.bin", model);
                let dest = out.join(&filename);
                fs::write(&dest, &blob)
                    .unwrap_or_else(|e| panic!("Failed to write {}: {}", filename, e));
                codegen.push_str(&format!(
                    "pub const {}: Option<&[u8]> = Some(include_bytes!({}));\n",
                    const_name,
                    out_dir_literal(&filename)
                ));
                embedded.push(model);
            }
            None => {
                codegen.push_str(&format!("pub const {}: Option<&[u8]> = None;\n", const_name));
                missing.push(Missing {
                    rel: format!("{}/tokenizer.json", model),
                    url: format!("https://huggingface.co/{}/resolve/main/tokenizer.json", repo),
                });
            }
        }
    }

    if !missing.is_empty() {
        if !allow_partial() {
            panic!("{}", missing_models_error(models_dir.as_deref(), &missing));
        }
        println!(
            "cargo:warning=TOKENCOUNT_ALLOW_PARTIAL is set: building a partial binary with \
             {}/9 tokenizers ({}). The other {} exit with an error at runtime.",
            embedded.len(),
            embedded.join(", "),
            missing.len()
        );
    }

    codegen.push_str(&format!(
        "#[allow(dead_code)]\npub const EMBEDDED_MODELS: &[&str] = &{:?};\n",
        embedded
    ));

    let dest = Path::new(out_dir).join("embedded_models.rs");
    fs::write(&dest, &codegen).expect("Failed to write embedded_models.rs");
}

/// The message a modelless build dies with.
///
/// It has to be enough on its own: the reader is looking at a `cargo install`
/// or `cargo build` failure with no other context.
fn missing_models_error(models_dir: Option<&str>, missing: &[Missing]) -> String {
    let mut m = String::new();

    m.push_str("\n\ntokencount was built without its tokenizer tables.\n\n");
    match models_dir {
        Some(dir) => {
            let _ = writeln!(m, "  TOKEN_COUNT_MODELS={dir}");
            let _ = writeln!(m, "  ...is set, but {} file(s) are missing:\n", missing.len());
        }
        None => {
            m.push_str("  TOKEN_COUNT_MODELS is not set, so none of the following were found:\n\n");
        }
    }
    for entry in missing {
        let _ = writeln!(m, "    {}", entry.rel);
        let _ = writeln!(m, "      <- {}", entry.url);
    }

    m.push_str(
        r#"
All 9 tokenizer tables are compiled into the binary -- tokencount has no runtime
data files. Only the Claude table ships in this repository (data/claude-vocab.json).
The other 8 belong to model vendors under terms tokencount cannot redistribute,
so the build reads them from a directory you provide.

Pick one:

  1. Do not build. Install a prebuilt, provenance-attested binary:

       https://github.com/eordano/tokencount/releases
       cargo binstall --git https://github.com/eordano/tokencount tokencount

  2. Build with Nix, which fetches every file above at a pinned hash:

       nix build github:eordano/tokencount

  3. Fetch the files yourself into a directory laid out exactly as listed
     above, then point the build at it:

       TOKEN_COUNT_MODELS=/path/to/models cargo build --release --locked

  4. Deliberately build a reduced binary. The models listed above are then
     absent, and exit with an error when selected at runtime:

       TOKENCOUNT_ALLOW_PARTIAL=1 cargo build --release --locked

"#,
    );

    m
}

fn build_tiktoken_frozen(path: &Path) -> Vec<u8> {
    use base64::Engine;

    let data = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));

    let engine = base64::engine::general_purpose::STANDARD;

    let mut entries: Vec<(Vec<u8>, u32)> = Vec::with_capacity(200_000);

    for line in data.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let token_b64 = parts.next().unwrap_or("");
        let rank_str = parts.next().unwrap_or("");
        if let (Ok(bytes), Ok(rank)) = (engine.decode(token_b64), rank_str.parse::<u32>()) {
            entries.push((bytes, rank));
        }
    }

    build_frozen_map(&entries)
}

const NORM_NONE: u8 = 0;
const NORM_REPLACE: u8 = 1;
const NORM_PREPEND: u8 = 2;
const NORM_NFC: u8 = 3;
const NORM_SEQUENCE: u8 = 4;

const STEP_SPLIT: u8 = 1;
const STEP_BYTE_LEVEL: u8 = 2;

fn build_hf_frozen(path: &Path) -> Vec<u8> {
    let data = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));
    let root: serde_json::Value =
        serde_json::from_str(&data).unwrap_or_else(|e| panic!("invalid JSON: {e}"));

    let model = root.get("model").expect("missing model");

    let merges_arr = model
        .get("merges")
        .and_then(|v| v.as_array())
        .expect("missing merges");

    let mut merge_entries: Vec<(Vec<u8>, u32)> = Vec::with_capacity(merges_arr.len());
    let mut merge_left_keys: Vec<Vec<u8>> = Vec::new();
    let mut merge_right_keys: Vec<Vec<u8>> = Vec::new();
    let mut merge_left_seen = std::collections::HashSet::new();
    let mut merge_right_seen = std::collections::HashSet::new();

    for (rank, entry) in merges_arr.iter().enumerate() {
        let (a, b) = if let Some(s) = entry.as_str() {
            let mut parts = s.splitn(2, ' ');
            let a = parts.next().unwrap_or("").to_string();
            let b = parts.next().unwrap_or("").to_string();
            (a, b)
        } else if let Some(arr) = entry.as_array() {
            let a = arr.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
            let b = arr.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
            (a, b)
        } else {
            continue;
        };

        let mut pair_key = Vec::with_capacity(a.len() + 1 + b.len());
        pair_key.extend_from_slice(a.as_bytes());
        pair_key.push(0);
        pair_key.extend_from_slice(b.as_bytes());
        merge_entries.push((pair_key, rank as u32));

        if merge_left_seen.insert(a.clone()) {
            merge_left_keys.push(a.as_bytes().to_vec());
        }
        if merge_right_seen.insert(b.clone()) {
            merge_right_keys.push(b.as_bytes().to_vec());
        }
    }

    let byte_fallback = model
        .get("byte_fallback")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let post_add = count_post_special_tokens(root.get("post_processor")) as u32;

    let mut sorted_codepoints: Vec<u32> = Vec::new();
    if byte_fallback {
        if let Some(vocab_obj) = model.get("vocab").and_then(|v| v.as_object()) {
            for key in vocab_obj.keys() {
                let chars: Vec<char> = key.chars().collect();
                if chars.len() == 1 {
                    sorted_codepoints.push(chars[0] as u32);
                }
            }
        }
        sorted_codepoints.sort();
        sorted_codepoints.dedup();
    }

    let merges_table = build_frozen_map(&merge_entries);
    let merge_left_table = build_frozen_set(&merge_left_keys);
    let merge_right_table = build_frozen_set(&merge_right_keys);

    let mut blob = Vec::new();
    blob.push(if byte_fallback { 1 } else { 0 });
    blob.extend_from_slice(&post_add.to_le_bytes());
    serialize_normalizer(&mut blob, root.get("normalizer"));
    serialize_pre_tokenizer(&mut blob, root.get("pre_tokenizer"));
    blob.extend_from_slice(&(sorted_codepoints.len() as u32).to_le_bytes());
    for &cp in &sorted_codepoints { blob.extend_from_slice(&cp.to_le_bytes()); }
    blob.extend_from_slice(&merges_table);
    blob.extend_from_slice(&merge_left_table);
    blob.extend_from_slice(&merge_right_table);

    blob
}

fn count_post_special_tokens(val: Option<&serde_json::Value>) -> usize {
    let val = match val {
        Some(v) if !v.is_null() => v,
        _ => return 0,
    };
    let ty = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ty {
        "TemplateProcessing" => {
            val.get("single")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter(|item| item.get("SpecialToken").is_some())
                        .count()
                })
                .unwrap_or(0)
        }
        "Sequence" => {
            val.get("processors")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|p| count_post_special_tokens(Some(p)))
                        .sum()
                })
                .unwrap_or(0)
        }
        _ => 0,
    }
}

fn serialize_normalizer(blob: &mut Vec<u8>, val: Option<&serde_json::Value>) {
    let val = match val {
        Some(v) if !v.is_null() => v,
        _ => {
            blob.push(NORM_NONE);
            return;
        }
    };
    let ty = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ty {
        "Replace" => {
            blob.push(NORM_REPLACE);
            let pattern = val
                .get("pattern")
                .and_then(|p| p.get("String"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            let content = val
                .get("content")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            write_length_prefixed_str(blob, pattern);
            write_length_prefixed_str(blob, content);
        }
        "Prepend" => {
            blob.push(NORM_PREPEND);
            let prepend = val
                .get("prepend")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            write_length_prefixed_str(blob, prepend);
        }
        "NFC" => {
            blob.push(NORM_NFC);
        }
        "Sequence" => {
            let normalizers = val
                .get("normalizers")
                .and_then(|v| v.as_array());
            if let Some(arr) = normalizers {
                if arr.is_empty() {
                    blob.push(NORM_NONE);
                } else {
                    blob.push(NORM_SEQUENCE);
                    blob.extend_from_slice(&(arr.len() as u32).to_le_bytes());
                    for item in arr {
                        serialize_normalizer(blob, Some(item));
                    }
                }
            } else {
                blob.push(NORM_NONE);
            }
        }
        _ => {
            blob.push(NORM_NONE);
        }
    }
}

fn serialize_pre_tokenizer(blob: &mut Vec<u8>, val: Option<&serde_json::Value>) {
    let val = match val {
        Some(v) if !v.is_null() => v,
        _ => {
            // 0 steps = no pre-tokenizer
            blob.extend_from_slice(&0u32.to_le_bytes());
            return;
        }
    };

    let ty = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

    let steps: Vec<&serde_json::Value> = match ty {
        "Sequence" => {
            val.get("pretokenizers")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().collect())
                .unwrap_or_default()
        }
        "ByteLevel" | "Split" => vec![val],
        _ => vec![],
    };

    let valid_steps: Vec<&serde_json::Value> = steps
        .into_iter()
        .filter(|s| {
            let t = s.get("type").and_then(|v| v.as_str()).unwrap_or("");
            t == "Split" || t == "ByteLevel"
        })
        .collect();

    blob.extend_from_slice(&(valid_steps.len() as u32).to_le_bytes());

    for step in &valid_steps {
        let t = step.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "Split" => {
                blob.push(STEP_SPLIT);
                let pattern = step
                    .get("pattern")
                    .and_then(|p| p.get("Regex"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                write_length_prefixed_str(blob, pattern);
            }
            "ByteLevel" => {
                blob.push(STEP_BYTE_LEVEL);
            }
            _ => {}
        }
    }
}

fn write_length_prefixed_str(blob: &mut Vec<u8>, s: &str) {
    blob.extend_from_slice(&(s.len() as u32).to_le_bytes());
    blob.extend_from_slice(s.as_bytes());
}

fn read_u64_le(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

/// Lemire fast range reduction: maps a u64 hash into [0, n) via
/// fixed-point multiply -- one `mul` + shift, no division.
fn fast_reduce(h: u64, n: usize) -> usize {
    ((h as u128).wrapping_mul(n as u128) >> 64) as usize
}

fn build_frozen_table(keys: &[Vec<u8>], values: Option<&[u32]>, slot_size: usize) -> Vec<u8> {
    let num_entries = keys.len();
    let num_slots = (num_entries * 4).div_ceil(3).max(4);
    let mut string_pool = Vec::new();
    let mut slots = vec![0u8; num_slots * slot_size];

    for (i, key) in keys.iter().enumerate() {
        let h = fnv_hash(key);
        let key_off = string_pool.len() as u32;
        let key_len = key.len() as u16;
        string_pool.extend_from_slice(key);

        let mut idx = fast_reduce(h, num_slots);
        loop {
            let s = idx * slot_size;
            if read_u64_le(&slots, s) == 0 {
                slots[s..s + 8].copy_from_slice(&h.to_le_bytes());
                slots[s + 8..s + 12].copy_from_slice(&key_off.to_le_bytes());
                slots[s + 12..s + 14].copy_from_slice(&key_len.to_le_bytes());
                if let Some(vals) = values {
                    slots[s + 14..s + 18].copy_from_slice(&vals[i].to_le_bytes());
                }
                break;
            }
            idx += 1;
            if idx == num_slots { idx = 0; }
        }
    }

    let mut table = Vec::with_capacity(12 + slots.len() + string_pool.len());
    table.extend_from_slice(&(num_slots as u32).to_le_bytes());
    table.extend_from_slice(&(num_entries as u32).to_le_bytes());
    table.extend_from_slice(&(string_pool.len() as u32).to_le_bytes());
    table.extend_from_slice(&slots);
    table.extend_from_slice(&string_pool);
    table
}

fn build_frozen_map(entries: &[(Vec<u8>, u32)]) -> Vec<u8> {
    let (keys, values): (Vec<_>, Vec<_>) = entries.iter().cloned().unzip();
    build_frozen_table(&keys, Some(&values), 18)
}

fn build_frozen_set(keys: &[Vec<u8>]) -> Vec<u8> {
    build_frozen_table(keys, None, 14)
}
