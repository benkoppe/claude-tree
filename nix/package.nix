_: {
  perSystem =
    {
      inputs',
      lib,
      pkgs,
      ...
    }:
    let
      package = builtins.fromJSON (builtins.readFile ../package.json);
      bun2nix = inputs'.bun2nix.packages.default;
      providerPackages = [
        inputs'.llm-agents.packages.claude-code
      ]
      ++ lib.optionals (inputs'.llm-agents.packages ? codex) [ inputs'.llm-agents.packages.codex ];
      ignoreUnusedMuslLoaders =
        pkgs.makeSetupHook
          {
            name = "ignore-unused-musl-loaders";
          }
          (
            pkgs.writeText "ignore-unused-musl-loaders.sh" ''
              autoPatchelfIgnoreMissingDeps="libc.musl-x86_64.so.1 libc.musl-aarch64.so.1"
            ''
          );
      claudeTreeUnwrapped = bun2nix.mkDerivation {
        pname = package.name;
        inherit (package) version;

        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.unions [
            ../bun.lock
            ../package.json
            ../src
          ];
        };

        bunDeps = bun2nix.fetchBunDeps {
          bunNix = ../bun.nix;
          autoPatchElf = pkgs.stdenv.hostPlatform.isLinux;
          nativeBuildInputs = lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            ignoreUnusedMuslLoaders
          ];
        };

        dontRunLifecycleScripts = true;
        dontUseBunBuild = true;
        dontUseBunCheck = true;

        nativeBuildInputs = [ pkgs.makeWrapper ];

        installPhase = ''
          runHook preInstall

          mkdir -p "$out/lib/claude-tree" "$out/bin"
          cp -R src package.json node_modules "$out/lib/claude-tree"
          makeWrapper ${lib.getExe pkgs.bun} "$out/bin/claude-tree" \
            --add-flags "$out/lib/claude-tree/src/cli.ts"

          runHook postInstall
        '';

        meta = {
          inherit (package) description homepage;
          license = lib.licenses.mit;
          mainProgram = "claude-tree";
          platforms = [
            "x86_64-linux"
            "aarch64-linux"
            "aarch64-darwin"
          ];
        };
      };
      claudeTree = pkgs.writeShellApplication {
        name = "claude-tree";
        runtimeInputs = providerPackages;
        text = ''
          exec ${lib.getExe claudeTreeUnwrapped} "$@"
        '';
        inherit (claudeTreeUnwrapped) meta;
      };
      app = nixPackage: {
        type = "app";
        program = lib.getExe nixPackage;
      };
    in
    {
      packages = {
        claude-tree-unwrapped = claudeTreeUnwrapped;
        claude-tree = claudeTree;
        default = claudeTree;
      };

      apps = rec {
        claude-tree = app claudeTree;
        claude-tree-unwrapped = app claudeTreeUnwrapped;

        default = claude-tree;
        unwrapped = claude-tree-unwrapped;
      };

      checks = {
        bun-nix =
          pkgs.runCommand "claude-tree-bun-nix-check"
            {
              nativeBuildInputs = [
                bun2nix
                pkgs.diffutils
              ];
            }
            ''
              cp ${../bun.lock} bun.lock
              bun2nix -o generated.nix
              diff -u ${../bun.nix} generated.nix
              touch "$out"
            '';
        package = claudeTree;
        package-unwrapped = claudeTreeUnwrapped;
        version = pkgs.runCommand "claude-tree-version-check" { } ''
          test "$(${lib.getExe claudeTree} --version)" = "${package.name} ${package.version}"
          ${lib.getExe claudeTree} --help >/dev/null
          touch "$out"
        '';
      };

      devShells.default = pkgs.mkShellNoCC {
        packages = [
          pkgs.bun
          bun2nix
        ]
        ++ providerPackages;
      };
    };
}
