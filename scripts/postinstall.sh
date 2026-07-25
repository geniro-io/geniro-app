#!/usr/bin/env bash
# Post-install repairs for this workspace. Idempotent; runs on every install.
set -uo pipefail

cd "$(dirname "$0")/.."

# 1. node-pty ships an N-API prebuild whose spawn-helper loses its exec bit
#    through the pnpm store.
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true

# 2. Download the Electron binary.
#
#    Electron 42.0 DELIBERATELY removed its `postinstall` script — postinstall
#    is a common npm supply-chain attack vector, so the binary now downloads
#    lazily the first time electron's own `bin` script runs, and the former
#    postinstall code is exposed as the `install-electron` bin instead
#    (ELECTRON_SKIP_BINARY_DOWNLOAD is gone with it).
#    https://www.electronjs.org/docs/latest/breaking-changes
#
#    That lazy path never fires for us: electron-vite resolves the binary
#    through getElectronPath() in the electron MODULE, which just reads
#    dist/path.txt and throws "Error: Electron uninstall" when it is missing —
#    so `pnpm dev` dies on a fresh install. Call the supported bin ourselves.
#    It no-ops when dist/ already matches the package version and reuses
#    ~/Library/Caches/electron otherwise, so a warm tree costs nothing.
if [ ! -f node_modules/electron/path.txt ] &&
  [ -f node_modules/electron/install.js ]; then
  echo "postinstall: downloading the Electron binary (no upstream postinstall since v42)…"
  node node_modules/electron/install.js ||
    echo "postinstall: electron download failed — run 'pnpm exec install-electron' by hand" >&2
fi

# 3. Re-arm bin targets that came out of the store without their exec bit —
#    observed on electron-vite, electron-rebuild, baseline-browser-mapping and
#    read-binary-file-arch, which fail with EACCES ("Permission denied")
#    through their node_modules/.bin symlink.
if [ -d node_modules/.bin ]; then
  (
    cd node_modules/.bin || exit 0
    for link in *; do
      target=$(readlink "$link" 2>/dev/null) || continue
      if [ -n "$target" ] && [ -f "$target" ] && [ ! -x "$target" ]; then
        chmod +x "$target" 2>/dev/null || true
      fi
    done
  ) || true
fi

exit 0
