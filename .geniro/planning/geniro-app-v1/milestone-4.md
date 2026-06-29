---
tier: T1.5
producer: plan
schema-version: 1
branch: main
timestamp: 2026-06-29T09:04:18Z
geniro_kind: design-doc
geniro_schema_version: m5-v1
task_slug: geniro-app-v1
topic: "Local-first macOS app (Electron + TS daemon) to compose and run a DAG of CLI coding agents"
mode: IDEA
effort_tier: big
lifecycle: approved
budget:
  max_files_to_edit: null
  max_lines_changed: null
  time_budget: null
checkpoints:
  - {step_anchor: step-1, name: "M1 — daemon boots, /health ok, onboarding passes"}
  - {step_anchor: step-2, name: "M2 — single-agent chat round-trip persisted+resumable"}
  - {step_anchor: step-3, name: "M3 — graph DAG fan-out runs end-to-end"}
  - {step_anchor: step-4, name: "M4 — terminal mirror + electron-updater + signed DMG"}
forbidden_actions:
  - "do NOT bundle a Python runtime — the whole stack is TypeScript"
  - "do NOT write API tokens/secrets into SQLite or any file — macOS Keychain only"
  - "do NOT store graph definitions in SQLite — YAML files are the source of truth; SQLite is runtime/history only"
  - "do NOT add tmux/PTY-scraping for graph execution in v1 — graph nodes run headless"
  - "do NOT add cloud/remote/multi-machine code paths — local single-machine only"
tools_required: ["node", "pnpm", "git", "claude", "cursor-agent"]
parent_spec: geniro-app-v1
---

<!-- geniro:design-doc -->

# geniro v1 · Milestone 4 — Terminal mirror, auto-update, packaging

> Reference sources for the `file:line` citations below (read-only, for grounding — NOT files in this repo):
> Geniro monorepo at `/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`; Omnigent clone analyzed in research; full analysis at `docs/research/geniro-vs-omnigent-analysis.md`.


## 1. Objective

Add the live PTY terminal mirror, the settings screen, signed packaging, and one-artifact auto-update so the app ships and updates itself.

## 2. Scope — Included

- Live PTY terminal mirror: `node-pty` spawns an agent's interactive TUI, raw bytes ↔ `xterm.js` over WS, resize + detach handling — the TS equivalent of `terminals/ws_bridge.py:455`. Available as an on-click "open terminal" session per agent/node.
- Settings page: API tokens (Keychain), default model, CLI paths, update check.
- Packaging: electron-builder for macOS (hardened runtime, entitlements, dev-signed; Developer-ID + notarization at distribution), DMG artifact.
- Auto-update: `electron-updater` against a feed (GitHub Releases), one signed artifact (shell + bundled daemon), version-locked; retain previous version for rollback.

## 3. Scope — Excluded

- Cursor-subscription TUI integration (deferred).
- Live real-time canvas animation (deferred).

## 4. Assumptions

- `node-pty` builds for the target arch × Electron version.
- A signing identity is available for the distribution step (else dev-signed).

## 5. Risks

- MEDIUM — `node-pty` native build matrix. Mitigation: prebuilt binaries + electron-rebuild.
- MEDIUM — notarization setup. Mitigation: dev-signed in dev; notarize only at the distribution step.

## 6. Steps

- [ ] 1. Daemon PTY service: `node-pty` spawn + WS byte bridge + resize/detach (`terminals/ws_bridge.py:455`). <!-- step-1 -->
- [ ] 2. Renderer terminal panel: `xterm.js` ↔ WS; "open terminal" per agent/node. <!-- step-2 -->
- [ ] 3. Settings page: tokens (Keychain), default model, CLI paths, update check. <!-- step-3 -->
- [ ] 4. electron-builder macOS config: hardened runtime, entitlements, DMG; dev-sign. <!-- step-4 -->
- [ ] 5. electron-updater: feed (GitHub Releases), one signed artifact (shell+daemon), version-lock + rollback. <!-- step-5 -->

## 7. Tools Required

- `node-pty`, `xterm.js`, electron-builder, electron-updater; a code-signing identity (for distribution).

## 8. Approval Points

- Before configuring the signing identity / notarization. <!-- step-4 -->
- Demo checkpoint at M4 end (release-ready).

## 9. Validation

- Open a live terminal for an agent and see the original TUI byte-for-byte; build a signed DMG; publish a new version and confirm `electron-updater` installs it. verify: pnpm --filter shell build:mac

## 10. Rollback-Recovery

- `git revert` the M4 branch; terminal/updater are additive. A bad release rolls back via electron-updater's retained previous version.

## 11. Done Condition

- A user can view the original vendor terminal in-app, change settings, and the app builds as a signed DMG that auto-updates itself as one version-locked artifact.
