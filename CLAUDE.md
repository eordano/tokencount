Vanilla JS web app: side-by-side text diff with token counts across 9
tokenizers. No framework. Also ships an offline bundle and a CLI tool.

## Project structure

```
index.html                Entry point (ES6 module)
css/style.css             Dark theme, OKLCH colors, responsive
js/app.js                 State, events, rendering, UI sync
js/diff.js                Word-level LCS diff
js/tokenizer.js           Multi-model tokenizer: lazy loading, fallback heuristics
js/claude-tokenizer.js    Trie-based Claude tokenizer (local vocab)
js/zbase32.js             zbase32 encoding for URL sharing
data/claude-vocab.json    36,495 Claude vocabulary tokens
cli/tokencount.mjs       CLI: count tokens from files/stdin
cli/lib/tokenizer.mjs     CLI tokenizer wrapper
scripts/build-offline.mjs Offline HTML bundle (esbuild)
scripts/build-cli.mjs     CLI binary + model data
tests/workflows.spec.js   Playwright E2E (desktop + mobile)
tests/cli.test.mjs        CLI integration tests
playwright.config.js      Dev server on :8000
playwright.bundle.config.js  Offline bundle on :8001
package.json              Playwright, esbuild, gpt-tokenizer, @huggingface/transformers
flake.nix                 Nix dev shell + builds (vendored HF models)
.github/workflows/        deploy, e2e, offline-bundle, preview
```

## Design

- No build tools (web): ES6 modules in browser. CDN libs (esm.sh, jsdelivr).
- Lazy loading: Models load on demand. CJK-aware heuristic while loading.
- Responsive: CSS grid desktop, tab navigation mobile (<768px).
- Token overlay: Visualization behind textarea. Debounced. Per-panel toggle.
- Two modes: Single-panel token counting. Compare mode for diff + deltas.
- URL sharing: JSON → UTF-8 → zbase32 → `?d=` param. No server.
- Offline bundle: `scripts/build-offline.mjs` → single HTML with all models.
- CLI: `cli/tokencount.mjs` — all 9 models. Build: `scripts/build-cli.mjs`.
- Nix: `flake.nix` — dev shells + builds, vendored HF models.

## Run locally

`python3 -m http.server 8000` — no install required.

## Exports

- `diff.js`: `computeDiff(textA, textB)` → `[{type, text}]`
- `tokenizer.js`: `MODEL_PROFILES`, `countTokens(text, name)`,
  `encodeTokens(text, name)`, `countAllTokenizers(text)`,
  `loadModel(name, onReady)`, `isReady(name)`, `getStatus(name)`
- `claude-tokenizer.js`: `loadClaudeTokenizer(vocabUrl)`,
  `getClaudeTokenizer()`, `ClaudeTokenizer`
- `zbase32.js`: `encodePayload(textA, textB, opts)`, `decodePayload(encoded)`

## Conventions

- Vanilla JS, ES6 modules, no TypeScript
- CSS custom properties for theming (top of style.css)
- Playwright E2E: `npx playwright test`
- Commits: `feat:`, `fix:`, etc.

## Common tasks

Add a tokenizer model: Add to `MODEL_PROFILES` in `js/tokenizer.js` (name,
color, loader type). Also update: `cli/lib/tokenizer.mjs`,
`scripts/build-offline.mjs` HF_REPOS, `scripts/build-cli.mjs` REPO_MAP,
`flake.nix` model hashes, README.md model table.

Change diff algorithm: Edit `js/diff.js` — `computeDiff` returns
`[{type: 'added'|'removed'|'unchanged', text}]`.

Modify diff summary: `renderDiffSummary` and `renderDiffCard` in `js/app.js`.
Dropdown: `openDropdown`/`closeDropdown`.

Update Claude vocab: Replace `data/claude-vocab.json` (JSON array of strings).

Tests: `npx playwright test` | `npm run test:bundle` | `npm run test:cli`

Build: `npm run build:offline` → `dist/tokencount.html` |
`npm run build:cli` → `dist/tokencount.mjs` + `dist/models/`
