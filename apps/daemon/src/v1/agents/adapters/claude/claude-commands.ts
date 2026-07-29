import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AgentCommandOptions,
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapter.types';

/** Never reached by the model: the turn is cancelled the moment init lands. */
const PROBE_PROMPT = 'Reply with exactly: ok';

/** A hung probe must not wedge the caller forever. */
const PROBE_TIMEOUT_MS = 30_000;

/** Defensive bound — init reports ~60 entries today. */
const MAX_COMMANDS = 500;

/** What {@link probeClaudeCommands} needs of the adapter, and nothing more. */
interface CommandProbeDeps {
  /** The adapter's own `start` — the one spawn path for a turn. */
  start(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle;
  /** Root for the throwaway probe workspace. */
  probeRootDir: string;
}

/**
 * Ask claude for its own slash commands — the built-ins and plugin commands
 * that exist nowhere on disk to be scanned.
 *
 * `system/init`'s `slash_commands` is the only complete source of a session's
 * invokable set (Anthropic documents it as the SDK's list), and the CLI emits
 * it BEFORE the model runs. So this starts one headless turn and cancels it
 * the instant the list arrives — the same trick the permission-mode probe
 * uses, which makes the answer free.
 *
 * It runs in a throwaway temp cwd on purpose, on both counts: it fires no
 * project hooks and starts no session in a repo the user did not ask us to
 * touch, and the answer is CWD-INDEPENDENT — verified live, an empty temp dir
 * reports the same built-ins and plugin commands as a real project — so one
 * probe serves every folder. What that necessarily excludes is the per-project
 * layer, which the disk scan already covers.
 *
 * Returns `[]` when the CLI never reached its init line (missing binary, auth
 * failure, a hang). Never throws.
 */
export async function probeClaudeCommands(
  deps: CommandProbeDeps,
  options: AgentCommandOptions = {},
): Promise<string[]> {
  const cwd = join(deps.probeRootDir, `commands-${randomUUID()}`);
  let captured: string[] = [];
  try {
    mkdirSync(cwd, { recursive: true });
    let resolveCaptured!: () => void;
    const commandsSeen = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });
    // No approvalMode: the turn gets the CLI's own defaults and NO
    // permission-bypass flag. It is cancelled before the model runs, so the
    // least-privileged argv is also the sufficient one.
    const handle = deps.start({ prompt: PROBE_PROMPT, cwd }, (event) => {
      if (event.type === 'slash_commands' && captured.length === 0) {
        captured = event.commands
          // `_`-prefixed names are claude's INTERNAL commands
          // (`__remote-workflow`) — reported, but not things a user invokes.
          // SkillHarvestStore drops them from the other report path too.
          .filter((name) => !name.startsWith('_'))
          .slice(0, MAX_COMMANDS);
        resolveCaptured();
      }
    });
    options.onTurn?.(handle);
    const timer = setTimeout(
      () => handle.cancel(),
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    const capturedWon = await Promise.race([
      commandsSeen.then(() => true),
      handle.done.then(() => false),
    ]);
    if (capturedWon) {
      // Proof is in — the rest of the turn is spend without information.
      handle.cancel();
    }
    await handle.done;
    clearTimeout(timer);
  } catch {
    // A spawn that fails synchronously leaves the caller with the disk scan.
    return [];
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only: a straggler of the just-cancelled probe
      // process group writing into `cwd` can make rmSync throw
      // (EBUSY/ENOTEMPTY — `force` suppresses only ENOENT). That must never
      // fail the read; the temp dir is reaped on the next probe/boot.
    }
  }
  return captured;
}
