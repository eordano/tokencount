mod bpe;
mod byte_level;
mod claude;
mod frozen;
mod tiktoken;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_models.rs"));
}

use base64::Engine;
use rayon::prelude::*;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

const MODEL_NAMES: &[&str] = &[
    "claude", "openai", "gemini", "deepseek", "qwen", "llama", "mistral", "grok", "minimax",
];

const DEFAULT_BASE_URL: &str = "https://tokencount.eordano.com/";

enum Tokenizer {
    Claude(claude::DATrie),
    Tiktoken(tiktoken::TiktokenTokenizer),
    Hf(bpe::HfTokenizer),
}

impl Tokenizer {
    fn count_tokens(&self, text: &str) -> usize {
        match self {
            Tokenizer::Claude(t) => t.count_tokens(text),
            Tokenizer::Tiktoken(t) => t.count_tokens(text),
            Tokenizer::Hf(t) => t.count_tokens(text),
        }
    }
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Args {
    model: String,
    all: bool,
    recursive: bool,
    gitignore: bool,
    ignore: Vec<String>,
    share: bool,
    help: bool,
    version: bool,
    paths: Vec<String>,
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut args = Args {
        model: "claude".to_string(),
        all: false,
        recursive: false,
        gitignore: true,
        ignore: Vec::new(),
        share: false,
        help: false,
        version: false,
        paths: Vec::new(),
    };

    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "-V" | "--version" => args.version = true,
            "-h" | "--help" => args.help = true,
            "-r" | "--recursive" => args.recursive = true,
            "--no-gitignore" => args.gitignore = false,
            "-s" | "--share" => args.share = true,
            "-a" | "--all" => args.all = true,
            "--ignore" => {
                i += 1;
                if i >= argv.len() {
                    eprintln!("Error: --ignore requires a value");
                    std::process::exit(1);
                }
                args.ignore.push(argv[i].clone());
            }
            "-m" | "--model" => {
                i += 1;
                if i >= argv.len() {
                    eprintln!("Error: --model requires a value");
                    std::process::exit(1);
                }
                args.model = argv[i].clone();
            }
            s if s.starts_with('-') => {
                eprintln!("Error: unknown option: {}", s);
                std::process::exit(1);
            }
            _ => args.paths.push(argv[i].clone()),
        }
        i += 1;
    }
    args
}

fn print_help() {
    println!(
        "Usage: tokencount [options] [path...]\n\
         \n\
         Count tokens in files or stdin using LLM tokenizers.\n\
         \n\
         Options:\n\
         \x20 -m, --model <name>   Tokenizer model (default: claude)\n\
         \x20 -a, --all            Show counts for all models\n\
         \x20 -r, --recursive      Recurse into directories\n\
         \x20 --ignore <pattern>   Skip files/dirs matching pattern (repeatable)\n\
         \x20 --no-gitignore       Don't skip .gitignore'd files when recursing\n\
         \x20 -s, --share          Print a shareable URL instead of counts\n\
         \x20 -V, --version        Show version\n\
         \x20 -h, --help           Show this help\n\
         \n\
         Models: {}\n\
         \n\
         When no paths are given, reads from stdin.\n\
         Directories require -r; binary files are skipped.\n\
         \n\
         Share mode (-s) takes one or two files (or stdin) and prints a URL\n\
         that opens the web app with the text pre-filled. Use two files to\n\
         get a side-by-side diff. Override the base URL with TOKEN_COUNT_URL.",
        MODEL_NAMES.join(", ")
    );
}

fn embedded_data(name: &str) -> Option<&'static [u8]> {
    match name {
        "openai" => embedded::O200K,
        "gemini" => embedded::GEMINI,
        "deepseek" => embedded::DEEPSEEK,
        "qwen" => embedded::QWEN,
        "llama" => embedded::LLAMA,
        "mistral" => embedded::MISTRAL,
        "grok" => embedded::GROK,
        "minimax" => embedded::MINIMAX,
        _ => None,
    }
}

fn load_model(name: &str) -> Tokenizer {
    match name {
        "claude" => Tokenizer::Claude(claude::DATrie::new()),
        "openai" => {
            let data = embedded_data("openai").unwrap_or_else(|| {
                eprintln!("Error: openai model not embedded (build with TOKEN_COUNT_MODELS)");
                std::process::exit(1);
            });
            Tokenizer::Tiktoken(tiktoken::TiktokenTokenizer::new(data))
        }
        model => {
            let data = embedded_data(model).unwrap_or_else(|| {
                eprintln!("Error: {} model not embedded (build with TOKEN_COUNT_MODELS)", model);
                std::process::exit(1);
            });
            match bpe::HfTokenizer::from_frozen(data) {
                Ok(t) => Tokenizer::Hf(t),
                Err(e) => {
                    eprintln!("Error loading {} model: {}", model, e);
                    std::process::exit(1);
                }
            }
        }
    }
}

fn is_binary(path: &Path) -> bool {
    let Ok(f) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 8192];
    let n = io::Read::read(&mut f.take(8192), &mut buf).unwrap_or(0);
    buf[..n].contains(&0)
}

fn is_in_git_repo(dir: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn git_list_files(dir: &Path) -> Vec<PathBuf> {
    let output = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(dir)
        .output()
        .ok();
    match output {
        Some(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.split('\0')
                .filter(|f| !f.is_empty())
                .map(|f| dir.join(f))
                .collect()
        }
        _ => Vec::new(),
    }
}

fn matches_ignore(file_path: &Path, base_dir: &Path, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let rel = match file_path.strip_prefix(base_dir) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => return false,
    };
    let basename = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    for pat in patterns {
        let target = if pat.contains('/') { &rel } else { &basename };
        if glob_match(pat, target) {
            return true;
        }
        if !pat.contains('*') && (rel == *pat || rel.starts_with(&format!("{}/", pat))) {
            return true;
        }
    }
    false
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let mut re = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            re.push_str(".*");
            i += 2;
        } else if chars[i] == '*' {
            re.push_str("[^/]*");
            i += 1;
        } else {
            let c = chars[i];
            if ".+^${}()|[]\\".contains(c) {
                re.push('\\');
            }
            re.push(c);
            i += 1;
        }
    }
    re.push('$');
    fancy_regex::Regex::new(&re)
        .map(|r| r.is_match(text).unwrap_or(false))
        .unwrap_or(false)
}

fn expand_dir(dir: &Path, use_gitignore: bool) -> Vec<PathBuf> {
    if use_gitignore && is_in_git_repo(dir) {
        return git_list_files(dir)
            .into_iter()
            .filter(|f| f.is_file() && !is_binary(f))
            .collect();
    }
    let mut files = Vec::new();
    fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, files);
            } else if path.is_file() && !is_binary(&path) {
                files.push(path);
            }
        }
    }
    walk(dir, &mut files);
    files.sort();
    files
}

fn expand_paths(
    paths: &[String],
    recursive: bool,
    use_gitignore: bool,
    ignore_patterns: &[String],
) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        if !path.exists() {
            eprintln!("Error: {}: No such file or directory", p);
            std::process::exit(1);
        }
        if path.is_dir() {
            if !recursive {
                eprintln!("Error: {}: Is a directory (use -r to recurse)", p);
                std::process::exit(1);
            }
            for f in expand_dir(&path, use_gitignore) {
                if !matches_ignore(&f, &path, ignore_patterns) {
                    files.push(f);
                }
            }
        } else if path.is_file() {
            files.push(path);
        }
    }
    files
}

fn base64url_encode(data: &[u8]) -> String {
    let engine = base64::engine::general_purpose::STANDARD;
    engine
        .encode(data)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

fn build_share_url(text_a: &str, text_b: &str, model: &str, count_a: usize, count_b: usize) -> String {
    let mut obj = serde_json::json!({ "a": text_a, "b": text_b });
    if model != "claude" {
        obj["m"] = serde_json::json!(model);
    }
    obj["t"] = serde_json::json!({ "a": count_a, "b": count_b });

    let json_bytes = serde_json::to_string(&obj).unwrap().into_bytes();
    let encoded = base64url_encode(&json_bytes);
    let base = std::env::var("TOKEN_COUNT_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
    let base = base.trim_end_matches('/');
    format!("{}/?b={}", base, encoded)
}

fn format_line(count: &str, label: &str) -> String {
    format!("{:>8} {}\n", count, label)
}

fn main() {
    let args = parse_args();

    if args.version {
        println!("tokencount {}", VERSION);
        return;
    }
    if args.help {
        print_help();
        return;
    }

    let model_names: Vec<&str> = if args.all {
        MODEL_NAMES.to_vec()
    } else {
        vec![args.model.as_str()]
    };

    for m in &model_names {
        if !MODEL_NAMES.contains(m) {
            eprintln!(
                "Error: unknown model '{}'\nAvailable: {}",
                m,
                MODEL_NAMES.join(", ")
            );
            std::process::exit(1);
        }
    }

    struct Input {
        name: Option<String>,
        text: String,
    }

    let inputs: Vec<Input> = if args.paths.is_empty() {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf).unwrap_or_else(|e| {
            eprintln!("Error reading stdin: {}", e);
            std::process::exit(1);
        });
        vec![Input {
            name: None,
            text: buf,
        }]
    } else {
        let files = expand_paths(&args.paths, args.recursive, args.gitignore, &args.ignore);
        files
            .into_iter()
            .map(|f| {
                let text = fs::read_to_string(&f).unwrap_or_else(|e| {
                    eprintln!("Error reading {}: {}", f.display(), e);
                    std::process::exit(1);
                });
                Input {
                    name: Some(f.to_string_lossy().to_string()),
                    text,
                }
            })
            .collect()
    };

    let mut tokenizers: Vec<(&str, Tokenizer)> = Vec::new();
    for &m in &model_names {
        let t = load_model(m);
        tokenizers.push((m, t));
    }

    if args.share {
        if inputs.len() > 2 {
            eprintln!("Error: --share accepts at most two files (text A and text B)");
            std::process::exit(1);
        }
        let text_a = inputs.first().map(|i| i.text.as_str()).unwrap_or("");
        let text_b = inputs.get(1).map(|i| i.text.as_str()).unwrap_or("");
        let label_a = inputs
            .first()
            .and_then(|i| i.name.as_deref())
            .unwrap_or("A");
        let label_b = inputs
            .get(1)
            .and_then(|i| i.name.as_deref())
            .unwrap_or("B");

        let model_name = &args.model;
        let tok = &tokenizers[0].1;
        let count_a = tok.count_tokens(text_a);
        let count_b = if inputs.len() > 1 {
            tok.count_tokens(text_b)
        } else {
            0
        };
        let delta = count_b as i64 - count_a as i64;
        let sign = if delta > 0 { "+" } else { "" };

        eprintln!("  {}", model_name);
        eprint!("{}", format_line(&count_a.to_string(), label_a));
        if inputs.len() > 1 {
            eprint!("{}", format_line(&count_b.to_string(), label_b));
            eprint!(
                "{}",
                format_line(&format!("{}{}", sign, delta), "delta")
            );
        }
        eprintln!();

        let url = build_share_url(text_a, text_b, model_name, count_a, count_b);
        println!("{}", url);
        return;
    }

    let use_parallel = inputs.len() > 1;

    if args.all {
        let count_all = |input: &Input| -> Vec<usize> {
            tokenizers.iter().map(|(_, tok)| tok.count_tokens(&input.text)).collect()
        };
        let results: Vec<Vec<usize>> = if use_parallel {
            inputs.par_iter().map(count_all).collect()
        } else {
            inputs.iter().map(count_all).collect()
        };
        for (input, counts) in inputs.iter().zip(results.iter()) {
            let label = input.name.as_deref().unwrap_or("stdin");
            for ((model_name, _), count) in tokenizers.iter().zip(counts.iter()) {
                print!(
                    "{}",
                    format_line(&count.to_string(), &format!("{} ({})", label, model_name))
                );
            }
        }
    } else {
        let tok = &tokenizers[0].1;
        let count_one = |input: &Input| tok.count_tokens(&input.text);
        let counts: Vec<usize> = if use_parallel {
            inputs.par_iter().map(count_one).collect()
        } else {
            inputs.iter().map(count_one).collect()
        };
        let total: usize = counts.iter().sum();
        if inputs.len() > 1 {
            for (input, count) in inputs.iter().zip(counts.iter()) {
                print!(
                    "{}",
                    format_line(&count.to_string(), input.name.as_deref().unwrap_or(""))
                );
            }
            print!("{}", format_line(&total.to_string(), "total"));
        } else if inputs.len() == 1 {
            print!(
                "{}",
                format_line(
                    &total.to_string(),
                    inputs[0].name.as_deref().unwrap_or("")
                )
            );
        }
    }
}
