---
description: Chats page — the composer's chips and model control, fast actions, run configurations, the session picker and config profiles
paths:
  - "apps/ui/src/renderer/chats/directory-select*"
  - "apps/ui/src/renderer/chats/folder-select*"
  - "apps/ui/src/renderer/chats/config-dir-select*"
  - "apps/ui/src/renderer/chats/effort-select*"
  - "apps/ui/src/renderer/chats/context-window-select*"
  - "apps/ui/src/renderer/chats/target-select*"
  - "apps/ui/src/renderer/chats/branch-select*"
  - "apps/ui/src/renderer/chats/model-*"
  - "apps/ui/src/renderer/chats/auto-compact*"
  - "apps/ui/src/renderer/chats/approval-mode-select*"
  - "apps/ui/src/renderer/chats/composer-values*"
  - "apps/ui/src/renderer/chats/fast-action-bar*"
  - "apps/ui/src/renderer/chats/run-config*"
  - "apps/ui/src/renderer/chats/new-chat-button*"
  - "apps/ui/src/renderer/chats/session-*"
  - "apps/ui/src/renderer/chats/run-group*"
  - "apps/ui/src/renderer/chats/run-profile*"
  - "apps/ui/src/renderer/settings/fast-actions*"
  - "apps/ui/src/renderer/settings/config-profiles*"
  - "apps/ui/src/renderer/projects/project-run-configs*"
  - "apps/ui/src/renderer/projects/unbound-run-configs*"
  - "apps/ui/src/renderer/projects/use-bind-run-configs*"
---

# Chats — composer chips, fast actions, run configurations and sessions

**Composer and chips:**

- `directory-select` is the one directory chip.
- `config-dir-select` renders nothing (never a disabled chip) when the CLI's `configDirs[]` row names a reason. `EffortSelect` and `ContextWindowSelect` return null on an empty listing.
- `target-select`: a CLI this machine cannot run is shown disabled, never hidden. The current target is never refused.
- `BranchSelect` switches the checkout. `BranchValueSelect` only records a name.
- The composer's model and its axes are one control (`chats/model-settings-select.tsx`), with two levels. Do not go back to a row of separate chips.
- Axes show one loading row while listings load.
- Context windows and model parameters come from the CLI per (CLI, model), never from a table here. Choosing a model clears the window everywhere it is stored (`modelChangePatch`).
- Use `withModelParameter` for parameter edits. An inline spread writes `{id: undefined}`.
- Auto-compact bounds are twinned in `shared/contracts.ts`. `Settings.lastAutoCompactPercent` is one value, not one per CLI.
- Approval modes come from `GET /v1/capabilities` `approvals[]`, never from an allowlist of agent names. `requiresPass` and `withheld` modes are hidden. The current value is always kept.
- A mid-turn mode change refused with 409 `RUN_BUSY` shows `daemonErrorDetail`.

**Fast actions** (`chats/fast-action-bar.tsx`, `settings/fast-actions.tsx`, `Settings.fastActions`):

- An action is a name and a description, nothing else. A press appends the description to the message box. It sends nothing and touches no chip. Never add run setup to an action.
- `persistFastActions` calls `window.geniro.updateSettings` directly, not the screen's `persist`, which swallows the rejection the rollback needs.
- The editor refuses locally whatever `settingsPatchSchema` would refuse. That boundary throws on the whole patch.

**Run configurations** (`chats/run-config.ts`, `new-chat-button.tsx`, `run-config-picker.tsx`, `projects/project-run-configs.tsx`, `Settings.runConfigs`):

- Named new-chat setups. Applying one seeds the new-chat screen and switches the branch. It sends nothing.
- Never fold run configurations and fast actions together. Doing so once deleted users' saved configurations.
- Every configuration belongs to a project (`RunConfig.projectId`), and is kept on that project's page; Settings has no pane for them. One component (`RunConfigPicker`) and one key serve the project page (inline, scoped to the project, `onReorder` laid back into the whole list by `withSubsetOrder`) and the `+` menu's "New configuration…" dialog. `onApply` separates them. The `+` menu groups them by project (`groupRunConfigsByProject`, unbound last as "No project"); its "Manage configurations…" opens the composer's project, else the Projects gallery.
- The editor refuses a draft whose project is unset or no longer listed (`runConfigRefusal`); picking a project fills an empty folder with the project's.
- A configuration with no project (saved before they belonged to projects, or whose project was deleted — a delete keeps them and clears the id) is never deleted for it: the Projects screen binds one with no id to its folder's project by the daemon's rule (`useBindRunConfigsByFolder` over `GET /v1/projects/of-folder`, once per configuration per mount), and lists the rest under the gallery (`UnboundRunConfigs`) to move into a project or delete. Older builds drop a configuration carrying `projectId` (strict `runConfigSchema`).
- A team target writes none of the per-CLI choices. A `null` through those setters deletes the remembered entry.
- A branch refusal is a partial success: amber, through `composerNotice`, with no worktree redirect.
- `chats/composer-values.ts` reads foreign settings strings. Import it, never restate it.

**Session picker and config profiles:**

- The session picker searches every profile on the daemon. The fan-out is in the renderer, because profiles live in `settings.json`.
- The profile is carried on the row, and `resumeSession` takes it from the row.
- `partialReason` names unreadable profiles and a hit `SESSION_LIST_LIMIT`. There is no client-side filter. Do not reintroduce a folder-scope filter.
- The picker's agent is its own. `sessionProfiles` collapses to the default profile for a CLI with no config directory.
- A `ConfigProfile` is `{ id, name, agent, dir, color }`, and the directory is its identity. Two entries may not name one directory.
- A profile is offered to its own CLI only.
- The palette union is spelled in `shared/contracts.ts` (not derived from `RunGroupColor`). `GROUP_DOT_CLASS` stays an exhaustive `Record`.
