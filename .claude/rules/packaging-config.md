---
description: Packaging config — an env-signal branch must own every value it controls
paths:
  - "scripts/**"
  - "apps/ui/electron-builder.yml"
---

- **A script that branches on "is X configured" must own every config value that
  decision controls.** When a pipeline branches on an env signal (an env var, a
  file's presence) and the tool it drives has its own config file that can also
  carry a value governing the same behavior, inject every dependent value from
  that one branch and never statically pin any of them in the config file — a
  pinned value silently shadows the signal inside the tool's own resolution,
  decoupling the branch from what actually ships. Prefer one ternary setting
  all coupled values (make the invalid combination unrepresentable); when
  reviewing such a branch, grep the tool's config for statically pinned values
  it is supposed to control.
- **The live case: the `GENIRO_SIGN_IDENTITY` branch in `scripts/build-mac.mjs`.**
  It injects `-c.mac.identity=<identity>` together with
  `-c.forceCodeSigning=true` (or `-c.mac.identity=-` when unset), so
  `apps/ui/electron-builder.yml` must never statically pin `identity` or
  `forceCodeSigning`. `notarize: false` and the absent `publish` block stay in
  the yml because they do not vary with that branch (publishing is
  `--publish never` on the command line); a new value that varies with the
  signing signal belongs in the script's branch, not the yml.
