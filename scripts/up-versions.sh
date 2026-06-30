#!/bin/bash

# Single product version for the whole app — semantic-release's default tag
# format is `v${version}` (e.g. v1.0.0), which is also what electron-builder /
# electron-updater expect for the M4 auto-update feed.
pnpm semantic-release --no-ci
