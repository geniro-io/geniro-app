import { TriangleAlert } from 'lucide-react';

import { cn } from '../components/ui/utils';
import { AgentAvatar } from './agent-avatar';
import type { AgentCallInfo } from './node-validate';

/**
 * Who this node may call, and who may call it — one ROW per agent, each wearing
 * the same round initials avatar that agent wears on the canvas and in this
 * panel's own header.
 *
 * It began as a `NoteBox` of seven stacked sentences and became a band of
 * labelled rows whose values were badges. REPORTED against that band: "нам не
 * нужен белый фон… напротив каждого агента там можно его иконку даже
 * поставить". Two things behind it. The card was `bg-card` — the one WHITE
 * surface in a panel whose ground is warm muted, sitting under the Agent
 * settings band that has a reason to be a card (its rows are CONTROLS). This
 * section is read-only, so the frame was drawing a box around nothing.
 *
 * And a name in a pill is a name: three of them read as a row of small buttons
 * with no way to tell which agent is which without reading each one. The avatar
 * is the app's existing answer to that — `AgentAvatar` is what the node card
 * and this panel's header already identify an agent by — so a callee is
 * recognised here the same way it is recognised everywhere else, and the list
 * became something scanned rather than read.
 *
 * What did NOT change is which facts appear: everything true of THIS node
 * stayed, the undescribed-callee mark included (it is now the row's own amber
 * treatment rather than a pill's).
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
    <div className="flex flex-col gap-3">
      {info.callees.length > 0 ? (
        <NameList label="Calls" names={info.callees} warn={undescribed} />
      ) : null}
      {info.callers.length > 0 ? (
        <NameList label="Called by" names={info.callers} warn={EMPTY} />
      ) : null}
      {info.inCycle ? (
        <p className="text-xs text-warning">
          In a call loop — runtime calls are depth-capped.
        </p>
      ) : null}
      {/* The ONE question note that survived, and only for the CLI it is true
          of: cursor-agent can answer a callee's question itself but cannot
          escalate it, so an unanswered one ends the call rather than reaching
          the user. claude's path is the one a reader would assume, so saying it
          bought a line and told them nothing. */}
      {info.callees.length > 0 && agentKind === 'cursor-agent' ? (
        <p className="text-xs text-warning">
          Cannot escalate a callee&apos;s question to you — one it cannot answer
          itself times the call out.
        </p>
      ) : null}
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * One direction of the wiring: a micro-label over a row per agent.
 *
 * The label is the panel's own micro-label shape (the one `MenuGroup` uses),
 * not a `SettingRow`'s label COLUMN — a column costs a third of a 300px panel
 * to say one word, and buys alignment with controls this section does not have.
 * The count rides it because it is free there and the list may wrap past the
 * fold on a node wired to many.
 */
function NameList({
  label,
  names,
  warn,
}: {
  label: string;
  names: readonly string[];
  warn: ReadonlySet<string>;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        <span className="tabular-nums normal-case">{names.length}</span>
      </h4>
      <ul aria-label={label} className="flex flex-col gap-0.5">
        {names.map((name) => {
          const marked = warn.has(name);
          return (
            <li
              key={name}
              data-slot="call-row"
              className={cn(
                'flex items-center gap-2 rounded-md px-1.5 py-1 text-sm',
                marked && 'text-warning',
              )}
              title={
                marked
                  ? `${name} has no description — this agent sees only the name and has nothing to route on.`
                  : undefined
              }>
              <AgentAvatar
                label={name}
                className={cn(
                  'size-5 text-[9px]',
                  // The mark reaches the avatar too: at 20px it is the part of
                  // the row the eye lands on first.
                  marked && 'bg-warning/15 text-warning',
                )}
              />
              <span data-slot="call-name" className="min-w-0 truncate">
                {name}
              </span>
              {/* Colour is not the only carrier: the mark has to survive a
                  reader who cannot tell amber from grey. */}
              {marked ? (
                <TriangleAlert
                  aria-hidden="true"
                  className="ml-auto size-3.5 shrink-0"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
