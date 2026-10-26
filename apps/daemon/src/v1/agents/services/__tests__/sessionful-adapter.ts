import { freshVocabularyStore } from '../../adapters/__tests__/fresh-vocabulary-store';
import type {
  AdapterConfig,
  AgentEvent,
  AgentModel,
} from '../../adapters/adapter.types';
import {
  AgentAdapter,
  type AgentAdapterOptions,
} from '../../adapters/agent-adapter';
import { CursorAcpAdapter } from '../../adapters/cursor-acp/cursor-acp.adapter';
import type { SpawnFn } from '../../utils/spawn-cli';

/**
 * A REAL adapter over whatever `spawn` hands it, for the cases whose subject
 * is a session state a hand-written session double cannot hold honestly — the
 * sessions it hands out are `AgentAdapter.startSession`'s own wrapper over the
 * real `runCliSession` state machine, so what the registry is told about a
 * process is what production tells it.
 *
 * Its CLI speaks one JSON object per line: `{run, cmd}` is a command the agent
 * ran, `{work, call}` the CLI announcing that command detached, `{done: true}`
 * the turn's result and `{failed: true}` an error result.
 */
export class SessionfulAdapter extends AgentAdapter {
  constructor(
    spawn: SpawnFn,
    options: Omit<AgentAdapterOptions, 'spawn'> = {},
  ) {
    super({ ...options, spawn });
  }

  protected get command(): string {
    return 'sessionful-cli';
  }

  getConfig(): AdapterConfig {
    return new CursorAcpAdapter({
      vocabularyStore: freshVocabularyStore(),
    }).getConfig();
  }

  protected buildArgs(): string[] {
    return [];
  }

  /** This fake CLI's whole result-line vocabulary. */
  protected mapMessage(obj: unknown): AgentEvent[] {
    const row = obj as {
      done?: boolean;
      failed?: boolean;
      run?: string;
      cmd?: string;
      work?: string;
      call?: string;
    };
    // A command the agent ran, then the CLI announcing it detached.
    if (typeof row.run === 'string') {
      return [
        {
          type: 'tool_call',
          id: row.run,
          name: 'Bash',
          input: { command: row.cmd },
        },
      ];
    }
    if (typeof row.work === 'string') {
      return [
        {
          type: 'background_work',
          id: row.work,
          phase: 'started',
          unit: 'other',
          toolCallId: row.call ?? null,
        },
      ];
    }
    if (row.done === true) {
      return [
        {
          type: 'turn_complete',
          usage: null,
          stopReason: null,
          finalText: null,
        },
      ];
    }
    if (row.failed === true) {
      return [{ type: 'error', message: 'result: is_error' }];
    }
    return [];
  }

  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }

  protected override canHostSession(): boolean {
    return true;
  }

  protected override buildNextTurnPayload(): string {
    return 'next\n';
  }

  /** Every real CLI that hosts a session has one; without it a cancel could
   * only kill the process group, which is a different case entirely. */
  protected override buildInterruptPayload(): string {
    return 'INTERRUPT\n';
  }
}
