---
name: reduce-tokens
description: Reduce codebase and documentation token count while preserving
identical behavior. Use when the user asks to shrink tokens, reduce context
size, or optimize for LLM consumption.
---

# Reducing Token Count

Techniques for reducing LLM token consumption in code and documentation while
preserving all information and identical behavior. Measure with `tokencount`.

## Workflow

1. Measure. `tokencount -r` for a per-file breakdown, sorted by size. Split
   into *addressable* (hand-written code/prose) vs *off-limits* (data,
   fixtures, generated output — see "Never Touch"). Report progress against
   the addressable baseline, not the raw total. Verify `--ignore` exclusions
   actually changed the count (see Measurement — it fails silently).
2. Remove dead weight first (techniques 1-2) — zero behavioral risk.
3. Refactor live code (techniques 3-7), largest files first.
4. Tighten documentation (techniques 8-10).
5. Verify after each round (build/lint/test/remeasure); keep only changes
   that measurably reduce tokens without breaking anything.
6. Repeat: re-run `tokencount -r`, iterate on the new largest file.

Intuition about what saves tokens is often wrong (e.g. padded columns can beat
labeled blocks) — diff a rewrite with `tokencount /tmp/before.txt
/tmp/after.txt` before committing to it.

## Elimination (highest impact, lowest risk)

### 1. Remove dead code and unused files
Unused imports (linter-flagged), unreachable functions (grep for callers
first), orphaned files (grep for importers), commented-out blocks (delete —
it's in git history), unused vars/params. Work in that order; test after
each pass.

### 2. Find and delete duplicate files
`md5sum` all files, group by hash, delete redundant copies. When both
locations look intentional (self-contained archives), flag the tradeoff to
the user instead of deleting.

## Code

### 3. Extract repeated construction patterns
Same setup 3+ times → extract a helper; each call site collapses to one
line. E.g. repeated widget setup → `make_button(label)`, call sites become
`layout.addWidget(make_button("Save"))`.

### 4. Collapse repetitive switch/match branches
Every branch sets the same N properties → extract a helper taking those N
values, e.g. `applyState(icon, title, color, show)` instead of per-branch
assignment.

### 5. Extract common builder/setup boilerplate
Multiple methods share setup (headers, base URL, config) → extract the
shared part into one helper, e.g. `_req(method, path, **kw)` behind
`get()`/`post()`/etc.

### 6. Deduplicate similar code
Four patterns: overlapping methods (B does A's work plus more → B calls A);
near-identical functions differing by one literal (parameterize); duplicate
JSON-parsing logic (extract a shared parser); copy-paste route registrations
(table-driven loop).

### 7. Condense chains, comments, and formatting
Collapse builder chains (`.put().put().build()`) onto fewer lines. Remove
comments that restate the next line; keep comments explaining *why*.
Condense multi-paragraph docstrings to one line when the signature makes it
obvious. Drop decorative markdown (`**bold**`) and ASCII banner lines
(`###...`, `// ===...`) — replace with a plain heading. Repeated `<style>`
blocks across HTML pages → extract to one shared stylesheet.

## Documentation

### 8. Eliminate duplication
Cross-file: pick one canonical doc, have others cross-reference it.
Within-file: replace restated material with a cross-reference. Delete
"quick reference" summaries that repeat preceding content verbatim.

### 9. Replace ASCII art with prose
Tree/box diagrams tokenize poorly (pipes, arrows, padding). Convert to a
one-sentence description of the flow, e.g. "bootloader loads kernel+initrd,
initrd loads the disk driver, mounts root, hands off to init."

### 10. Tighten structured prose
Replace formatted JSON examples with inline descriptions. Shorten CLI/`jq`
examples. Cut filler sentences that add emphasis but no information.

## Verification

Establish a baseline (lint + full test suite) before any changes — every
edit is measured against it.

After each round: 1) build/compile, 2) lint (zero new warnings vs baseline),
3) run the full test suite (all baseline-passing tests must still pass), 4)
remeasure with `tokencount` — revert a refactor that didn't measurably help,
5) spot-check behavior for code without test coverage.

No tests/linter in the project: be conservative — prefer dead-code/duplicate/
comment deletions over structural refactors.

## Never Touch: data, fixtures, generated output

These dominate token counts and are tempting precisely because they're huge.
Identify them in step 1 and exclude from both analysis and edits.

- Test fixtures / golden / snapshot files — often hash/CID/checksum-bound;
  one changed byte fails the test. Read the consuming test before assuming.
- Generated source — "do not edit" banners, `*.gen.*`, `*_generated.*`,
  protobuf output, network-fetched addresses.
- Generated reports — API Extractor `*.api.md`, coverage, dependency reports.
- Generated changelogs — changesets/release-please/semantic-release.
- Lock files — `pnpm-lock.yaml`, `package-lock.json`, `go.sum`, `Cargo.lock`.
- Vendored/third-party trees — `node_modules/`, `vendor/`.
- Licenses — `LICENSE`, `NOTICE`.

Exception: a generated file whose generator no longer exists is an orphan,
not generated output — delete it (technique 1) and say so.

If a fixture looks oversized for its purpose, report it as an option with
the tradeoff (current size, what the test needs, whether other tests
overlap) — do not shrink it yourself.

## What NOT to Cut

- Canonical code blocks for config patterns or deployment commands
- Structured reference tables (ports, secrets, service accounts) — already
  token-dense
- Unique error messages and non-obvious symptoms — what someone searches for
- Comments explaining *why* — threading invariants, design decisions

## Expect small yields on a healthy codebase

If the repo is already comment-stripped, has no dead code, and large test
files are properly factored, expect a rounding error — say so rather than
manufacturing churn. Report broken doc links, orphaned generated artifacts,
or docs contradicting code found along the way instead — that's the real
value of the pass.

## Measurement

```sh
tokencount -m claude file.py  # single file
tokencount -r -m claude src/  # recursive
tokencount -s old.py new.py   # side-by-side diff URL
tokencount -r --ignore '.git' --ignore '*.woff2' .  # exclude noise
```

`tokencount -r` uses the git index, not the working tree — `git add -u
<deleted-paths>` after deleting tracked files, and stage new files, or they
won't be measured.

### `--ignore` matches a path prefix relative to the scanned root

No leading wildcards; fails silently (no match = unchanged total, no
warning):

```sh
--ignore 'fixtures'                       # no-op
--ignore '*/fixtures'                     # no-op
--ignore 'libs/**/fixtures'               # no-op
--ignore 'libs/hashing/test/fixtures'     # works
--ignore 'libs/hashing/test/fixtures/**'  # works
```

Bare name only matches a direct child of the scanned root
(`tokencount -r libs/hashing/test --ignore 'fixtures'` does filter).

Always confirm an exclusion changed the total:

```sh
tokencount -r -m claude . | tail -1
tokencount -r -m claude --ignore '<path>' . | tail -1   # must differ
```

When patterns get unwieldy, skip `--ignore` and subtract the off-limits
files by hand — show the arithmetic so the baseline is auditable.
