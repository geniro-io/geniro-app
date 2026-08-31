import {
  Handle,
  Position,
  useEdges,
  useUpdateNodeInternals,
} from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';

import { cn } from '../components/ui/utils';
import type { NodeKind } from './node-schema';
import {
  type ConnectionRule,
  makeHandleId,
  NODE_CONNECTION_RULES,
} from './node-schema';

/**
 * The collapsible ports block shared by every node card — geniro's
 * GraphNodeCard ports section. Collapsed (the default) each side shows one
 * summary pill with ALL of its rule handles stacked behind it (only the top
 * one painted), so edges stay attached and connectable in either state.
 * Expanded, every connection rule gets its own labeled row — the label is the
 * peer kind it accepts/produces — with its own handle.
 *
 * Handle ids come from `makeHandleId`, matching the ids `toFlow` derives for
 * stored edges; colours are tokens only (`var(--color-*)`).
 */
type Tone = 'input' | 'output' | 'call' | 'missing';

const pill = cva('rounded px-2 py-1', {
  variants: {
    tone: {
      input: 'bg-primary/10 text-primary',
      output: 'bg-success/10 text-success',
      call: 'bg-warning/10 text-warning',
      missing: 'bg-destructive/10 text-destructive',
    },
  },
});

/**
 * The COLLAPSED side's caption — text alone, no fill.
 *
 * Muted rather than tinted in the ordinary case, because a filled pill per side
 * put two coloured blocks on every card and they competed with the node's own
 * name; here the tone is spent on the one state worth spotting across a canvas,
 * a side that is missing a wire it requires.
 */
const caption = cva('', {
  variants: {
    tone: {
      input: 'text-muted-foreground',
      output: 'text-muted-foreground',
      call: 'text-muted-foreground',
      missing: 'font-medium text-destructive',
    },
  },
});

const TONE_VAR: Record<Tone, string> = {
  input: 'var(--color-primary)',
  output: 'var(--color-success)',
  call: 'var(--color-warning)',
  missing: 'var(--color-destructive)',
};

/** Stacked-when-collapsed handle dot; `hidden` keeps the handle connectable
 *  while only the top of the stack is painted (geniro's collapsed trick). */
function handleStyle(
  anchor: 'left' | 'right',
  tone: Tone,
  hidden: boolean,
  zIndex?: number,
): CSSProperties {
  return {
    width: 12,
    height: 12,
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    ...(anchor === 'left' ? { left: -18 } : { right: -18 }),
    background: hidden ? 'transparent' : TONE_VAR[tone],
    border: hidden ? 'none' : '2px solid var(--color-card)',
    boxShadow: hidden ? 'none' : `0 0 0 1px ${TONE_VAR[tone]}`,
    ...(zIndex === undefined ? {} : { zIndex }),
  };
}

function PortsSide({
  side,
  kind,
  expanded,
  missing,
  wired,
}: {
  side: 'input' | 'output';
  kind: NodeKind;
  expanded: boolean;
  missing: boolean;
  /** How many edges are ACTUALLY attached to this side — see {@link NodePorts}. */
  wired: number;
}): React.JSX.Element | null {
  // An unknown kind (daemon/renderer version skew) has no rules — render no
  // ports rather than crash; the card's validation strip names the problem.
  const rules =
    NODE_CONNECTION_RULES[kind]?.[side === 'input' ? 'inputs' : 'outputs'] ??
    [];
  if (rules.length === 0) {
    return null;
  }
  const dir = side === 'input' ? 'target' : 'source';
  const position = side === 'input' ? Position.Left : Position.Right;
  // The card edge the handles anchor to — named apart from rule.edge (the
  // EdgeKind), which shares this scope.
  const anchor = side === 'input' ? 'left' : 'right';
  const tone: Tone = missing ? 'missing' : side;
  // Call rules keep their amber identity even while a required DATA input is
  // missing — a call row is never what a missing input is about, so the
  // destructive tint would point at the wrong wire. Every other kind takes
  // the side tone, which `missing` already overrides per SIDE: an instruction
  // block flagged for wiring nothing IS flagged on its output side, and the
  // pill, the handle and the expanded row have to agree about that.
  const toneOf = (rule: ConnectionRule): Tone =>
    rule.edge === 'call' ? 'call' : tone;

  if (!expanded) {
    // COLLAPSED is a caption, not a block. It used to be a two-line filled pill
    // per side, which cost a flat 53px of every card — measured 41% of a
    // trigger's whole height and 31% of an agent's — to restate, on a canvas,
    // what the wires themselves already draw.
    //
    // And the figure it restated was NOT what its word said. `rules.length` is
    // how many connection RULES this node KIND accepts, so every agent card on
    // every graph read `inputs 4 connections · outputs 2 connections`,
    // identically, whether it was wired to six nodes or to none. It looked like
    // a live reading and was a constant. The count here is the edges ACTUALLY
    // attached to this side, which is the thing a reader was trying to learn
    // from it — and it is worth keeping precisely because zero is the case the
    // eye misses on a busy canvas.
    //
    // ALL rule handles (the annotation ones included) stay mounted in the stack
    // so existing edges never detach; only the top is painted, so a collapsed
    // drag lands on the kind's FIRST rule — data for an agent or a trigger,
    // `instruction` for a block, which has no other. Call wires are drawn from
    // the expanded rows.
    return (
      <div
        className={cn(
          'relative flex w-full items-center text-[10px] leading-none',
          side === 'output' && 'justify-end',
        )}>
        {rules.map((rule, index) => (
          <Handle
            key={`${rule.edge}-${rule.kind}`}
            type={dir}
            id={makeHandleId(dir, rule.edge, rule.kind)}
            position={position}
            style={handleStyle(
              anchor,
              toneOf(rule),
              index > 0,
              rules.length - index,
            )}
          />
        ))}
        <span className={cn(caption({ tone }))}>
          {wired} {side}
          {wired === 1 ? '' : 's'}
        </span>
      </div>
    );
  }
  // Every row fills its column — both sides are equal flex-1 columns, so all
  // labels come out the same width.
  return (
    <div className="flex w-full flex-col gap-1.5">
      {rules.map((rule) => (
        <div
          key={`${rule.edge}-${rule.kind}`}
          className="relative flex w-full items-center">
          <Handle
            type={dir}
            id={makeHandleId(dir, rule.edge, rule.kind)}
            position={position}
            style={handleStyle(anchor, toneOf(rule), false)}
          />
          <div className={cn(pill({ tone: toneOf(rule) }), 'w-full')}>
            <div className="text-[10px] font-semibold leading-tight">
              {rule.kind}
            </div>
            {rule.edge !== 'data' || rule.required || rule.multiple ? (
              <div className="text-[10px] leading-tight opacity-60">
                {[
                  // Data flow is the unmarked case; every other wire names
                  // itself, or an annotation row reads as an ordinary input.
                  rule.edge !== 'data' && rule.edge,
                  rule.required && 'required',
                  rule.multiple && 'multiple',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function NodePorts({
  nodeId,
  kind,
  missingInput,
  missingOutput,
}: {
  nodeId: string;
  kind: NodeKind;
  missingInput: boolean;
  missingOutput: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const updateNodeInternals = useUpdateNodeInternals();
  const edges = useEdges();

  // What is actually WIRED to this node, per side — the figure the collapsed
  // caption reports. Counted off the live canvas edges rather than the node's
  // rule table, which is what the block used to print; see `PortsSide`.
  //
  // One pass over the edges rather than two filters, because this runs for
  // every node on every edge change — a drag across a forty-node graph is
  // forty of these per frame.
  const wired = useMemo(() => {
    let inputs = 0;
    let outputs = 0;
    for (const edge of edges) {
      if (edge.target === nodeId) {
        inputs += 1;
      }
      if (edge.source === nodeId) {
        outputs += 1;
      }
    }
    return { inputs, outputs };
  }, [edges, nodeId]);

  // Toggling re-lays-out the handles; re-measure after the DOM committed so
  // the attached edges follow them.
  useEffect(() => {
    updateNodeInternals(nodeId);
  }, [expanded, nodeId, updateNodeInternals]);

  return (
    <>
      {/* Collapsed this is one caption-height row; expanded it opens into the
          named rule rows and needs the room. The padding follows the state
          rather than being sized for the taller of the two, which is what left
          a flat 53px under every collapsed card. */}
      <div
        className={cn(
          'flex gap-2 px-3',
          expanded ? 'pt-3 pb-2.5' : 'pt-1.5 pb-2',
        )}>
        <div className="flex min-w-0 flex-1 justify-start">
          <PortsSide
            side="input"
            kind={kind}
            expanded={expanded}
            missing={missingInput}
            wired={wired.inputs}
          />
        </div>
        {/* The toggle lives BETWEEN the two captions, inside the card.
            It used to be an 18px circle straddling the card's bottom border,
            which was fine on a resting card and broke on a selected one: the
            selection ring runs along that same edge, and a circle with its own
            fill sitting on top of it punched a visible hole through the
            outline — REPORTED together with the triple border above. Nothing
            that straddles a card's silhouette can survive a state that redraws
            that silhouette, so it moved inside rather than being re-layered.
            The row already had a wide empty middle for it, and the `h-0`
            wrapper, the negative offset and the `z-10` all went with it. */}
        <button
          type="button"
          aria-label={expanded ? 'Collapse ports' : 'Expand ports'}
          aria-expanded={expanded}
          className="nodrag flex size-4 shrink-0 self-center items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onPointerDown={(event) => {
            // Neither drag nor select the node from the toggle.
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}>
          {expanded ? (
            <ChevronUp aria-hidden="true" className="size-3" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3" />
          )}
        </button>
        <div className="flex min-w-0 flex-1 justify-end">
          <PortsSide
            side="output"
            kind={kind}
            expanded={expanded}
            missing={missingOutput}
            wired={wired.outputs}
          />
        </div>
      </div>
    </>
  );
}
