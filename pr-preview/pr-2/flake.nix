{
  description = "Token Diff Estimator — dev shell & E2E test runner with CJK fonts";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEachSystem = f: nixpkgs.lib.genAttrs supportedSystems (system: f {
        pkgs = nixpkgs.legacyPackages.${system};
      });

      fontsConf = { pkgs }: pkgs.makeFontsConf {
        fontDirectories = [
          pkgs.noto-fonts
          pkgs.noto-fonts-cjk-sans
        ];
      };

      # Shared shell snippet: reinstall node_modules when package.json
      # changes or the Node.js version differs from the last install.
      # Uses `npm ci` (clean install) on version mismatch to rebuild
      # native addons like esbuild for the current Node ABI.
      ensureNodeModules = ''
        node_ver="$(node --version)"
        marker="node_modules/.node-version"
        # Ensure devDependencies are installed even if NODE_ENV=production
        export NODE_ENV=development
        if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
          npm install
          printf '%s' "$node_ver" > "$marker"
        elif [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$node_ver" ]; then
          echo "Node version changed (want $node_ver), reinstalling modules..."
          rm -rf node_modules
          npm install
          printf '%s' "$node_ver" > "$marker"
        fi
      '';

      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      cargoToml = builtins.readFile ./Cargo.toml;
      cargoVersion = let
        m = builtins.match ".*\nversion = \"([^\"]+)\".*" cargoToml;
      in builtins.head m;

      npmBuild = { pkgs }: extra: pkgs.buildNpmPackage ({
        version = packageJson.version;
        src = self;
        npmDepsHash = "sha256-OS2/ErvQBQrsHBfqevucFf9+eq1qbqriF946Zqi51h8=";
        env = {
          MODELS_DIR = hfModels { inherit pkgs; };
          ESBUILD_BINARY_PATH = "${esbuild_0_27_3 { inherit pkgs; }}/bin/esbuild";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
        };
        npmRebuildFlags = [ "--ignore-scripts" ];
        dontNpmBuild = true;
      } // extra);

      # esbuild 0.27.3 built from source (matches package-lock.json)
      esbuild_0_27_3 = { pkgs }: pkgs.buildGoModule rec {
        pname = "esbuild";
        version = "0.27.3";
        src = pkgs.fetchFromGitHub {
          owner = "evanw";
          repo = "esbuild";
          rev = "v${version}";
          hash = "sha256-SAe8ixiU3wVLccEWxHvp+H2X+Ef1MwoN9+Ko7wh+0G8=";
        };
        vendorHash = "sha256-+BfxCyg0KkDQpHt/wycy/8CTG6YBA/VJvJFhhzUnSiQ=";
        subPackages = [ "cmd/esbuild" ];
        ldflags = [ "-s" "-w" ];
      };

      # Pre-fetched HuggingFace tokenizer model data for offline bundling.
      # Must stay in sync with HF_REPOS in scripts/build-offline.mjs.
      hfModels = { pkgs }:
        let
          fetchHf = repo: file: hash: {
            inherit repo file;
            src = pkgs.fetchurl {
              url = "https://huggingface.co/${repo}/resolve/main/${file}";
              inherit hash;
            };
          };

          models = [
            (fetchHf "Xenova/gemma-2-tokenizer"              "tokenizer.json"        "sha256-faU8op+xb2skiUgvwLxqOUFizasU0SdkoXVevFg/6nk=")
            (fetchHf "Xenova/gemma-2-tokenizer"              "tokenizer_config.json"  "sha256-7oar2Fpd278IAbpgyFiZU634H5UP4UDzHCKF91DcgmQ=")
            (fetchHf "deepseek-ai/DeepSeek-V3"               "tokenizer.json"        "sha256-YhrC4y0NumWEBEEjGIGKqozozaSS5ZgwEJ2NprUX+0E=")
            (fetchHf "deepseek-ai/DeepSeek-V3"               "tokenizer_config.json"  "sha256-Y3vNGgjPfHcs5qODGWsikwkhx5w8cyI8WvwMf0FUVUY=")
            (fetchHf "Qwen/Qwen3-0.6B"                      "tokenizer.json"        "sha256-rrEzB6cazY/oGGHZStVKtonfdzMYgJ7tPL55S0SS2uQ=")
            (fetchHf "Qwen/Qwen3-0.6B"                      "tokenizer_config.json"  "sha256-1dCfB7SMMIbFCLMNHJEUvRGJFFt06YKiZTUMkjrNgQE=")
            (fetchHf "MiniMaxAI/MiniMax-Text-01"             "tokenizer.json"        "sha256-7OBDhCV1Q90cExKZG2BC79xb4JEDcppizITXGLzDsaY=")
            (fetchHf "MiniMaxAI/MiniMax-Text-01"             "tokenizer_config.json"  "sha256-0FhxaF7bWe48Ruujk/o9v6tqqLZWCkHli1uqsB0fGc0=")
            (fetchHf "Xenova/llama4-tokenizer"               "tokenizer.json"        "sha256-g/mK/O6QSH76R7ErqRD4dyhc0OC4+T3WyIRAs/qOZ7M=")
            (fetchHf "Xenova/llama4-tokenizer"               "tokenizer_config.json"  "sha256-vgm5+PaqsEjgp0ErYD2NcRYCYtHYFB5CO68tKDGPEFI=")
            (fetchHf "mistralai/Mistral-Nemo-Instruct-2407"  "tokenizer.json"        "sha256-4RxxcmMj0z2nuNb28mnxmIkxwKUrcSK83YwFBCl04Ns=")
            (fetchHf "mistralai/Mistral-Nemo-Instruct-2407"  "tokenizer_config.json"  "sha256-Z/Ou73ZbfXgBKggdupjv1JAM0rrCTqwYIpaEHH4q7yo=")
            (fetchHf "Xenova/grok-1-tokenizer"               "tokenizer.json"        "sha256-+eoGJd68Pn7g8LPADpM+IwrZyIr+Fjafhl6P3j2Db6o=")
            (fetchHf "Xenova/grok-1-tokenizer"               "tokenizer_config.json"  "sha256-rBiNpeuWrv2fmfRxd+8aBtUpHaYhEvYAAqjejm7g89A=")
          ];
        in
        pkgs.runCommand "hf-model-data" {} (
          builtins.concatStringsSep "\n" (map (m: ''
            mkdir -p $out/${m.repo}
            cp ${m.src} $out/${m.repo}/${m.file}
          '') models)
        );
      repoToDir = {
        "Xenova/gemma-2-tokenizer"             = "gemini";
        "deepseek-ai/DeepSeek-V3"              = "deepseek";
        "Qwen/Qwen3-0.6B"                      = "qwen";
        "MiniMaxAI/MiniMax-Text-01"             = "minimax";
        "Xenova/llama4-tokenizer"               = "llama";
        "mistralai/Mistral-Nemo-Instruct-2407"  = "mistral";
        "Xenova/grok-1-tokenizer"               = "grok";
      };

      # Assembled model directory for the Rust CLI: o200k_base.tiktoken +
      # {model}/tokenizer.json for each HF model.  Shared between the
      # dev shell (TOKEN_COUNT_MODELS env) and the release package.
      rustModelsDir = { pkgs }:
        let
          hfData = hfModels { inherit pkgs; };
          o200kData = pkgs.fetchurl {
            url = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken";
            hash = "sha256-RGqVOMtsNI41FhINfAiwn1fDZJXirP/+WaW/iwz7Gi0=";
          };
          copyHfModels = builtins.concatStringsSep "\n" (
            nixpkgs.lib.mapAttrsToList (repo: dir: ''
              mkdir -p $out/${dir}
              cp ${hfData}/${repo}/tokenizer.json $out/${dir}/
            '') repoToDir
          );
        in
        pkgs.runCommand "tokencount-rust-models" {} ''
          mkdir -p $out
          cp ${o200kData} $out/o200k_base.tiktoken
          ${copyHfModels}
        '';
    in
    {
      apps = forEachSystem ({ pkgs }: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.tokencount}/bin/tokencount";
        };
      });

      packages = forEachSystem ({ pkgs }:
        let isLinux = pkgs.stdenv.hostPlatform.isLinux; in
        {
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.tokencount;
      } // nixpkgs.lib.optionalAttrs isLinux (let
        e2eInputs = [ pkgs.nodejs pkgs.python3 pkgs.chromium ];
        e2eSetup = ''
          export FONTCONFIG_FILE="${fontsConf { inherit pkgs; }}"
          export BROWSER_PATH="${pkgs.chromium}/bin/chromium"
          cd "$(git rev-parse --show-toplevel)"
          ${ensureNodeModules}
        '';
        mkE2eTest = name: extra: pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = e2eInputs;
          text = ''
            ${e2eSetup}
            ${extra}
          '';
        };
      in {
        test-e2e = mkE2eTest "test-e2e" ''npx playwright test "$@"'';
        test-e2e-bundle = mkE2eTest "test-e2e-bundle" ''
          npm run build:offline
          npx playwright test --config playwright.bundle.config.js "$@"
        '';
      }) // {
        tokencount = pkgs.rustPlatform.buildRustPackage {
              pname = "tokencount";
              version = cargoVersion;
              src = pkgs.lib.cleanSourceWith {
                src = self;
                filter = path: type:
                  let base = builtins.baseNameOf path; in
                  base == "Cargo.toml" || base == "Cargo.lock" || base == "build.rs"
                  || base == "src" || nixpkgs.lib.hasPrefix "${self}/src" (toString path)
                  || base == "data" || nixpkgs.lib.hasPrefix "${self}/data" (toString path);
              };
              cargoLock.lockFile = ./Cargo.lock;
              env.TOKEN_COUNT_MODELS = rustModelsDir { inherit pkgs; };
            };

        tokencount-js = let
            hfData = hfModels { inherit pkgs; };
            copyModels = builtins.concatStringsSep "\n" (
              nixpkgs.lib.mapAttrsToList (repo: dir: ''
                mkdir -p $out/share/tokencount/models/${dir}
                cp ${hfData}/${repo}/tokenizer.json $out/share/tokencount/models/${dir}/
                cp ${hfData}/${repo}/tokenizer_config.json $out/share/tokencount/models/${dir}/
              '') repoToDir
            );
          in npmBuild { inherit pkgs; } {
            pname = "tokencount-js";
            buildPhase = ''
              runHook preBuild
              node scripts/build-cli.mjs
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out/bin $out/share/tokencount/models
              cp dist/tokencount.mjs $out/bin/tokencount-js
              chmod +x $out/bin/tokencount-js
              cp package.json $out/
              cp data/claude-vocab.json $out/share/tokencount/models/
              ${copyModels}
              runHook postInstall
            '';
          };

        build-offline = npmBuild { inherit pkgs; } {
            pname = "tokencount-offline";
            buildPhase = ''
              runHook preBuild
              node scripts/build-offline.mjs
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p $out
              cp dist/tokencount.html $out/
              cp dist/tokencount-offline.tar.gz $out/
              runHook postInstall
            '';
          };
      });

      devShells = forEachSystem ({ pkgs }:
        let isLinux = pkgs.stdenv.hostPlatform.isLinux; in
        {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs pkgs.python3 pkgs.cargo pkgs.rustc pkgs.hyperfine ]
            ++ nixpkgs.lib.optionals isLinux [ pkgs.chromium ];
          env = {
            TOKEN_COUNT_MODELS = rustModelsDir { inherit pkgs; };
          } // nixpkgs.lib.optionalAttrs isLinux {
            FONTCONFIG_FILE = fontsConf { inherit pkgs; };
            BROWSER_PATH = "${pkgs.chromium}/bin/chromium";
          };
        };
      });
    };
}
