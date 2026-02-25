# tokencount

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/demo-live-green)](https://tokencount.eordano.com)
[![Deploy](https://github.com/eordano/tokencount/actions/workflows/deploy.yml/badge.svg)](https://github.com/eordano/tokencount/actions/workflows/deploy.yml)

Compare two texts side-by-side and estimate LLM token costs across multiple
models. `tokencount` shows word-level diffs, counts tokens using real
tokenizers, and lets you share comparisons via URL.

Paste your original text on the left, your modified text on the right, and
instantly see what changed and how many tokens each version costs:

```
 Panel A (original)              Panel B (modified)
┌──────────────────────┐       ┌──────────────────────┐
│ The quick brown fox  │       │ The fast brown fox   │
│ jumps over the lazy  │       │ leaps over the sleepy│
│ dog.                 │       │ dog.                 │
└──────────────────────┘       └──────────────────────┘

  Diff: -quick +fast  -jumps +leaps  -lazy +sleepy
  GPT-5: 12 → 12 tokens   Claude: 11 → 11 tokens
```

## Supported Models

| Model | Provider | Covers | Tokenizer Source |
|-------|----------|--------|-----------------|
| Claude | Anthropic | Claude 4.6 Opus and all Claude 3+ models | Trie-based tokenizer ([ctoc](https://github.com/rohangpta/ctoc)) |
| GPT-5 | OpenAI | GPT 5.2, Phi-4, and others (o200k_base) | [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) |
| Gemini | Google | Gemini 3.1 Pro and all Gemini models | HuggingFace AutoTokenizer |
| DeepSeek | DeepSeek AI | DeepSeek V3 and others | HuggingFace AutoTokenizer |
| Qwen | Alibaba | Qwen 3 and Qwen 2.5+ models | HuggingFace AutoTokenizer |
| MiniMax | MiniMax AI | MiniMax-Text-01 | HuggingFace AutoTokenizer |
| Llama | Meta | All Llama 3 and 4 models | HuggingFace AutoTokenizer |
| Mistral | Mistral AI | Nemo, Small 24B, Pixtral | HuggingFace AutoTokenizer |
| Grok | xAI | Grok 1 and 2 (3 and 4 unknown) | HuggingFace AutoTokenizer |

Tokenizers are lazy-loaded on first use. While a model loads, a heuristic
estimator provides approximate counts (with CJK-aware character ratios) so the
UI stays responsive.

## How It Works

The app starts in **single-panel mode** for counting tokens in one text. Click
**Compare two texts** to enter **compare mode** with side-by-side panels,
word-level diffs, and token deltas.

The diff engine splits both texts into word-level tokens (preserving whitespace),
computes the Longest Common Subsequence, and backtracks to classify each segment
as added, removed, or unchanged.

Token counting runs the actual tokenizer for each model. GPT-5 uses
`gpt-tokenizer` (o200k_base) loaded from ESM. Claude uses a local trie built
from a 36k-token vocabulary file. The remaining models use HuggingFace's
`@huggingface/transformers` `AutoTokenizer`, which downloads and caches the real
tokenizer artifacts from HuggingFace Hub.

**Token overlay** -- click the Tokens button to visualize token boundaries
directly on top of your text, color-coded per token. The overlay updates with
debounced re-rendering as you type.

In compare mode, the **diff summary strip** shows the selected model, a hero
token delta (+/- tokens between original and modified), percentage change, and
per-panel counts. The **diff card** below renders the word-level diff with
added/removed/unchanged token counts.

## Usage

No build step, no dependencies, no installation. Serve the directory with any
static file server:

```bash
# Python
python3 -m http.server 8000

# Node
npx http-server

# Or just open index.html directly in a browser
open index.html
```

Then visit `http://localhost:8000` and paste your texts.

### Deployed instance

The app is deployed automatically to GitHub Pages on every push to `main`:

> https://tokencount.eordano.com

## URL Sharing

Click the **Share** button to copy a URL containing both texts encoded as a
zbase32 payload in the `?d=` query parameter. Recipients opening the link see
the same comparison without any server-side storage. The shared URL also
preserves the selected model, token highlight state, and pre-computed token
counts (so counts display instantly before the tokenizer loads).

The encoding pipeline:

```
{a, b, model, highlight, tokens} → JSON.stringify → UTF-8 → zbase32 → ?d=…
```

zbase32 uses a 32-character alphabet designed to avoid visually ambiguous
characters, keeping URLs compact and copy-paste friendly.

## Architecture

```
index.html                Single-page entry point
css/
  style.css               Dark theme, OKLCH color system, responsive layout
js/
  app.js                  Application state, event handling, UI rendering
  diff.js                 Word-level LCS diff algorithm
  tokenizer.js            Multi-model tokenizer interface with lazy loading
  claude-tokenizer.js     Trie-based Claude tokenizer
  zbase32.js              URL payload encoding/decoding
data/
  claude-vocab.json       36,495 verified Claude vocabulary tokens
tests/
  workflows.spec.js       Playwright E2E tests (desktop + mobile)
playwright.config.js      Playwright configuration
```

The entire application is vanilla JavaScript with ES6 modules. No framework,
no bundler, no `node_modules`. Runtime tokenizer libraries are loaded from CDN
(`esm.sh` for gpt-tokenizer, `jsdelivr` for HuggingFace transformers).

### Module graph

```
app.js
├── diff.js             computeDiff(textA, textB)
├── tokenizer.js        countTokens / encodeTokens / loadModel / countAllTokenizers
│   └── claude-tokenizer.js   loadClaudeTokenizer / getClaudeTokenizer
└── zbase32.js          encodePayload / decodePayload
```

## Development

The project has no build or install step. Edit the files and refresh the browser.

```bash
git clone https://github.com/eordano/tokencount.git
cd tokencount
python3 -m http.server 8000
```

### E2E Tests

End-to-end tests use [Playwright](https://playwright.dev/) with desktop
(1280x720) and mobile (375x812) viewports:

```bash
npm install
npx playwright test
```

The test server starts automatically via the Playwright config.

### Deployment

Deployment happens via GitHub Actions (`.github/workflows/deploy.yml`) on push
to `main`. The workflow uploads the entire repository as a GitHub Pages artifact.

## License

[AGPL-3.0](LICENSE)
