import type { CommandEnding } from '../adapters/adapter.types';

export const COMMAND_END_WAKE_COMMAND_CHARS = 300;

export function commandEndWakePrompt(ended: readonly CommandEnding[]): string {
  return [
    ended.length === 1
      ? 'A background command you left running has finished since your turn ended:'
      : `${ended.length} background commands you left running have finished since your turn ended:`,
    ...ended.map(endingLine),
    '',
    'This message is how you learn it: a command you leave running does not report back on its own. Read its output if you need it and carry on with the task you were working on.',
    'The same completion may reach you once more after you answer this. It is this one again: do not report it a second time.',
  ].join('\n');
}

export function commandEndWakeMessage(count: number): string {
  return count === 1
    ? 'A background command finished after the turn ended, so the agent was started again to carry on.'
    : `${count} background commands finished after the turn ended, so the agent was started again to carry on.`;
}

function endingLine(ending: CommandEnding): string {
  const exit =
    ending.exitCode === null
      ? 'exit code unknown'
      : `exit code ${ending.exitCode}`;
  const output =
    ending.outputPath === null ? '' : `; its output is in ${ending.outputPath}`;
  return `- \`${oneLine(ending.command)}\` — ${exit}${output}`;
}

function oneLine(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > COMMAND_END_WAKE_COMMAND_CHARS
    ? `${flat.slice(0, COMMAND_END_WAKE_COMMAND_CHARS - 1)}…`
    : flat;
}
