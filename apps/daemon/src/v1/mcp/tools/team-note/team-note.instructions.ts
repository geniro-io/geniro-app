import { TEAM_NOTE_MAX_CHARS } from '../../../agents/chat.types';

/** What a model reads about `team_note`. */
export function teamNoteInstructions(): string {
  return (
    "Write a note to this workflow run's shared team notes — one store every agent of the run can " +
    'read with team_notes, whoever called whom, or nobody. Use it when you learn something another ' +
    'agent of this run would otherwise have to rediscover, or could get wrong. Pick the `kind`: ' +
    '`contract` — an interface others build against, settled before parallel work starts (an API ' +
    'shape, a file format, who owns which files); `decision` — a choice and the reason for it; ' +
    '`fact` — something you verified that the code does not make obvious (a version, where a ' +
    'setting is really read, a command that works); `pitfall` — what you tried, why it failed and ' +
    'what worked instead; `pointer` — where a result lives (a file, a pull request, a page) instead ' +
    'of the result itself. Do not use it for progress reports, "I am stuck" or questions — your ' +
    'caller hears those from your reply, ask or message_agent — nor for whole outputs, nor for what ' +
    'the code, AGENTS.md or the task already says. Nobody is woken by a note; it waits to be read. ' +
    'Write each note so it stands alone: the reader has none of your context. When something you ' +
    "wrote stops being true, write the correct note with `supersedes` set to the old note's number " +
    'instead of contradicting it; the old one stays, marked superseded. The reply names your note ' +
    `(\`note 128\`) and how many notes by others you have not read. At most ${TEAM_NOTE_MAX_CHARS} ` +
    'characters per note.'
  );
}
