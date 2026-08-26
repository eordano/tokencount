# Homebrew formula for the tokencount CLI, for the eordano/homebrew-tap tap.
#
#   brew install eordano/tap/tokencount
#
# Homebrew is also the friction-free way onto macOS: brew fetches with curl,
# and curl -- unlike a browser -- never attaches the com.apple.quarantine
# extended attribute. The binary therefore runs straight away instead of
# raising the "cannot be opened because the developer cannot be verified"
# Gatekeeper dialog that a Safari or Chrome download of the same tarball
# produces. tokencount is not notarized, so that difference matters.
#
# The four sha256 values change with every release. Do not hand-edit them:
# run packaging/homebrew/update-formula.sh, which reads them out of the
# release's SHA256SUMS and rewrites the url and version lines to match.
class Tokencount < Formula
  desc "Lightning-fast offline token counter for 9 LLM tokenizers"
  homepage "https://github.com/eordano/tokencount"
  version "1.0.1"
  license "AGPL-3.0-only"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/eordano/tokencount/releases/download/v1.0.1/tokencount-1.0.1-aarch64-apple-darwin.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end

    on_intel do
      url "https://github.com/eordano/tokencount/releases/download/v1.0.1/tokencount-1.0.1-x86_64-apple-darwin.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/eordano/tokencount/releases/download/v1.0.1/tokencount-1.0.1-aarch64-unknown-linux-musl.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end

    on_intel do
      url "https://github.com/eordano/tokencount/releases/download/v1.0.1/tokencount-1.0.1-x86_64-unknown-linux-musl.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    bin.install "tokencount"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tokencount --version")

    # tokencount prints "<right-aligned count> <label>"; stdin has no label.
    hello = pipe_output("#{bin}/tokencount", "Hello world").strip
    assert_match(/\A\d+\z/, hello)
    assert_operator hello.to_i, :>, 0

    # A real tokenizer scales with input. A stub returning a constant, or a
    # binary built without its embedded tables, fails here.
    long = pipe_output("#{bin}/tokencount", "hello " * 200).strip.to_i
    assert_operator long, :>, hello.to_i * 10

    # Named files are labelled with their path.
    (testpath/"sample.txt").write("The quick brown fox jumps over the lazy dog\n")
    assert_match "sample.txt", shell_output("#{bin}/tokencount sample.txt")

    # All nine tokenizer tables must be compiled into the released binary; -a
    # exits non-zero on any model whose table was not embedded.
    all_models = shell_output("#{bin}/tokencount -a sample.txt")
    assert_equal 9, all_models.lines.count
  end
end
