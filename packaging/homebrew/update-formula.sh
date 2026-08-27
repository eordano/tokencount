#!/usr/bin/env bash
#
# Regenerate the url, version and sha256 lines of the Homebrew formula from a
# release's SHA256SUMS.
#
#   packaging/homebrew/update-formula.sh --version 1.2.0
#   packaging/homebrew/update-formula.sh --version 1.2.0 --sums ./SHA256SUMS
#   packaging/homebrew/update-formula.sh --version 1.2.0 --output ../homebrew-tap/Formula/tokencount.rb
#   packaging/homebrew/update-formula.sh --version 1.2.0 --check
#
# The formula is rewritten in place rather than re-rendered from a template
# here, so the two cannot drift: every url line in the formula is matched
# against the four Unix target triples, and the sha256 line following it is
# replaced with that target's digest from SHA256SUMS.
#
# In a release workflow, run this after the assets are uploaded and commit the
# result to the tap repository (see the note at the bottom of this file).

set -euo pipefail

REPO="${TOKENCOUNT_REPO:-eordano/tokencount}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FORMULA="$SCRIPT_DIR/tokencount.rb"
OUTPUT=""
SUMS=""
VERSION=""
CHECK=0

# The four Unix targets the formula covers. Windows ships through Scoop and
# winget instead, so its zip is deliberately not consulted here.
TARGETS=(
    aarch64-apple-darwin
    x86_64-apple-darwin
    aarch64-unknown-linux-musl
    x86_64-unknown-linux-musl
)

die() {
    printf 'update-formula: error: %s\n' "$1" >&2
    exit 1
}

usage() {
    sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        -v | --version)
            [ $# -ge 2 ] || usage
            VERSION="$2"
            shift 2
            ;;
        -s | --sums)
            [ $# -ge 2 ] || usage
            SUMS="$2"
            shift 2
            ;;
        -f | --formula)
            [ $# -ge 2 ] || usage
            FORMULA="$2"
            shift 2
            ;;
        -o | --output)
            [ $# -ge 2 ] || usage
            OUTPUT="$2"
            shift 2
            ;;
        -r | --repo)
            [ $# -ge 2 ] || usage
            REPO="$2"
            shift 2
            ;;
        --check)
            CHECK=1
            shift
            ;;
        -h | --help) usage ;;
        *) die "unknown argument: $1" ;;
    esac
done

if [ -z "$VERSION" ]; then
    cargo_toml="$SCRIPT_DIR/../../Cargo.toml"
    [ -f "$cargo_toml" ] || die "no --version given and $cargo_toml not found"
    VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$cargo_toml" | head -n 1)"
    [ -n "$VERSION" ] || die "could not read version from $cargo_toml"
fi
VERSION="${VERSION#v}"

[ -f "$FORMULA" ] || die "formula not found: $FORMULA"
[ -n "$OUTPUT" ] || OUTPUT="$FORMULA"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

if [ -z "$SUMS" ]; then
    SUMS="$workdir/SHA256SUMS"
    url="https://github.com/$REPO/releases/download/v$VERSION/SHA256SUMS"
    printf 'update-formula: fetching %s\n' "$url" >&2
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$SUMS" -- "$url" ||
        die "could not download $url -- is the v$VERSION release published?"
fi
[ -f "$SUMS" ] || die "checksum file not found: $SUMS"

# target=digest pairs, one per line, for the awk pass.
map=""
for target in "${TARGETS[@]}"; do
    asset="tokencount-$VERSION-$target.tar.gz"
    digest="$(
        awk -v want="$asset" '
            { name = $2; sub(/^\*/, "", name)
              if (name == want) { print tolower($1); found = 1; exit } }
            END { if (!found) exit 1 }
        ' "$SUMS"
    )" || die "$asset is not listed in $SUMS"
    case "$digest" in
        [0-9a-f]*) [ "${#digest}" -eq 64 ] || die "malformed digest for $asset: $digest" ;;
        *) die "malformed digest for $asset: $digest" ;;
    esac
    map="$map$target=$digest"$'\n'
done

awk -v ver="$VERSION" -v repo="$REPO" -v map="$map" '
BEGIN {
    n = split(map, lines, "\n")
    for (i = 1; i <= n; i++) {
        if (lines[i] == "") continue
        split(lines[i], kv, "=")
        digest[kv[1]] = kv[2]
        order[++count] = kv[1]
    }
    replaced = 0
    pending = ""
}
/^[[:space:]]*version "/ {
    sub(/version "[^"]*"/, "version \"" ver "\"")
    print
    next
}
/^[[:space:]]*url "/ {
    hit = ""
    for (i = 1; i <= count; i++) {
        if (index($0, order[i]) > 0) hit = order[i]
    }
    if (hit != "") {
        indent = $0; sub(/[^ ].*/, "", indent)
        printf "%surl \"https://github.com/%s/releases/download/v%s/tokencount-%s-%s.tar.gz\"\n",
            indent, repo, ver, ver, hit
        pending = hit
        next
    }
    print
    next
}
/^[[:space:]]*sha256 "/ {
    if (pending != "") {
        indent = $0; sub(/[^ ].*/, "", indent)
        printf "%ssha256 \"%s\"\n", indent, digest[pending]
        replaced++
        pending = ""
        next
    }
    print
    next
}
{ print }
END {
    if (replaced != count) {
        printf "update-formula: error: rewrote %d of %d sha256 lines\n", replaced, count > "/dev/stderr"
        exit 1
    }
}
' "$FORMULA" > "$workdir/tokencount.rb" || die "rewrite failed -- is $FORMULA still shaped as expected?"

if grep -q 'sha256 "0\{64\}"' "$workdir/tokencount.rb"; then
    die "the rewritten formula still contains a placeholder digest"
fi

if command -v ruby >/dev/null 2>&1; then
    ruby -c "$workdir/tokencount.rb" >/dev/null || die "the rewritten formula is not valid Ruby"
fi

if [ "$CHECK" -eq 1 ]; then
    if cmp -s "$workdir/tokencount.rb" "$OUTPUT"; then
        printf 'update-formula: %s is up to date for v%s\n' "$OUTPUT" "$VERSION" >&2
        exit 0
    fi
    printf 'update-formula: %s is stale for v%s:\n' "$OUTPUT" "$VERSION" >&2
    diff -u "$OUTPUT" "$workdir/tokencount.rb" >&2 || true
    exit 1
fi

mkdir -p "$(dirname -- "$OUTPUT")"
cp "$workdir/tokencount.rb" "$OUTPUT"
printf 'update-formula: wrote %s for v%s\n' "$OUTPUT" "$VERSION" >&2

# Release-workflow usage (the workflow file itself lives in .github/workflows):
#
#   - name: Update the Homebrew tap
#     run: |
#       packaging/homebrew/update-formula.sh \
#         --version "${VERSION}" \
#         --sums dist/SHA256SUMS \
#         --output tap/Formula/tokencount.rb
#
# with tap/ a checkout of eordano/homebrew-tap, then commit and push that
# checkout. --sums points at the SHA256SUMS the release job already built, so
# the step does not wait on GitHub's release assets becoming downloadable.
