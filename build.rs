use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::Path;

const TERM_BIT: u32 = 0x8000_0000;

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

fn fnv_hash(data: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h | 1
}

fn main() {
    println!("cargo:rerun-if-changed=data/claude-vocab.json");
    println!("cargo:rerun-if-env-changed=TOKEN_COUNT_MODELS");

    let out_dir = env::var("OUT_DIR").unwrap();
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();

    build_claude_trie(&manifest_dir, &out_dir);
    build_frozen_models(&out_dir);
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

const HF_MODELS: &[&str] = &[
    "gemini", "deepseek", "qwen", "llama", "mistral", "grok", "minimax",
];

fn build_frozen_models(out_dir: &str) {
    let models_dir = env::var("TOKEN_COUNT_MODELS").ok();

    let out = Path::new(out_dir);
    let mut codegen = String::new();

    if let Some(ref dir) = models_dir {
        let models_path = Path::new(dir);

        // Tiktoken (OpenAI o200k_base)
        let tiktoken_path = models_path.join("o200k_base.tiktoken");
        if tiktoken_path.exists() {
            let blob = build_tiktoken_frozen(&tiktoken_path);
            let dest = out.join("o200k_frozen.bin");
            fs::write(&dest, &blob).expect("Failed to write o200k_frozen.bin");
            codegen.push_str(&format!(
                "pub const O200K: Option<&[u8]> = Some(include_bytes!(\"{}\"));\n",
                dest.display()
            ));
        } else {
            codegen.push_str("pub const O200K: Option<&[u8]> = None;\n");
        }

        // HF BPE models
        for &model in HF_MODELS {
            let const_name = model.to_uppercase();
            let tokenizer_path = models_path.join(model).join("tokenizer.json");
            if tokenizer_path.exists() {
                let blob = build_hf_frozen(&tokenizer_path);
                let filename = format!("{}_frozen.bin", model);
                let dest = out.join(&filename);
                fs::write(&dest, &blob).unwrap_or_else(|e| {
                    panic!("Failed to write {}: {}", filename, e)
                });
                codegen.push_str(&format!(
                    "pub const {}: Option<&[u8]> = Some(include_bytes!(\"{}\"));\n",
                    const_name,
                    dest.display()
                ));
            } else {
                codegen.push_str(&format!(
                    "pub const {}: Option<&[u8]> = None;\n",
                    const_name
                ));
            }
        }
    } else {
        codegen.push_str("pub const O200K: Option<&[u8]> = None;\n");
        for &model in HF_MODELS {
            codegen.push_str(&format!(
                "pub const {}: Option<&[u8]> = None;\n",
                model.to_uppercase()
            ));
        }
    }

    let dest = Path::new(out_dir).join("embedded_models.rs");
    fs::write(&dest, &codegen).expect("Failed to write embedded_models.rs");
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

fn build_frozen_table(keys: &[Vec<u8>], values: Option<&[u32]>, slot_size: usize) -> Vec<u8> {
    let num_entries = keys.len();
    let num_slots = (num_entries * 4).div_ceil(3).next_power_of_two().max(4);
    let mask = num_slots - 1;
    let mut string_pool = Vec::new();
    let mut slots = vec![0u8; num_slots * slot_size];

    for (i, key) in keys.iter().enumerate() {
        let h = fnv_hash(key);
        let key_off = string_pool.len() as u32;
        let key_len = key.len() as u16;
        string_pool.extend_from_slice(key);

        let mut idx = (h as usize) & mask;
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
            idx = (idx + 1) & mask;
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
