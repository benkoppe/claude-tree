{
  description = "Explore and run Claude Code conversations as a tree";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.flake-parts.follows = "flake-parts";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [

      ];
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      perSystem =
        {
          inputs',
          pkgs,
          ...
        }:
        {
          devShells.default = pkgs.mkShellNoCC {
            packages = [
              pkgs.bun
              inputs'.llm-agents.packages.claude-code
            ];
          };
        };
    };
}
