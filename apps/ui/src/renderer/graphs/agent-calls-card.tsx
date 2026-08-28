import { TriangleAlert } from 'lucide-react';

import { SettingRow } from '../components/setting-row';
import { Badge } from '../components/ui/badge';
import type { AgentCallInfo } from './node-validate';

/**
 * Who this node may call, and who may call it — the call wiring as a BAND of
 * labelled rows, matching the Agent settings card directly above it.
 *
 * It was a `NoteBox` of seven stacked sentences: a heading, `May call: a, b, c`,
 * `Callable by: …`, a loop warning, two paragraphs explaining what a call edge
 * IS, a warning naming every callee with no description, and a per-CLI note
 * about questions. Nine lines of prose to state one fact a reader comes for.
 * REPORTED as "уберём этот блок, просто текстовый. Уберём лишнее, оставим
 * только то, что нужно… но как-то красиво это сделаем и компактно".
 *
 * What went is the PROSE, not a fact. Two of those paragraphs said the same
 * thing about every node in every workflow, so they are the section's own
 * one-line hint at the call site rather than a wall re-read on each selection;
 * the claude question sentence went with them, because it describes the
 * behaviour a reader would assume. Everything TRUE OF THIS NODE stayed, and
 * two of them read better as marks than as sentences (below).
 */
export function AgentCallsCard({
  info,
  agentKind,
}: {
  info: AgentCallInfo;
  /** Decides the one caveat that is a property of the CLI, not of the wiring. */
  agentKind: string;
}): React.JSX.Element {
  // Every name it can reach, plus which of them it cannot route to.
  const undescribed = new Set(info.undescribedCallees);
  return (
    // `@container` for the same reason the settings band above carries one: the
    // rows fit themselves to THIS card, whose width is a drag handle's.
    <div className="@container flex flex-col divide-y divide-border rounded-md border border-border bg-card">
      {info.callees.length > 0 ? (
        <SettingRow width="compact" label="Calls">
          <NameBadges names={info.callees} warn={undescribed} />
        </SettingRow>
      ) : null}
      {info.callers.length > 0 ? (
        <SettingRow width="compact" label="Called by">
          <NameBadges names={info.callers} warn={EMPTY} />
        </SettingRow>
      ) : null}
      {info.inCycle ? (
        <p className="px-3 py-2 text-xs text-warning">
          In a call loop — runtime calls are depth-capped.
        </p>
      ) : null}
      {/* The ONE question note that survived, and only for the CLI it is true
          of: cursor-agent can answer a callee's question itself but cannot
          escalate it, so an unanswered one ends the call rather than reaching
          the user. claude's path is the one a reader would assume, so saying it
          bought a line and told them nothing. */}
      {info.callees.length > 0 && agentKind === 'cursor-agent' ? (
        <p className="px-3 py-2 text-xs text-warning">
          Cannot escalate a callee&apos;s question to you — one it cannot answer
          itself times the call out.
        </p>
      ) : null}
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * One badge per name, wrapping.
 *
 * A badge rather than a comma-joined line, and that is the compactness: three
 * names in prose are read as a sentence, three pills are counted at a glance —
 * and a pill is the one shape that can carry a MARK, which is what turns the
 * old "No description on QA, Researcher — this agent sees only their names"
 * sentence into the two badges it is about. The reason rides each marked
 * badge's own hover, where it is about that node instead of about a list.
 */
function NameBadges({
  names,
  warn,
}: {
  names: readonly string[];
  warn: ReadonlySet<string>;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((name) => {
        const marked = warn.has(name);
        return (
          <Badge
            key={name}
            // `muted`, not the caramel `secondary`: a callee list is three or
            // four names, and filled pills at that count read as a row of
            // buttons on this warm palette — measured against the real panel.
            // Quiet pills leave the MARKED one as the only thing that draws the
            // eye, which is the right hierarchy: the actionable half is the
            // callee this agent cannot route to.
            variant={marked ? 'outline' : 'muted'}
            className={marked ? 'border-warning/40 text-warning' : undefined}
            title={
              marked
                ? `${name} has no description — this agent sees only the name and has nothing to route on.`
                : undefined
            }>
            {/* Colour is not the only carrier: the mark has to survive a
                reader who cannot tell amber from grey. */}
            {marked ? <TriangleAlert aria-hidden="true" /> : null}
            {name}
          </Badge>
        );
      })}
    </div>
  );
}
