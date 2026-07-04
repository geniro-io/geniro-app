# Homebrew Cask for Geniro — seed/reference copy.
#
# The LIVE cask lives in the tap repo `geniro-io/homebrew-tap` under
# `Casks/geniro.rb`; the Release workflow's `bump-cask` job rewrites `version`,
# `sha256`, and the URL there on every release (see .github/workflows/release.yaml).
# This file is the initial content to seed that repo with, and a place to review
# cask changes in PRs.
#
# Install (ad-hoc build). Modern Homebrew (6.x) always quarantines a cask
# artifact and dropped `--no-quarantine`, so a quarantined ad-hoc app can't
# spawn its bundled daemon (Gatekeeper blocks the child) and hangs on launch —
# the `postflight` below strips the quarantine bit. Third-party taps also need
# an explicit `brew trust`:
#
#   brew tap geniro-io/tap
#   brew trust geniro-io/tap
#   brew install --cask geniro
#   brew upgrade --cask geniro          # later, to update
#
cask "geniro" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/geniro-io/geniro-app/releases/download/v#{version}/Geniro-#{version}-arm64-mac.zip"
  name "Geniro"
  desc "Local-first desktop app for composing and running a DAG of CLI coding agents"
  homepage "https://github.com/geniro-io/geniro-app"

  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"

  app "Geniro.app"

  # Strip com.apple.quarantine so the ad-hoc (unsigned) app can spawn its
  # bundled daemon subprocess instead of being Gatekeeper-blocked on launch.
  # (Homebrew 6.x always quarantines and no longer offers `--no-quarantine`.)
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Geniro.app"]
  end

  zap trash: [
    "~/Library/Application Support/Geniro",
    "~/Library/Application Support/geniro",
    "~/Library/Preferences/io.geniro.desktop.plist",
    "~/Library/Logs/Geniro",
    "~/Library/Saved Application State/io.geniro.desktop.savedState",
  ]
end
