import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type CSSProperties, useEffect, useState } from 'react';

import type { NodeKind } from '../../shared/contracts';
import { cn } from '../components/ui/utils';
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
}: {
  side: 'input' | 'output';
  kind: NodeKind;
  expanded: boolean;
  missing: boolean;
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
  // missing — only data rules can be required, so the destructive tint never
  // belongs on a call row.
  const toneOf = (rule: ConnectionRule): Tone =>
    rule.edge === 'call' ? 'call' : tone;

  if (!expanded) {
    // Geniro's collapsed slot: a uniform two-line summary pill on each side
    // — plural label + the rule-type count — so input and output always
    // mirror each other visually. ALL rule handles (call ones included) stay
    // mounted in the stack so existing edges never detach; only the top is
    // painted, and a collapsed drag always lands on that data handle — call
    // wires are drawn from the expanded rows.
    return (
      <div className="relative flex w-full items-center">
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
        <div className={cn(pill({ tone }), 'w-full')}>
          <div className="text-[10px] font-semibold leading-tight">{side}s</div>
          <div className="text-[10px] leading-tight opacity-60">
            {rules.length} connection{rules.length === 1 ? '' : 's'}
          </div>
        </div>
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
            {rule.edge === 'call' || rule.required || rule.multiple ? (
              <div className="text-[10px] leading-tight opacity-60">
                {[
                  rule.edge === 'call' && 'call',
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

  // Toggling re-lays-out the handles; re-measure after the DOM committed so
  // the attached edges follow them.
  useEffect(() => {
    updateNodeInternals(nodeId);
  }, [expanded, nodeId, updateNodeInternals]);

  return (
    <>
      <div className="flex gap-4 px-3 pt-3 pb-2.5">
        <div className="flex min-w-0 flex-1 justify-start">
          <PortsSide
            side="input"
            kind={kind}
            expanded={expanded}
            missing={missingInput}
          />
        </div>
        <div className="flex min-w-0 flex-1 justify-end">
          <PortsSide
            side="output"
            kind={kind}
            expanded={expanded}
            missing={missingOutput}
          />
        </div>
      </div>
      {/* The toggle: an 18px circle straddling the ports block's BOTTOM edge
          (the card's bottom border, or the error strip's divider), centered —
          a zero-height row keeps it out of flow. */}
      <div className="relative z-10 flex h-0 justify-center">
        <button
          type="button"
          aria-label={expanded ? 'Collapse ports' : 'Expand ports'}
          aria-expanded={expanded}
          className="nodrag absolute -top-[9px] flex size-[18px] items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:text-foreground"
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
            <ChevronUp aria-hidden="true" className="size-2.5" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-2.5" />
          )}
        </button>
      </div>
    </>
  );
}
