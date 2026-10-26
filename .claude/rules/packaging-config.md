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

## macOS packaging

**macOS packaging**: `pnpm --filter @geniro/ui build:mac` runs `scripts/build-mac.mjs`.

- Each half (shell app, and the daemon under `Resources/daemon`) is staged with `pnpm --filter <pkg> --config.inject-workspace-packages=true deploy --prod <dir>`.
- Never pass `--legacy` to that deploy. It re-resolves ranges against the registry, so the build ships dependency versions nothing tested.
- Output (DMG and zip) lands in `release/dist/`. `productName` is `Geniro`.
- Signing: `GENIRO_SIGN_IDENTITY` names the self-signed certificate from `scripts/make-signing-identity.mjs`. Without it the build is ad hoc and says so.
  - The branch is described at the top of this rule: the identity plus `forceCodeSigning` plus a read-back of the bundle's requirement.
  - Releases are not notarized, so the Homebrew cask and the install script strip quarantine.
- Privacy grants are tied to the designated requirement. An ad-hoc build re-asks every grant.
  - A grant recorded under an ad-hoc build is dead even though it shows as on. Diagnose with `/usr/bin/log stream --level debug --process tccd` (the absolute path, because `log` is a zsh builtin).
  - The fix is on the machine: `tccutil reset <Service> io.geniro.desktop`, then relaunch.
- A TCC-denied folder passes `stat`/`access` and fails only on open. `resolveValidDirectory` opens the folder and refuses with `FOLDER_NOT_READABLE`. The folder purpose strings are in `electron-builder.yml` `extendInfo`.
