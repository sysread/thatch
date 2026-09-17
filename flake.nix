{
  description = "thatch - persistent memory for AI coding agents (local embeddings, SQLite stores, zero config)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      # Supported platforms; keep in sync with meta.platforms in
      # nix/thatch.nix (widen both as the remaining depsHashes land).
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-darwin"
      ];
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          thatch = pkgs.callPackage ./nix/thatch.nix { };
        in
        {
          default = thatch;
          thatch = thatch;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.default;
        };
      });

      # `nix develop` — everything needed to hack on thatch (bun runs the
      # TypeScript directly; mise mirrors the repo's task runner).
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShellNoCC {
            packages = [
              pkgs.bun
              pkgs.mise
              pkgs.git
              pkgs.nodejs_22
            ];
            shellHook = ''
              echo "thatch dev shell — bun $(bun --version)"
              echo "  bun install        # fetch deps"
              echo "  bun test           # run the suite"
              echo "  bun run bin/thatch # run the CLI"
            '';
          };
        }
      );

      # Import into another flake's nixpkgs to get `pkgs.thatch`. The overlay
      # serves this flake's own locked build rather than rebuilding against
      # the importer's nixpkgs: the depsHash in nix/thatch.nix is pinned to
      # the bun in this flake's nixpkgs, so a rebuild with a different bun
      # would mismatch the hash.
      overlays.default = final: prev: {
        thatch = self.packages.${prev.stdenv.hostPlatform.system}.default;
      };

      # NixOS module: `programs.thatch.enable = true;` puts thatch on PATH
      # system-wide, so Claude Code / OpenCode / Cursor can spawn it.
      nixosModules.default =
        { config, lib, pkgs, ... }:
        let
          cfg = config.programs.thatch;
        in
        {
          options.programs.thatch.enable =
            lib.mkEnableOption "the thatch memory CLI (MCP server for AI coding agents)";

          # Pull the package straight from this flake's outputs rather than
          # injecting `self.overlays.default` into `nixpkgs.overlays`. Forcing
          # an overlay from a module collides with configs that manage their
          # own overlay list; a direct package reference sidesteps that.
          config = lib.mkIf cfg.enable {
            environment.systemPackages =
              [ self.packages.${pkgs.stdenv.hostPlatform.system}.default ];
          };
        };
    };
}
