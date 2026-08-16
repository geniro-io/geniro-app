---
description: Packaging config — an env-signal branch must own every value it controls
paths:
  - "scripts/**"
  - "apps/ui/electron-builder.yml"
---

- **A script that branches on "is X configured" must own every config value that
  decision controls.** When a pipeline branches on an env signal (`CSC_NAME`, a
  file's presence) and the tool it drives has its own config file that can also
  carry a value governing the same behavior, inject every dependent value from
  that one branch and never statically pin any of them in the config file — a
  pinned value silently shadows the signal inside the tool's own resolution,
  decoupling the branch from what actually ships. Prefer one ternary setting
  all coupled values (make the invalid combination unrepresentable); when
  reviewing such a branch, grep the tool's config for statically pinned values
  it is supposed to control. (M4: `identity: '-'` pinned in electron-builder.yml
  shadowed CSC_NAME/CSC_LINK — an "unsigned-safe" build would have shipped
  ad-hoc-signed WITH the auto-update feed.)
