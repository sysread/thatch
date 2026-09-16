{
  description = "thatch - persistent memory for AI coding agents (local embeddings, SQLite stores, zero config)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        thatch = pkgs.callPackage ./nix/thatch.nix { };
      in
      {
        packages = {
          default = thatch;
          thatch = thatch;
        };

        apps.default = {
          type = "app";
          program = "${thatch}/bin/thatch";
        };

        # `nix develop` — everything needed to hack on thatch (bun runs the
        # TypeScript directly; mise mirrors the repo's task runner).
        devShells.default = pkgs.mkShell {
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
    )
    // {
      # Import into another flake's nixpkgs to get `pkgs.thatch`.
      overlays.default = final: prev: {
        thatch = final.callPackage ./nix/thatch.nix { };
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

          config = lib.mkIf cfg.enable {
            nixpkgs.overlays = [ self.overlays.default ];
            environment.systemPackages = [ pkgs.thatch ];
          };
        };
    };
}
