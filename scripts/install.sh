#!/usr/bin/env bash
#
# Geniro installer — the no-Homebrew path.
#
# Download, then run (inspect it first if you like — don't pipe a remote script
# straight into a shell):
#
#   curl -fsSL https://raw.githubusercontent.com/geniro-io/geniro-app/main/scripts/install.sh -o /tmp/geniro-install.sh
#   bash /tmp/geniro-install.sh
#
# Downloads the latest macOS release .zip and installs Geniro.app into
# /Applications. curl does NOT set the com.apple.quarantine attribute, so the
# ad-hoc-signed app launches without a Gatekeeper prompt (no Apple Developer ID
# needed). Re-run this script to update. Override the version with
# GENIRO_VERSION=v1.2.3, or the install dir with GENIRO_DEST=/path.
set -euo pipefail

REPO="geniro-io/geniro-app"
APP_NAME="Geniro.app"
DEST="${GENIRO_DEST:-/Applications}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: Geniro is macOS-only." >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "error: only Apple Silicon (arm64) builds are published." >&2
  exit 1
fi

if [[ -n "${GENIRO_VERSION:-}" ]]; then
  api="https://api.github.com/repos/${REPO}/releases/tags/${GENIRO_VERSION}"
else
  api="https://api.github.com/repos/${REPO}/releases/latest"
fi

echo "Resolving the latest Geniro release…"
release_json="$(curl -fsSL "$api")"
# Pick the macOS zip asset (electron-updater/Squirrel names it *-mac.zip).
url="$(printf '%s' "$release_json" \
  | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*-mac\.zip"' \
  | head -n1 \
  | sed -E 's/.*"(https:[^"]+)"/\1/')"
sums_url="$(printf '%s' "$release_json" \
  | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*SHA256SUMS\.txt"' \
  | head -n1 \
  | sed -E 's/.*"(https:[^"]+)"/\1/')"

if [[ -z "$url" ]]; then
  echo "error: no macOS .zip asset found on the release (has CI published it yet?)." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

asset="${url##*/}"
echo "Downloading $url"
curl -fSL "$url" -o "$tmp/$asset"

# The app is ad-hoc signed (no notarization), so Gatekeeper verifies nothing —
# the published checksum is the only integrity check between the release and
# an executing app. Verify BEFORE unpacking/stripping quarantine; a release
# without the asset (pre-checksum versions) degrades to TLS-only with a
# warning, but a mismatch is always fatal.
if [[ -n "$sums_url" ]]; then
  curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS.txt"
  if ! (cd "$tmp" && grep -F "  $asset" SHA256SUMS.txt | shasum -a 256 -c -); then
    echo "error: checksum verification FAILED for $asset — refusing to install a tampered or corrupted download." >&2
    exit 1
  fi
else
  echo "warning: this release publishes no SHA256SUMS.txt; proceeding on TLS integrity alone." >&2
fi

echo "Unpacking…"
ditto -x -k "$tmp/$asset" "$tmp/extracted"
if [[ ! -d "$tmp/extracted/$APP_NAME" ]]; then
  echo "error: $APP_NAME not found inside the downloaded archive." >&2
  exit 1
fi

if [[ -d "$DEST/$APP_NAME" ]]; then
  echo "Replacing the existing $APP_NAME…"
  rm -rf "$DEST/$APP_NAME"
fi
mkdir -p "$DEST"
mv "$tmp/extracted/$APP_NAME" "$DEST/"

# Belt-and-suspenders: strip quarantine if anything set it (ad-hoc apps have no
# notarization ticket, so a quarantined copy would be blocked by Gatekeeper).
xattr -dr com.apple.quarantine "$DEST/$APP_NAME" 2>/dev/null || true

echo
echo "Installed: $DEST/$APP_NAME"
echo "Launch it from Applications, or run: open \"$DEST/$APP_NAME\""
echo "Update later by re-running this script (or: brew upgrade --cask geniro)."
