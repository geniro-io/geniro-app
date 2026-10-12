---
description: Packaging config — an env-signal branch must own every value it controls
paths:
  - "scripts/**"
  - "apps/ui/electron-builder.yml"
---

# Packaging config

A script that branches on an env signal (an env var, a file's presence) must set every config value that decision controls; never pin any of them statically in the tool's own config file, where a pinned value silently overrides the branch.

- Set all coupled values from one branch (one ternary), so the invalid combination cannot be expressed.
- When reviewing such a branch, grep the tool's config for pinned values it is meant to control.
- Live case: `scripts/build-mac.mjs` branches on `GENIRO_SIGN_IDENTITY`, injecting `-c.mac.identity=<identity>` + `-c.forceCodeSigning=true`, or `-c.mac.identity=-` when unset. So `apps/ui/electron-builder.yml` must never pin `identity` or `forceCodeSigning`; a new value that varies with signing belongs in the script's branch. Values that do not vary with it (`notarize: false`, no `publish` block) stay in the yml.
