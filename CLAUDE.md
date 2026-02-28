Vanilla JS web app: side-by-side text diff with token counts across 9
tokenizers. No framework. Also ships an offline bundle, a Node.js CLI,
and a native Rust CLI.

## Project structure

```
index.html                  Web app entry point (ES6 module)
css/style.css               Dark theme, OKLCH colors, responsive
js/app.js                   State, events, rendering, UI sync
js/diff.js                  Word-level LCS diff
js/tokenizer.js             Multi-model tokenizer: lazy loading, fallback heuristics
js/claude-tokenizer.js      Trie-based Claude tokenizer (local vocab)
js/zbase32.js               zbase32 encoding for URL sharing
data/claude-vocab.json      36,495 Claude vocabulary tokens
Cargo.toml                  Rust CLI package definition
build.rs                    Compile-time double-array trie + frozen hash tables
src/main.rs                 Rust CLI: arg parsing, model dispatch, output
src/claude.rs               Claude tokenizer (embedded double-array trie)
src/bpe.rs                  HuggingFace BPE tokenizer (7 models, frozen hash tables)
src/tiktoken.rs             OpenAI tiktoken tokenizer (o200k_base, frozen hash table)
src/frozen.rs               Frozen hash table primitives (FNV-1a, map/set lookup)
src/byte_level.rs           GPT-2 byte↔unicode mapping
cli/tokencount.mjs          Node.js CLI: count tokens from files/stdin
cli/lib/tokenizer.mjs       Node.js CLI tokenizer wrapper
scripts/build-offline.mjs   Offline HTML bundle (esbuild)
scripts/build-cli.mjs       Node.js CLI binary + model data
tests/workflows.spec.js     Playwright E2E (desktop + mobile)
tests/cli.test.mjs          CLI integration tests
playwright.config.js        Dev server on :8000
playwright.bundle.config.js Offline bundle on :8001
package.json                Playwright, esbuild, gpt-tokenizer, @huggingface/transformers
flake.nix                   Nix dev shell + builds (vendored HF models, fetched OpenAI data)
.github/workflows/          deploy, e2e, offline-bundle, preview
```

## Design

- No build tools (web): ES6 modules in browser. CDN libs (esm.sh, jsdelivr).
- Lazy loading: Models load on demand. CJK-aware heuristic while loading.
- Responsive: CSS grid desktop, tab navigation mobile (<768px).
- Token overlay: Visualization behind textarea. Debounced. Per-panel toggle.
- Two modes: Single-panel token counting. Compare mode for diff + deltas.
- URL sharing: JSON → UTF-8 → zbase32 → `?d=` param. No server.
- Offline bundle: `scripts/build-offline.mjs` → single HTML with all models.
- Node.js CLI: `cli/tokencount.mjs` — all 9 models. Build: `scripts/build-cli.mjs`.
- Rust CLI: `src/main.rs` — all 9 models, no tokenizer libraries.
- Nix: `flake.nix` — dev shells + builds, vendored HF models, fetched OpenAI data.

## Rust CLI

Three tokenizer backends, all from scratch (no tokenizer libraries):
- **Claude**: double-array trie compiled at build time from `data/claude-vocab.json`
- **OpenAI**: FNV-1a frozen hash table for o200k_base, embedded raw at build time
- **HF BPE** (7 models): frozen hash tables + sets for merges, embedded raw at build time

`build.rs` generates frozen hash tables (open-addressing, linear probing, 75%
load factor) for all 8 non-Claude models and embeds them uncompressed via
`include_bytes!`. At runtime, the data is referenced as `&'static [u8]`
directly from the binary's `.rodata` section — zero-copy, demand-paged by the
OS, no allocation or decompression.

`TOKEN_COUNT_MODELS` must be set at build time to embed model data. `nix develop`
sets it automatically via `rustModelsDir`. `nix build .#tokencount` produces a
self-contained binary with all models embedded.

Build: `cargo build --release` | `nix build .#tokencount`

## Run locally

`python3 -m http.server 8000` — no install required.

## Exports

- `diff.js`: `computeDiff(textA, textB)` → `[{type, text}]`
- `tokenizer.js`: `MODEL_PROFILES`, `countTokens(text, name)`,
  `encodeTokens(text, name)`, `countAllTokenizers(text)`,
  `loadModel(name, onReady)`, `isReady(name)`, `getStatus(name)`
- `claude-tokenizer.js`: `loadClaudeTokenizer(vocabUrl)`,
  `getClaudeTokenizer()`, `ClaudeTokenizer`
- `zbase32.js`: `encodePayload(textA, textB, opts)`, `decodePayload(encoded)`,
  `decodePayloadBase64(encoded)`

## Conventions

- Vanilla JS, ES6 modules, no TypeScript
- Rust with minimal dependencies (serde_json, fancy-regex, base64, unicode-normalization)
- CSS custom properties for theming (top of style.css)
- Playwright E2E: `npx playwright test`
- Commits: `feat:`, `fix:`, etc.

## Common tasks

Add a tokenizer model: Add to `MODEL_PROFILES` in `js/tokenizer.js` (name,
color, loader type). Also update: `cli/lib/tokenizer.mjs`,
`scripts/build-offline.mjs` HF_REPOS, `scripts/build-cli.mjs` REPO_MAP,
`flake.nix` model hashes + `repoToDir`, `src/main.rs` MODEL_NAMES,
README.md model table.

Change diff algorithm: Edit `js/diff.js` — `computeDiff` returns
`[{type: 'added'|'removed'|'unchanged', text}]`.

Modify diff summary: `renderDiffSummary` and `renderDiffCard` in `js/app.js`.
Dropdown: `openDropdown`/`closeDropdown`.

Update Claude vocab: Replace `data/claude-vocab.json` (JSON array of strings).
Rust CLI will pick it up at next `cargo build`.

Tests: `npx playwright test` | `npm run test:bundle` | `npm run test:cli`

Build (Node.js CLI): `npm run build:offline` → `dist/tokencount.html` |
`npm run build:cli` → `dist/tokencount.mjs` + `dist/models/`

Build (Rust CLI): `cargo build --release` | `nix build .#tokencount`
