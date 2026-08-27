# Installing tokencount

The `tokencount` CLI is a single native binary. All 9 tokenizer tables are
compiled into it, so there are no runtime data files, no model downloads, no
network access and no dependencies -- you copy one file and it works, offline,
in under a millisecond.

Prebuilt binaries are published for five targets. Every one of them is
checksummed and carries a GitHub build-provenance attestation, so you can prove
the file you downloaded came out of this repository's release workflow before
you run it. See [Verify what you downloaded](#verify-what-you-downloaded).

- [Supported platforms](#supported-platforms)
- [Which method should I use?](#which-method-should-i-use)
- [npm](#npm) · [Homebrew](#homebrew) · [Scoop](#scoop-windows) ·
  [WinGet](#winget-windows)
- [Shell installer](#shell-installer-macos-and-linux) ·
  [PowerShell installer](#powershell-installer-windows)
- [cargo-binstall](#cargo-binstall) · [Nix](#nix)
- [Manual download](#manual-download)
- [Verify what you downloaded](#verify-what-you-downloaded)
- [Building from source](#building-from-source)
- [The other artifacts](#the-other-artifacts)
- [Upgrading and uninstalling](#upgrading-and-uninstalling)
- [Troubleshooting](#troubleshooting)

## Supported platforms

| Platform | Rust target | Release asset |
|---|---|---|
| Linux x86_64 | `x86_64-unknown-linux-musl` | `tokencount-<version>-x86_64-unknown-linux-musl.tar.gz` |
| Linux aarch64 | `aarch64-unknown-linux-musl` | `tokencount-<version>-aarch64-unknown-linux-musl.tar.gz` |
| macOS Intel | `x86_64-apple-darwin` | `tokencount-<version>-x86_64-apple-darwin.tar.gz` |
| macOS Apple Silicon | `aarch64-apple-darwin` | `tokencount-<version>-aarch64-apple-darwin.tar.gz` |
| Windows x86_64 | `x86_64-pc-windows-msvc` | `tokencount-<version>-x86_64-pc-windows-msvc.zip` |

`<version>` is the bare version (`1.0.1`); the git tag it is built from carries
a `v` prefix (`v1.0.1`). Each archive holds the bare binary (`tokencount`, or
`tokencount.exe` on Windows) at its root, plus `LICENSE` and `README.md`.

The Linux builds are statically linked against musl -- no glibc version floor,
so they run on any distribution, including ones older than the machine that
built them. Windows on ARM runs the x86_64 build under emulation; there is no
native `aarch64-pc-windows-msvc` build yet.

## Which method should I use?

| Method | Platforms | Verifies the download | Notes |
|---|---|---|---|
| [npm](#npm) | all five | npm registry integrity + provenance | no Node runtime cost; the binary is native |
| [Homebrew](#homebrew) | macOS, Linux | formula checksum | `brew upgrade` keeps it current |
| [Scoop](#scoop-windows) / [WinGet](#winget-windows) | Windows | manifest checksum | integrates with the OS package manager |
| [Shell / PowerShell installer](#shell-installer-macos-and-linux) | macOS, Linux, Windows | SHA256 against `SHA256SUMS` | no package manager needed |
| [cargo-binstall](#cargo-binstall) | all five | no (see the section) | for Rust toolchains |
| [Nix](#nix) | Linux, macOS | pinned hashes, built from source | reproducible |
| [Manual download](#manual-download) | all five | whatever you check, including `gh attestation verify` | the most auditable path |

There is deliberately no `cargo install tokencount` --
[here is why](#why-there-is-no-cargo-install-tokencount).

## npm

```bash
npx tokencount --help          # run it without installing
npm install -g tokencount      # install it on PATH
```

This does not run a Node tokenizer. The `tokencount` package is a tiny launcher
that execs the native binary and forwards stdio, signals and the exit status;
the binary itself arrives in one platform-specific optional dependency, and npm
installs only the one matching your machine:

| `process.platform` / `process.arch` | Package |
|---|---|
| `linux` / `x64` | `@tokencount/linux-x64` |
| `linux` / `arm64` | `@tokencount/linux-arm64` |
| `darwin` / `x64` | `@tokencount/darwin-x64` |
| `darwin` / `arm64` | `@tokencount/darwin-arm64` |
| `win32` / `x64` | `@tokencount/win32-x64` |

There is no `postinstall` script and nothing is fetched after install: the
binary ships inside the package, so `npm ci --ignore-scripts` and offline caches
work normally. Node 18 or newer is required to run the launcher.

Every version after the first is published from the release workflow with
`npm publish --provenance` over OIDC trusted publishing -- no stored npm token
-- so it carries its own npm provenance statement, visible on the package page
and checkable in a project that depends on it:

```bash
npm audit signatures
```

The *first* version of each of the six names had to be published by hand: npm
configures a trusted publisher on a package's own settings page, so the package
must exist before the workflow can be trusted with it. Those six bootstrap
publishes are the only ones that used a token and the only ones without
provenance. `RELEASE-PACKAGING.md` records the procedure.

To point the launcher at a binary you installed some other way -- a local build,
or a binary you verified by hand:

```bash
TOKENCOUNT_BINARY_PATH=/path/to/tokencount npx tokencount --help
```

## Homebrew

```bash
brew install eordano/tap/tokencount
```

Works on macOS (Intel and Apple Silicon) and on Homebrew for Linux. The formula
downloads the same release archive documented above and checks it against the
checksum recorded in the tap.

```bash
brew upgrade eordano/tap/tokencount
brew uninstall tokencount
```

The formula lives in the `eordano/homebrew-tap` repository, not in this one, so
it can trail a release by a little -- and until that repository exists and has
been populated for the first time, `brew install` will report no available
formula. If `brew install` cannot find it, the
release archives are already up on the
[releases page](https://github.com/eordano/tokencount/releases) and the
[shell installer](#shell-installer-macos-and-linux) will fetch the newest one.

## Scoop (Windows)

```powershell
scoop bucket add eordano https://github.com/eordano/scoop-bucket
scoop install tokencount
```

```powershell
scoop update tokencount
scoop uninstall tokencount
```

## WinGet (Windows)

```powershell
winget install eordano.tokencount
```

```powershell
winget upgrade eordano.tokencount
winget uninstall eordano.tokencount
```

The Scoop manifest and the WinGet manifest are likewise maintained outside this
repository -- in `eordano/scoop-bucket` and in Microsoft's `winget-pkgs`, whose
submissions are reviewed before they go live. Either can lag a release by a day
or two, and neither works at all until that first bucket/PR lands. When it
matters, use the [PowerShell installer](#powershell-installer-windows), which
reads the release directly.

`tokencount.exe` links the MSVC runtime statically
(`-C target-feature=+crt-static` in the release workflow), so it needs no
Visual C++ redistributable -- on a clean Windows install it is genuinely one
file with nothing beside it.

## Shell installer (macOS and Linux)

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://tokencount.eordano.com/packaging/install.sh | sh
```

The script detects your target (correcting for Rosetta 2, so an Apple Silicon
Mac gets the arm64 build even when the shell reports `x86_64`), downloads the
matching archive together with the release's `SHA256SUMS`, and **verifies the
archive before anything is written to your install prefix**. A mismatch aborts
with a non-zero exit and installs nothing.

It installs to `/usr/local/bin` when that directory exists and is writable, and
to `$HOME/.local/bin` otherwise, warning you if the chosen directory is not on
your `PATH`. It never edits your shell profile.

Flags, when you run the script rather than pipe it:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://tokencount.eordano.com/packaging/install.sh -o install.sh
less install.sh                                  # read before you run
sh install.sh --version 1.0.1 --bin-dir "$HOME/.local/bin"
```

| Flag | Environment variable | Default |
|---|---|---|
| `--version <x.y.z>` | `TOKENCOUNT_VERSION` | the latest GitHub release |
| `--bin-dir <dir>` | `TOKENCOUNT_BIN_DIR` | `/usr/local/bin`, else `$HOME/.local/bin` |
| `--repo <owner/name>` | `TOKENCOUNT_REPO` | `eordano/tokencount` |

Piping into `sh` cannot pass flags, so use the environment variables in that
form:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://tokencount.eordano.com/packaging/install.sh \
  | TOKENCOUNT_VERSION=1.0.1 TOKENCOUNT_BIN_DIR="$HOME/.local/bin" sh
```

Pinning `--version` also skips a call to the GitHub API, which rate-limits
unauthenticated requests -- worth doing in CI.

## PowerShell installer (Windows)

```powershell
irm https://tokencount.eordano.com/packaging/install.ps1 | iex
```

Same guarantee as the shell installer: the archive is checked against the
release's `SHA256SUMS` before the executable is unpacked into place, and a
mismatch leaves nothing behind. It installs to
`%LOCALAPPDATA%\Programs\tokencount\bin`, adds that directory to your **user**
`PATH` (not the system one, so no elevation is needed), and clears the
mark-of-the-web from the extracted `tokencount.exe`.

To pass parameters, create a scriptblock instead of piping to `iex`:

```powershell
& ([scriptblock]::Create((irm https://tokencount.eordano.com/packaging/install.ps1))) -Version 1.0.1
& ([scriptblock]::Create((irm https://tokencount.eordano.com/packaging/install.ps1))) -NoModifyPath
```

Or set the environment variables, which the piped form honours:
`TOKENCOUNT_VERSION`, `TOKENCOUNT_BIN_DIR`, `TOKENCOUNT_REPO`.

## cargo-binstall

```bash
cargo binstall --git https://github.com/eordano/tokencount tokencount
```

[cargo-binstall](https://github.com/cargo-bins/cargo-binstall) reads the
`[package.metadata.binstall]` table in `Cargo.toml` and pulls exactly the
release archives described above -- it downloads a prebuilt binary rather than
compiling one.

The `--git` form is required because tokencount is not published to crates.io
([why](#why-there-is-no-cargo-install-tokencount)); binstall has no registry
entry to resolve the name from.

cargo-binstall does not check `SHA256SUMS` and does not check the provenance
attestation. If that matters to you, take the [manual](#manual-download) path
instead and verify explicitly.

## Nix

```bash
nix run github:eordano/tokencount -- --help          # run without installing
nix profile install github:eordano/tokencount        # install into your profile
nix build github:eordano/tokencount                  # ./result/bin/tokencount
```

The flake fetches every tokenizer table at a pinned hash and compiles them in,
so this builds the same fully-populated binary the release workflow ships --
from source, on your machine, with no trust in the release assets at all.

## Manual download

Everything is on the
[releases page](https://github.com/eordano/tokencount/releases). The full,
verified sequence on macOS or Linux:

```bash
VERSION=1.0.1
TARGET=x86_64-unknown-linux-musl        # see the platform table above
ASSET="tokencount-$VERSION-$TARGET.tar.gz"
BASE="https://github.com/eordano/tokencount/releases/download/v$VERSION"

curl --proto '=https' --tlsv1.2 -fsSLO "$BASE/$ASSET"
curl --proto '=https' --tlsv1.2 -fsSLO "$BASE/SHA256SUMS"

# 1. checksum -- shasum is on macOS and most Linux; see the note below
grep "  $ASSET\$" SHA256SUMS | shasum -a 256 -c -

# 2. provenance -- who built it, from what source
gh attestation verify "$ASSET" --repo eordano/tokencount

# 3. only now, unpack and install
tar -xzf "$ASSET"
mkdir -p "$HOME/.local/bin"
install -m 0755 tokencount "$HOME/.local/bin/tokencount"
tokencount --version
```

On Linux with GNU coreutils, step 1 can also be
`sha256sum --ignore-missing -c SHA256SUMS`, which checks every asset you
happen to have downloaded into the directory in one go.

On Windows:

```powershell
$Version = '1.0.1'
$Target  = 'x86_64-pc-windows-msvc'
$Asset   = "tokencount-$Version-$Target.zip"
$Base    = "https://github.com/eordano/tokencount/releases/download/v$Version"

Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset"      -OutFile $Asset
Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS"  -OutFile SHA256SUMS

# 1. checksum
$expected = (Select-String -Path SHA256SUMS -SimpleMatch $Asset).Line.Split(' ')[0].ToLower()
$actual   = (Get-FileHash -Path $Asset -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "checksum mismatch for $Asset" }

# 2. provenance
gh attestation verify $Asset --repo eordano/tokencount

# 3. unpack
Expand-Archive -Path $Asset -DestinationPath .
.\tokencount.exe --version
```

## Verify what you downloaded

### Checksums

`SHA256SUMS` is a single coreutils-format file covering every archive in the
release. It is a convenience, not the trust anchor: anyone who can replace an
archive on the release can replace the checksum file next to it. Use it to
catch a corrupted or truncated download, and use the attestation below to
catch a substituted one.

### Build provenance

Every release archive is covered by a
[GitHub build-provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
-- a Sigstore-signed, transparency-logged statement generated inside the release
workflow using a short-lived OIDC identity. There is no long-lived signing key
to leak.

```bash
gh attestation verify tokencount-1.0.1-x86_64-unknown-linux-musl.tar.gz \
  --repo eordano/tokencount
```

Stricter -- pin the exact workflow that is allowed to have produced it, so an
attestation minted by some *other* workflow in the repo is rejected:

```bash
gh attestation verify tokencount-1.0.1-x86_64-unknown-linux-musl.tar.gz \
  --repo eordano/tokencount \
  --signer-workflow eordano/tokencount/.github/workflows/release.yml
```

Verification needs `gh` 2.49 or newer, authenticated (`gh auth login`), because
the attestation bundle is fetched from GitHub's API. To verify later, or on a
machine with no GitHub access, download the bundle first and verify against it
offline:

```bash
gh attestation download tokencount-1.0.1-x86_64-unknown-linux-musl.tar.gz \
  --repo eordano/tokencount
gh attestation verify tokencount-1.0.1-x86_64-unknown-linux-musl.tar.gz \
  --repo eordano/tokencount \
  --bundle sha256:<digest>.jsonl
```

### What the attestation proves, and what it does not

It proves that this exact byte sequence was produced by the
`.github/workflows/release.yml` workflow in `eordano/tokencount`, running on a
GitHub-hosted runner, from a named commit and tag -- and that it has not been
altered since. If someone swaps an asset on the release page, or rebuilds one
on a laptop, verification fails. Note that verification works on the file's
digest, so it does not depend on `SHA256SUMS` being honest.

It does not prove the source code is correct, safe, or free of bugs, and it
says nothing about the upstream tokenizer tables the build embeds. It is a
statement about *origin*, not about *quality*.

## Building from source

### Why there is no `cargo install tokencount`

`Cargo.toml` sets `publish = false`. Eight of the nine tokenizer tables come
from model vendors under terms this repository cannot redistribute, and they
total roughly 90 MB against crates.io's 10 MiB package limit. A crate on
crates.io could therefore only ever build a Claude-only binary, which is not
the tool the name promises. The prebuilt release binaries are the supported
path; [cargo-binstall](#cargo-binstall) is how you get one from a Rust
toolchain.

### With Nix (fetches everything for you)

```bash
nix build github:eordano/tokencount
./result/bin/tokencount --version
```

### With cargo

`build.rs` compiles the tokenizer tables in from a directory you point it at,
and **fails the build** if any of them is missing -- listing each absent file
and the URL it comes from -- rather than silently producing a binary that
advertises 9 tokenizers and supports 1.

```bash
git clone https://github.com/eordano/tokencount.git
cd tokencount
TOKEN_COUNT_MODELS=/path/to/models cargo build --release --locked
```

The directory must be laid out as `o200k_base.tiktoken` plus
`<model>/tokenizer.json` for each of `gemini`, `deepseek`, `qwen`, `llama`,
`mistral`, `grok` and `minimax`. Run the build once with `TOKEN_COUNT_MODELS`
unset to have the error message print the exact filenames and source URLs.
`nix develop` sets the variable for you. Without Nix, the repo fetches the same
eight files at the same pinned digests:

```bash
node scripts/fetch-models.mjs ./models
TOKEN_COUNT_MODELS=./models cargo build --release --locked
```

To deliberately build the reduced, Claude-only binary -- the other eight models
then exit with an error when selected at runtime:

```bash
TOKENCOUNT_ALLOW_PARTIAL=1 cargo build --release --locked
```

## The other artifacts

The CLI is one of four ways to use tokencount, and the others need no install
at all:

- **Web app** -- <https://tokencount.eordano.com>
- **Offline single-file HTML** -- `tokencount-offline.tar.gz` on the release,
  or `npm install && npm run build:offline`. Opens from `file:///` with every
  model inlined.
- **Node.js CLI** -- `tokencount-cli.tar.gz` on the release, or
  `npm run build:cli`. Useful where a native binary is awkward; slower to boot
  than the Rust CLI, and it keeps its model data in files next to it.
- **Rust CLI** -- this document.

## Upgrading and uninstalling

| Installed with | Upgrade | Remove |
|---|---|---|
| npm | `npm install -g tokencount@latest` | `npm uninstall -g tokencount` |
| Homebrew | `brew upgrade eordano/tap/tokencount` | `brew uninstall tokencount` |
| Scoop | `scoop update tokencount` | `scoop uninstall tokencount` |
| WinGet | `winget upgrade eordano.tokencount` | `winget uninstall eordano.tokencount` |
| `install.sh` | re-run it | `rm $(command -v tokencount)` |
| `install.ps1` | re-run it | delete `%LOCALAPPDATA%\Programs\tokencount` and its `PATH` entry |
| cargo-binstall | re-run it | `cargo uninstall tokencount` |
| Nix profile | `nix profile upgrade tokencount` | `nix profile remove tokencount` |
| Manual | download the new archive | delete the binary |

## Troubleshooting

**`Error: <model> model not embedded (build with TOKEN_COUNT_MODELS)`** -- you
are running a partial build, not a release binary. Install a released one, or
rebuild with the model directory set. See
[Building from source](#building-from-source).

**macOS: "cannot be opened because the developer cannot be verified"** -- the
release binaries are not Apple-signed or notarised. Files downloaded with
`curl`, `npm`, `brew` or the install script are not quarantined and are
unaffected; a file downloaded through a browser is. Verify the download first,
then clear the quarantine attribute:

```bash
xattr -d com.apple.quarantine ./tokencount
```

**Windows: SmartScreen warns about an unrecognised app** -- same cause; the
executable is unsigned. `install.ps1` calls `Unblock-File` for you after the
checksum passes. Doing it by hand:

```powershell
Unblock-File -Path .\tokencount.exe
```

**`tokencount: command not found` right after installing** -- the install
directory is not on your `PATH`. The shell installer prints a warning when this
happens; add `$HOME/.local/bin` to `PATH` in your shell profile. On Windows,
open a new terminal so the updated user `PATH` is picked up.

**npm: "unsupported platform"** -- there is no prebuilt binary for your
platform/arch pair (see [Supported platforms](#supported-platforms)). Build
with [Nix](#nix) or [from source](#building-from-source), then point the
launcher at it with `TOKENCOUNT_BINARY_PATH`.

**The install script cannot find the latest release** -- unauthenticated
GitHub API requests are rate-limited. Pass an explicit
`--version` / `TOKENCOUNT_VERSION`.

**`gh attestation verify` fails** -- do not run the binary. Open an issue with
the asset name and the version you downloaded.
