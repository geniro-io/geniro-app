import { type RunSettings, runSettingsOf } from '../shared/contracts';

/**
 * The user's custom instructions, reply language and per-CLI switches, as a
 * spreadable create-payload fragment ({@link runSettingsOf}). The one reader
 * for every run the renderer starts (a chat, a team run, an analysis, a
 * card's run, the team builder's chat); main's autopilot normalises
 * through the same function.
 *
 * Read from settings at the moment a run is created rather than cached in
 * component state, because the values are SNAPSHOTTED onto that run: a cached
 * copy would start a run on text the Settings screen had already replaced,
 * and the chat screen stays mounted across nav switches, so the stale window
 * is the whole session rather than a moment. A test stub of `getSettings` may
 * omit keys, which `runSettingsOf` reads as unset.
 */
export async function currentRunSettings(): Promise<RunSettings> {
  return runSettingsOf(await window.geniro.getSettings());
}
