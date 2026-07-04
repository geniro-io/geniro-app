# Homebrew Cask for Geniro — seed/reference copy.
#
# The LIVE cask lives in the tap repo `geniro-io/homebrew-tap` under
# `Casks/geniro.rb`; the Release workflow's `bump-cask` job rewrites `version`,
# `sha256`, and the URL there on every release (see .github/workflows/release.yaml).
# This file is the initial content to seed that repo with, and a place to review
# cask changes in PRs.
#
# Install (ad-hoc build — pass --no-quarantine so Gatekeeper doesn't block the
# unsigned app; the `quarantine false` stanza no longer exists in Homebrew Cask):
#
#   brew tap geniro-io/tap
#   brew install --cask --no-quarantine geniro
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

  zap trash: [
    "~/Library/Application Support/Geniro",
    "~/Library/Application Support/geniro",
    "~/Library/Preferences/io.geniro.desktop.plist",
    "~/Library/Logs/Geniro",
    "~/Library/Saved Application State/io.geniro.desktop.savedState",
  ]
end
