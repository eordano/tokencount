A vanilla JavaScript web app that compares two texts side-by-side, showing
word-level diffs and token counts across different tokenizers. No framework,
no build step.

## Project structure

```
index.html                Entry point, loads js/app.js as ES6 module
css/style.css             All styles (dark theme, OKLCH colors, responsive)
js/app.js                 Main app: state, events, rendering, UI sync
js/diff.js                Word-level LCS diff algorithm
js/tokenizer.js           Multi-model tokenizer interface, lazy loading, fallback heuristics
js/claude-tokenizer.js    Trie-based Claude tokenizer using local vocab
js/zbase32.js             zbase32 encoding/decoding for URL sharing
data/claude-vocab.json    36,495 Claude vocabulary tokens
tests/workflows.spec.js   Playwright E2E tests (desktop + mobile)
playwright.config.js      Playwright config (auto-starts dev server)
package.json              Dev dependencies (Playwright)
```

## Key design decisions

- **No build tools**: Everything runs directly in the browser via ES6 modules.
  External libraries load from CDN (esm.sh, jsdelivr).
- **Lazy loading**: Tokenizer models load on demand when the user selects them.
  A heuristic estimator (character-ratio based, CJK-aware) provides approximate
  counts while models load.
- **Responsive layout**: Desktop uses CSS grid for side-by-side panels. Mobile
  (<768px) switches to tab-based navigation. State syncs between both views.
- **Token overlay**: Always-on token boundary visualization rendered behind
  the textarea. Debounced re-rendering on input. Toggle per panel.
- **Two modes**: Single-panel mode for counting tokens in one text. Compare
  mode for side-by-side diff with token deltas.
- **URL sharing**: Payload (texts, model, highlight state, pre-computed token
  counts) is JSON-serialized, UTF-8 encoded, zbase32 encoded into `?d=` query
  param. No server needed.

## How to run locally

```bash
python3 -m http.server 8000
# or: npx http-server
```

Open http://localhost:8000 in a browser. No install required.

## Deployment

GitHub Actions (`.github/workflows/deploy.yml`) deploys to GitHub Pages on push
to `main`. The entire repo is uploaded as a static site.

## Module exports

- `diff.js`: `computeDiff(textA, textB)` → array of `{type, text}` segments
- `tokenizer.js`: `MODEL_PROFILES`, `countTokens(text, name)`,
  `encodeTokens(text, name)`, `countAllTokenizers(text)`,
  `loadModel(name, onReady)`, `isReady(name)`, `getStatus(name)`
- `claude-tokenizer.js`: `loadClaudeTokenizer()`, `getClaudeTokenizer()`
- `zbase32.js`: `encodePayload(textA, textB, opts)`, `decodePayload(encoded)`

## Conventions

- Pure vanilla JS, no TypeScript, no JSX
- ES6 module imports/exports throughout
- CSS custom properties for theming (defined at top of style.css)
- E2E tests via Playwright (`npx playwright test`), desktop + mobile viewports
- Commit messages use conventional style: `feat:`, `fix:`, etc.

## Common tasks

**Add a new tokenizer model**: Add an entry to `MODEL_PROFILES` in
`js/tokenizer.js` with name, color, and loader type. If it uses HuggingFace,
add the model ID to the HuggingFace loader switch block. Update the model
count references in documentation.

**Change the diff algorithm**: Edit `js/diff.js`. The `computeDiff` function
returns an array of `{type: 'added'|'removed'|'unchanged', text: string}`
segments. The app renders these directly.

**Modify the diff summary**: The diff summary strip and diff card are rendered
in `js/app.js` in the `renderDiffSummary` and `renderDiffCard` functions. The
model dropdown is managed by `openDropdown`/`closeDropdown`.

**Update Claude vocabulary**: Replace `data/claude-vocab.json` with a new
JSON array of token strings. The trie rebuilds automatically on load.

**Run E2E tests**: `npx playwright test` (installs deps from package.json,
auto-starts a dev server on port 8000).
