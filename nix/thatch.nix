{
  lib,
  stdenv,
  bun,
  makeWrapper,
  autoPatchelfHook,
  # Per-system hash of the vendored node_modules produced by `bun install`.
  # Regenerate with: nix build .#thatch.deps  (read the "got:" hash from the error)
  depsHash ? {
    x86_64-linux = "sha256-37uHLZYLfniOM1w6nQvfNadGCks9hJ+pmeVM13V0Wvg=";
    aarch64-linux = lib.fakeHash;
    x86_64-darwin = lib.fakeHash;
    aarch64-darwin = "sha256-sP5xzzyuAWHH4ZBdmQ2aEJBaRJDMqSRLiHTULd7Dr/c=";
  },
}:

let
  pkg = lib.importJSON ../package.json;
  system = stdenv.hostPlatform.system;

  # Only the files that affect the runtime artifact. Keeps the store path (and
  # its hash) stable when tests, docs plans, CI config, etc. change.
  runtimeSrc = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../bin
      ../docs
      ../artifacts
      ../package.json
    ];
  };

  # Fixed-output derivation: `bun install` needs network, so it runs as an FOD
  # whose content is pinned by depsHash. Only package.json + bun.lock feed it,
  # so the hash only changes when dependencies change.
  nodeModules = stdenv.mkDerivation {
    pname = "thatch-node-modules";
    version = pkg.version;

    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../bun.lock
      ];
    };

    nativeBuildInputs = [ bun ];

    dontConfigure = true;
    dontFixup = true; # native libs are patched in the main derivation

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install \
        --frozen-lockfile \
        --no-progress \
        --ignore-scripts \
        --production
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/node_modules
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = depsHash.${system} or lib.fakeHash;
  };
in
stdenv.mkDerivation {
  pname = "thatch";
  version = pkg.version;

  src = runtimeSrc;

  # ELF patching is Linux-only; on Darwin the prebuilt .node binaries are
  # Mach-O and load as-is, and autoPatchelfHook would choke on them.
  nativeBuildInputs = [ makeWrapper ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  # onnxruntime-node's prebuilt .node needs the C++ runtime; sharp/msgpackr
  # ship optional native deps thatch never loads, so ignore their missing libs.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  autoPatchelfIgnoreMissingDeps = [ "*" ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    dest=$out/libexec/thatch
    mkdir -p "$dest"
    cp -R src bin docs artifacts package.json "$dest/"

    # Vendored deps come from the read-only store; make them writable so
    # autoPatchelfHook can patch the onnxruntime binaries during fixup.
    cp -R ${nodeModules}/node_modules "$dest/node_modules"
    chmod -R u+w "$dest/node_modules"

    # nixpkgs is glibc-only. sharp ships both glibc and musl prebuilts whose
    # bundled libvips share the same soname (libvips-cpp.so.*); leaving both in
    # place makes autoPatchelfHook resolve the glibc sharp binary against the
    # musl libvips, which then fails at runtime looking for libc.musl. Drop the
    # musl variants so detection and patching both land on glibc.
    rm -rf "$dest"/node_modules/@img/*musl* \
           "$dest"/node_modules/sharp/vendor 2>/dev/null || true

    makeWrapper ${bun}/bin/bun $out/bin/thatch \
      --add-flags "$dest/bin/thatch"

    runHook postInstall
  '';

  passthru = {
    deps = nodeModules;
  };

  meta = {
    description = pkg.description;
    homepage = "https://github.com/sysread/thatch";
    license = lib.licenses.mit;
    mainProgram = "thatch";
    platforms = lib.platforms.unix;
  };
}
