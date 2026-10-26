import type { AgentModelParameter } from '../../adapter.types';
import {
  CLAUDE_FAST_MODE_OFF_VALUE,
  CLAUDE_FAST_MODE_ON_VALUE,
  CLAUDE_FAST_MODE_PARAMETER_ID,
} from '../claude.const';

/**
 * Whether MODEL is in the one family fast mode works on.
 *
 * In the 2.1.280 binary's own gate (next to `supportsFastMode`), a model "supports fast
 * mode" when its resolved name lower-cases to include `opus-4-8` or
 * `opus-5`, narrower than "any Opus". This check is the WIDER "opus"
 * substring instead of that literal pair on purpose: `builtinModels`'s bare
 * `opus` alias (which always resolves to the latest Opus tier) matches
 * neither literal, and pinning today's release names into this code is how
 * the toggle would silently stop appearing the day that alias moves on. Model
 * ids arrive from two sources (`claude-models.utils.ts`) and both lower-case
 * cleanly: the account cache's dated ids (`claude-opus-5-5`) and this CLI's
 * own tier aliases (`opus`).
 *
 * RE-CHECK IF a future Opus generation ships that the CLI does NOT extend
 * fast mode to — this would then offer a toggle the CLI silently refuses.
 */
export function isFastModeCapable(model: string): boolean {
  return model.toLowerCase().includes('opus');
}

/**
 * The one model parameter this adapter offers — see
 * `ClaudeAdapter.listModelParameters`'s doc block for the account gate this
 * sits behind.
 */
export function fastModeParameter(): AgentModelParameter {
  return {
    id: CLAUDE_FAST_MODE_PARAMETER_ID,
    label: 'Fast mode',
    values: [
      { id: CLAUDE_FAST_MODE_ON_VALUE, label: 'On' },
      { id: CLAUDE_FAST_MODE_OFF_VALUE, label: 'Off' },
    ],
    // No live read backs this — the CLI's OWN answer (`fast_mode_state`) rides
    // the turn's result line, not a channel this listing has, so a default
    // reading here would be invented rather than measured.
    current: null,
  };
}

/**
 * Whether the turn asked for fast mode.
 *
 * Only ever the ON case counts: turning it off is omitting the key, which is
 * already this CLI's default (`sdk_opt_in_required` with no `--settings` at
 * all — see `CLAUDE_SETTINGS_FLAG`), so there is no OFF value to send.
 */
export function wantsFastMode(
  modelParameters: Record<string, string> | null | undefined,
): boolean {
  return (
    modelParameters?.[CLAUDE_FAST_MODE_PARAMETER_ID] ===
    CLAUDE_FAST_MODE_ON_VALUE
  );
}
