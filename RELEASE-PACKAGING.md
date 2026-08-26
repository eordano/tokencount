# Releasing and packaging tokencount

Operator's guide. Everything a workflow can do, it does; everything it cannot,
this file spells out. Read [Setup you must do by hand](#setup-you-must-do-by-hand)
once, then live in [Cutting a release](#cutting-a-release).

- [What ships, and from where](#what-ships-and-from-where)
- [Setup you must do by hand](#setup-you-must-do-by-hand)
- [Cutting a release](#cutting-a-release)
- [After the release: the three external channels](#after-the-release-the-three-external-channels)
- [What is deliberately not automated](#what-is-deliberately-not-automated)
- [When something goes wrong](#when-something-goes-wrong)

## What ships, and from where

| Artifact | Built by | Trigger | Lands on |
|---|---|---|---|
| 5 Rust CLI archives + `SHA256SUMS` + provenance attestation | `.github/workflows/release.yml` | push of a `v*` tag | a **draft** GitHub Release |
| Rendered Homebrew / Scoop / WinGet manifests | `release.yml` (`packaging` job) | same | a workflow artifact, `packaging-manifests` |
| `tokencount` + 5 `@tokencount/*` npm packages | `.github/workflows/npm-publish.yml` | `release: published` | npmjs.com |
| `tokencount-offline.tar.gz`, `tokencount-cli.tar.gz` | `.github/workflows/offline-bundle.yml` | `release: published` | the same release |
| the web app | `.github/workflows/ci.yml` | push to `main` | GitHub Pages |

Two things follow from that table and matter more than anything else here:

1. **A tag push does not create a published release.** It creates a draft. A
   human presses Publish.
2. **Publishing that draft is what starts npm and the offline bundle.** A
   release published by a workflow using `GITHUB_TOKEN` does not fire
   `release: published` -- GitHub refuses to re-trigger on its own token -- so
   there is no way around the button that does not involve storing a long-lived
   PAT.

The version in `Cargo.toml` is the single source of truth. `package.json`,
`package-lock.json`, `Cargo.lock` and the three `packaging/` templates all have
to agree with it, and CI fails if they do not.

## Setup you must do by hand

One-time. None of this can be automated from inside the repository.

### 1. Repository settings

- **Settings -> Actions -> General -> Workflow permissions**: read-only default
  is fine. Every workflow requests what it needs per job.
- Nothing else. There are no repository secrets: `release.yml` uses only the
  run-scoped `GITHUB_TOKEN` plus OIDC, and `npm-publish.yml` uses only OIDC.
  `id-token: write` is granted in the workflow files themselves and needs no
  repository-level switch.

### 2. npm: create the scope, bootstrap the six packages, then hand over to OIDC

`npm-publish.yml` publishes with `npm publish --provenance` and no token, using
npm trusted publishing. npm can only be told to trust a workflow *for a package
that already exists* -- the setting lives on the package's own settings page.
So the first version of each name has to go up by hand. This is the only time a
token touches these packages, and the only versions without npm provenance.

```bash
# 1. Create the organisation/scope, once, on npmjs.com:
#    https://www.npmjs.com/org/create  ->  name it "tokencount"

# 2. Create a granular access token with publish rights, and log in with it.
npm login

# 3. Stage and publish each of the six packages once, at the real version.
#    This needs the release archives, so cut the v1.0.1 release first (see
#    below) and let it attach its assets, then:
gh release download v1.0.1 --dir dist/release-artifacts \
  --pattern 'tokencount-*' --pattern 'SHA256SUMS'
node scripts/build-npm-packages.mjs --artifacts dist/release-artifacts

for dir in dist/npm/@tokencount/*; do
  npm publish "$dir" --access public
done
npm publish dist/npm/tokencount --access public

# 4. Revoke the token.
```

Then, for each of the six packages on npmjs.com:

> Package page -> Settings -> Trusted publisher -> GitHub Actions
> Organization or user: `eordano`
> Repository: `tokencount`
> Workflow filename: `npm-publish.yml`

From the next release on, `npm-publish.yml` publishes them itself with no
credential at all. Until you have done this, the workflow's preflight step
fails and tells you so by name; it does not die on an opaque auth error.

### 3. Homebrew: create the tap repository

```bash
gh repo create eordano/homebrew-tap --public \
  --description "Homebrew formulae for eordano's tools"
git clone https://github.com/eordano/homebrew-tap
mkdir -p homebrew-tap/Formula
```

The formula file goes at `Formula/tokencount.rb`. `brew install
eordano/tap/tokencount` resolves `eordano/tap` to `github.com/eordano/homebrew-tap`
automatically -- the `homebrew-` prefix is the convention, not a typo.

### 4. Scoop: create the bucket repository

```bash
gh repo create eordano/scoop-bucket --public \
  --description "Scoop bucket for eordano's tools"
git clone https://github.com/eordano/scoop-bucket
mkdir -p scoop-bucket/bucket
```

The manifest goes at `bucket/tokencount.json`. Users then run
`scoop bucket add eordano https://github.com/eordano/scoop-bucket`.

### 5. WinGet: fork microsoft/winget-pkgs

```bash
gh repo fork microsoft/winget-pkgs --clone
```

Manifests go under `manifests/e/eordano/tokencount/<version>/`. Every version
is a pull request against Microsoft's repository and is reviewed before it goes
live, so this channel always lags by a day or two.

### 6. crates.io

Nothing to do. `Cargo.toml` sets `publish = false`, deliberately -- see
[What is deliberately not automated](#what-is-deliberately-not-automated).
There is no crates.io trusted publisher to configure and no `cargo publish` job.

## Cutting a release

Worked example: v1.0.2.

### 1. Bump the version and re-stamp everything

```bash
# Cargo.toml is the source of truth -- edit its [package] version by hand.
$EDITOR Cargo.toml

# Propagate it to package.json, package-lock.json and Cargo.lock.
node scripts/build-npm-packages.mjs --root-only --stamp

# The packaging templates hardcode the version too; bump them by hand.
$EDITOR packaging/homebrew/tokencount.rb        # version + four url lines
$EDITOR packaging/scoop/tokencount.json         # version + the 64bit url
$EDITOR packaging/winget/*.yaml                 # PackageVersion, InstallerUrl,
                                                # ReleaseNotesUrl
```

Then confirm nothing was missed -- this is exactly what CI runs:

```bash
node scripts/build-npm-packages.mjs --check
node scripts/build-packaging-manifests.mjs --check
node scripts/fetch-models.mjs --verify-pins
```

Commit and merge to `main` in the normal way, and let CI go green. CI compiles
the Rust crate on Linux and Windows, so a `build.rs` or `Cargo.lock` problem
surfaces here rather than after the tag is public.

### 2. Tag

```bash
git tag -a v1.0.2 -m "tokencount 1.0.2"
git push origin v1.0.2
```

`release.yml` now:

- refuses to continue unless the tag is exactly `v<Cargo.toml version>` and
  `Cargo.lock` is in sync (`cargo metadata --locked`),
- fetches the eight vendor tokenizer tables at pinned digests, cross-checked
  against `flake.nix`,
- builds all five targets with `--locked`, asserts all 9 tokenizers were
  embedded, asserts the musl binaries are static and that `tokencount.exe`
  imports no Visual C++ redistributable DLL,
- smoke-tests four of the five on their own architecture,
- writes `SHA256SUMS`, signs one build-provenance attestation covering every
  archive, and
- creates the release **as a draft** with the archives attached.

Watch it: `gh run watch`. It takes a while -- five from-scratch release builds
with `lto = true` and `codegen-units = 1`.

### 3. Publish the draft

Releases page -> the `v1.0.2` draft -> edit the notes if you want -> Publish.

That single click starts `npm-publish.yml` and `offline-bundle.yml`. Do not
create the release from the UI with a new tag: that fires the tag push and the
publish at the same instant, and npm-publish will sit waiting up to an hour for
archives that have not been built yet.

### 4. Check what landed

```bash
gh release view v1.0.2

# provenance, the way a user would
gh attestation verify tokencount-1.0.2-x86_64-unknown-linux-musl.tar.gz \
  --repo eordano/tokencount \
  --signer-workflow eordano/tokencount/.github/workflows/release.yml

npm view tokencount@1.0.2 version
npm view @tokencount/linux-x64@1.0.2 version
```

## After the release: the three external channels

Homebrew, Scoop and WinGet live in repositories this one cannot write to, so
the release workflow renders the manifests and leaves them for you. Download
them from the run:

```bash
gh run download --name packaging-manifests --dir ./packaging-out
```

You get `homebrew/tokencount.rb`, `scoop/tokencount.json` and the three
`winget/*.yaml`, all with the real digests from this release's `SHA256SUMS`.
(You can regenerate them locally at any time from a downloaded `SHA256SUMS`:
`node scripts/build-packaging-manifests.mjs --sums SHA256SUMS --out dist/packaging`
and `packaging/homebrew/update-formula.sh --version 1.0.2 --sums SHA256SUMS
--output dist/packaging/homebrew/tokencount.rb`.)

**Homebrew:**

```bash
cp packaging-out/homebrew/tokencount.rb ../homebrew-tap/Formula/tokencount.rb
cd ../homebrew-tap && git commit -am "tokencount 1.0.2" && git push
brew install --build-from-source eordano/tap/tokencount   # sanity check
brew test tokencount
```

**Scoop:**

```bash
cp packaging-out/scoop/tokencount.json ../scoop-bucket/bucket/tokencount.json
cd ../scoop-bucket && git commit -am "tokencount 1.0.2" && git push
```

After the first publish you can let Scoop do it instead: in the bucket
checkout, `bin/checkver.ps1 tokencount -u` follows `checkver` to the newest
release, rewrites the url from the `autoupdate` block and pulls the digest out
of `SHA256SUMS`.

**WinGet:**

```bash
mkdir -p ../winget-pkgs/manifests/e/eordano/tokencount/1.0.2
cp packaging-out/winget/*.yaml ../winget-pkgs/manifests/e/eordano/tokencount/1.0.2/
cd ../winget-pkgs
git checkout -b eordano.tokencount-1.0.2
git add manifests/e/eordano/tokencount/1.0.2
git commit -m "New version: eordano.tokencount version 1.0.2"
git push -u origin eordano.tokencount-1.0.2
gh pr create --repo microsoft/winget-pkgs --fill
```

`winget validate --manifest <dir>` and `winget install --manifest <dir>` check
it locally first, on a Windows machine.

## What is deliberately not automated

Honest list of the gaps. None of these are oversights.

**crates.io.** `Cargo.toml` sets `publish = false`. Eight of the nine tokenizer
tables are vendor files this repository cannot redistribute -- four of the seven
HuggingFace sources declare no license at all, and DeepSeek's and Gemma's
upstream terms add use-based restrictions that AGPL-3.0 section 7 forbids -- and
they total roughly 90 MB against crates.io's 10 MiB package limit. A crate on
crates.io could therefore only ever build a Claude-only binary. `cargo binstall
--git https://github.com/eordano/tokencount tokencount` is the supported path
from a Rust toolchain; it downloads a release archive rather than compiling.
Because there is no crates.io entry, `cargo binstall tokencount` by bare name
will not resolve.

**Code signing and notarization.** The macOS binaries are not signed with an
Apple Developer ID and not notarized; the Windows executable is not
Authenticode-signed. Downloads through `curl`, `npm`, `brew` or the install
scripts carry no quarantine attribute and run normally, but a *browser*
download of the macOS tarball is Gatekeeper-blocked until the user clears
`com.apple.quarantine`, and Windows SmartScreen will warn about the unsigned
executable. Fixing this needs a paid Apple Developer account and a code-signing
certificate, plus somewhere to keep the keys -- which would be the first
long-lived secret in this pipeline. The build-provenance attestation is what
this project offers instead: it proves origin, which is the property signing is
usually bought for, without a key to leak.

**Pushing to the tap, the bucket and winget-pkgs.** All three are separate
repositories. `GITHUB_TOKEN` is scoped to this one, so writing to them needs a
long-lived cross-repository PAT. Rendering the manifests into an artifact and
letting a human open three PRs was chosen over storing that token.

**Publishing the GitHub release itself.** See the note at the top: a workflow
cannot publish it and still have `release: published` fire.

**The first npm publish of each package.** npm's trusted-publisher model does
not allow it. See [step 2](#2-npm-create-the-scope-bootstrap-the-six-packages-then-hand-over-to-oidc).

**A pinned Rust toolchain.** The release builds use `stable`, whatever that is
on the day. Dependencies are pinned by `--locked`, but two builds of the same
tag can use different compilers. Add a `rust-toolchain.toml` if bit-for-bit
reproducibility across time matters more than getting compiler fixes for free.

**`aarch64-pc-windows-msvc`.** Not built. Windows 11 on ARM runs the x64 build
under emulation, and `install.ps1` says so when it detects an ARM64 host.

## When something goes wrong

**The tag is pushed and `release.yml` failed.** Nothing is public yet -- a
failed run creates no release. Fix, then `git tag -d v1.0.2 && git push --delete
origin v1.0.2`, re-tag and push again. Or, if the tag is fine and only the
workflow was flaky: Actions -> Release -> Run workflow -> tag `v1.0.2`, which
does exactly the same thing against the existing tag.

**`Cargo.lock is out of date for this Cargo.toml`.** You bumped `Cargo.toml`
without re-stamping. `node scripts/build-npm-packages.mjs --root-only --stamp`,
commit, re-tag.

**A model digest mismatch.** An upstream vendor moved a `tokenizer.json`. This
is a hard stop by design: the binary would otherwise quietly start tokenizing
differently. Verify the new file by hand, then update **both**
`scripts/fetch-models.mjs` and `flake.nix` -- `--verify-pins` fails if only one
moves.

**`npm-publish.yml` timed out waiting for the archives.** The release was
published before `release.yml` finished. Once the assets are attached, Actions
-> Publish to npm -> Run workflow -> tag `v1.0.2`.

**npm publish failed with an authentication error.** Either the bootstrap in
[step 2](#2-npm-create-the-scope-bootstrap-the-six-packages-then-hand-over-to-oidc)
has not been done, or a trusted publisher points at the wrong workflow file.
The preflight step names the packages it could not find.

**A dry run.** Actions -> Release -> Run workflow with an *empty* tag input
builds, packages, checksums and renders the packaging manifests without
attesting anything or touching a release. Actions -> Publish to npm -> Run
workflow with `dry_run` checked does `npm publish --dry-run`.
