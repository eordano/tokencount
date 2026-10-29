#!/bin/sh

set -eu

REPO="${TOKENCOUNT_REPO:-eordano/tokencount}"
BIN_NAME="tokencount"
VERSION="${TOKENCOUNT_VERSION:-latest}"
BIN_DIR="${TOKENCOUNT_BIN_DIR:-}"
DOWNLOADER=""
TMPDIR_TC=""

say() { printf 'tokencount: %s\n' "$1" >&2; }

err() {
  printf 'tokencount: error: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: install.sh [--version <x.y.z>] [--bin-dir <dir>] [--repo <owner/name>]

  --version   Release to install (default: the latest GitHub release).
  --bin-dir   Where to put the binary. Defaults to /usr/local/bin when it is
              writable, otherwise $HOME/.local/bin.
  --repo      GitHub repository to download from (default: eordano/tokencount).
USAGE
  exit 2
}

cleanup() {
  if [ -n "$TMPDIR_TC" ] && [ -d "$TMPDIR_TC" ]; then
    rm -rf "$TMPDIR_TC"
  fi
}

detect_target() {
  detect_os="$(uname -s)"
  detect_arch="$(uname -m)"

  if [ "$detect_os" = "Darwin" ] && [ "$detect_arch" = "x86_64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      detect_arch="arm64"
    fi
  fi

  case "$detect_os/$detect_arch" in
    Darwin/arm64) echo "aarch64-apple-darwin" ;;
    Darwin/x86_64) echo "x86_64-apple-darwin" ;;
    Linux/aarch64 | Linux/arm64) echo "aarch64-unknown-linux-musl" ;;
    Linux/x86_64 | Linux/amd64) echo "x86_64-unknown-linux-musl" ;;
    *)
      err "unsupported platform: $detect_os $detect_arch.
  Prebuilt binaries exist for macOS (arm64, x86_64) and Linux (aarch64, x86_64).
  Build one instead -- there is no 'cargo install tokencount', because the
  crate is not on crates.io and build.rs needs the vendor tokenizer tables:
    nix build github:$REPO
  or, from a clone:
    node scripts/fetch-models.mjs ./models
    TOKEN_COUNT_MODELS=./models cargo build --release --locked"
      ;;
  esac
}

detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
  else
    err "need curl or wget to download the release"
  fi
}

fetch() {
  case "$DOWNLOADER" in
    curl) curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" -- "$1" ;;
    wget) wget --https-only --secure-protocol=TLSv1_2 -q -O "$2" -- "$1" ;;
  esac || err "download failed: $1"
}

fetch_stdout() {
  case "$DOWNLOADER" in
    curl) curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -- "$1" ;;
    wget) wget --https-only --secure-protocol=TLSv1_2 -q -O - -- "$1" ;;
  esac || err "download failed: $1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  else
    err "need sha256sum, shasum or openssl to verify the download"
  fi
}

expected_sha() {
  awk -v want="$2" '
        {
            name = $2
            sub(/^\*/, "", name)
            if (name == want) { print tolower($1); found = 1; exit }
        }
        END { if (!found) exit 1 }
    ' "$1"
}

verify_attestation() {
  if ! command -v gh >/dev/null 2>&1; then
    say "note: install the GitHub CLI and re-run to also verify build provenance"
    return 0
  fi
  if ! gh auth status >/dev/null 2>&1; then
    say "note: 'gh auth login' would let this script also verify build provenance"
    return 0
  fi
  if ! gh attestation verify "$1" --repo "$REPO" >/dev/null 2>&1; then
    err "build provenance verification failed for $(basename "$1").
  This archive does not carry an attestation from $REPO's release workflow.
  Nothing was installed. Do not use this download."
  fi
  say "build provenance verified"
}

resolve_version() {
  resolve_tag="$(
    fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -n 1
  )"
  if [ -z "$resolve_tag" ]; then
    err "could not determine the latest release of $REPO.
  Either the repository has no published release yet, or the GitHub API
  rate-limited this unauthenticated request. Pass an explicit
  --version <x.y.z> to skip the lookup."
  fi
  printf '%s\n' "${resolve_tag#v}"
}

choose_bin_dir() {
  if [ -n "$BIN_DIR" ]; then
    printf '%s\n' "$BIN_DIR"
    return
  fi
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    printf '%s\n' /usr/local/bin
    return
  fi
  printf '%s\n' "$HOME/.local/bin"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || usage
        VERSION="$2"
        shift 2
        ;;
      --version=*)
        VERSION="${1#--version=}"
        shift
        ;;
      --bin-dir)
        [ $# -ge 2 ] || usage
        BIN_DIR="$2"
        shift 2
        ;;
      --bin-dir=*)
        BIN_DIR="${1#--bin-dir=}"
        shift
        ;;
      --repo)
        [ $# -ge 2 ] || usage
        REPO="$2"
        shift 2
        ;;
      --repo=*)
        REPO="${1#--repo=}"
        shift
        ;;
      -h | --help) usage ;;
      *) err "unknown argument: $1" ;;
    esac
  done

  detect_downloader
  target="$(detect_target)"

  if [ "$VERSION" = "latest" ]; then
    VERSION="$(resolve_version)"
  fi
  VERSION="${VERSION#v}"

  asset="$BIN_NAME-$VERSION-$target.tar.gz"
  base="https://github.com/$REPO/releases/download/v$VERSION"

  TMPDIR_TC="$(mktemp -d "${TMPDIR:-/tmp}/tokencount-install.XXXXXX")"
  trap cleanup EXIT INT TERM

  say "downloading $asset"
  fetch "$base/$asset" "$TMPDIR_TC/$asset"
  fetch "$base/SHA256SUMS" "$TMPDIR_TC/SHA256SUMS"

  want="$(expected_sha "$TMPDIR_TC/SHA256SUMS" "$asset")" ||
    err "$asset is not listed in SHA256SUMS for v$VERSION -- refusing to install"
  got="$(sha256_of "$TMPDIR_TC/$asset")"
  if [ "$want" != "$got" ]; then
    err "checksum mismatch for $asset
  expected $want
  got      $got
  Nothing was installed. Do not use this download."
  fi
  say "sha256 verified"

  verify_attestation "$TMPDIR_TC/$asset"

  tar -xzf "$TMPDIR_TC/$asset" -C "$TMPDIR_TC" ||
    err "could not extract $asset"
  [ -f "$TMPDIR_TC/$BIN_NAME" ] ||
    err "$asset did not contain a $BIN_NAME binary"

  bin_dir="$(choose_bin_dir)"
  mkdir -p "$bin_dir" || err "could not create $bin_dir"
  if [ ! -w "$bin_dir" ]; then
    err "$bin_dir is not writable.
  Re-run with --bin-dir \"\$HOME/.local/bin\", or with sudo."
  fi

  chmod 0755 "$TMPDIR_TC/$BIN_NAME"
  mv -f "$TMPDIR_TC/$BIN_NAME" "$bin_dir/$BIN_NAME.new"
  mv -f "$bin_dir/$BIN_NAME.new" "$bin_dir/$BIN_NAME"

  if ! reported="$("$bin_dir/$BIN_NAME" --version 2>&1)"; then
    err "installed $bin_dir/$BIN_NAME but it does not run:
  $reported"
  fi
  say "installed $bin_dir/$BIN_NAME ($reported)"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) say "warning: $bin_dir is not on your PATH -- add it to your shell profile" ;;
  esac
}

main "$@"
