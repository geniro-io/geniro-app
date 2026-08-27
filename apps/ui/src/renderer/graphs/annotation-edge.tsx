import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from '@xyflow/react';
import { useState } from 'react';

import { cn } from '../components/ui/utils';
import type { AnnotationEdgeKind } from './node-schema';

/**
 * The ANNOTATION edges — the wires that are not data flow.
 *
 * A data edge means "this runs after that": it orders the DAG. `call` and
 * `instruction` edges order nothing, so both are drawn as dashed beziers with
 * a chip at the midpoint while hovered or selected, and only their tone and
 * wording differ. ONE component with a variant rather than two files: the
 * back-edge routing below is the fiddly half and a second copy of it is how
 * the two kinds come to disagree about where a wire goes.
 */
/** Back-edge loop geometry: horizontal reach past the handles, drop below
 *  the lower endpoint (clears the card bottom — handles sit near it), and
 *  the rounded-corner radius. */
const LOOP_EXT = 24;
const LOOP_DIP = 64;
const LOOP_RADIUS = 12;

/** What one annotation kind looks like and calls itself. */
interface AnnotationVariant {
  /** The midpoint chip's text — the wire's own name. */
  label: string;
  /** Stroke + arrowhead fill, always a token (a literal is an eslint error). */
  stroke: string;
  /** Chip surface classes, the token pair matching {@link stroke}. */
  chip: string;
  /** Arrowhead marker id — per variant, since the fill differs. */
  markerId: string;
}

const VARIANTS = {
  call: {
    label: 'call',
    stroke: 'var(--color-warning)',
    chip: 'bg-warning text-warning-foreground',
    markerId: 'geniro-call-arrow',
  },
  instruction: {
    label: 'instruction',
    stroke: 'var(--color-primary)',
    chip: 'bg-primary text-primary-foreground',
    markerId: 'geniro-instruction-arrow',
  },
  // Keyed by the kind union, not by `string`: `flowEdgeType` emits a React
  // Flow `type` for every annotation kind, so one without a variant here (and
  // a component in `Graphs.tsx`'s EDGE_TYPES) would silently fall back to the
  // solid default and draw as data flow.
} as const satisfies Record<AnnotationEdgeKind, AnnotationVariant>;

/**
 * Path for a BACK edge (target left of the source — every mutual call pair
 * has one): the default bezier between a right-side source and a left-side
 * target at similar heights degenerates to a near-straight line that runs
 * BEHIND both node cards (edges render under nodes), leaving only orphaned
 * stubs visible at the handles. Route it the way node editors draw feedback
 * wires instead: out of the source, down just below the cards, straight
 * across, and up into the target — a tight rounded-orthogonal loop.
 */
function backEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): [string, number, number] {
  const r = LOOP_RADIUS;
  const right = sourceX + LOOP_EXT;
  const left = targetX - LOOP_EXT;
  const dip = Math.max(sourceY, targetY) + LOOP_DIP;
  const path =
    `M ${sourceX},${sourceY} H ${right - r} Q ${right},${sourceY} ${right},${sourceY + r} ` +
    `V ${dip - r} Q ${right},${dip} ${right - r},${dip} ` +
    `H ${left + r} Q ${left},${dip} ${left},${dip - r} ` +
    `V ${targetY + r} Q ${left},${targetY} ${left + r},${targetY} H ${targetX}`;
  // Chip on the middle of the bottom run.
  return [path, (right + left) / 2, dip];
}

function makeAnnotationEdge(
  variant: AnnotationVariant,
  displayName: string,
): (props: EdgeProps) => React.JSX.Element {
  function AnnotationEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
  }: EdgeProps): React.JSX.Element {
    const [hovered, setHovered] = useState(false);
    const [path, labelX, labelY] =
      targetX < sourceX
        ? backEdgePath(sourceX, sourceY, targetX, targetY)
        : getBezierPath({
            sourceX,
            sourceY,
            sourcePosition,
            targetX,
            targetY,
            targetPosition,
          });
    return (
      // The group wraps BaseEdge's visible path AND its wide invisible
      // interaction path, so the hover chip triggers from the whole hit area.
      <g
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}>
        {/* Arrowhead pointing INTO the target — both of these wires are
            directional (a call permission, an instruction handed one way),
            and without a marker they read as symmetric. Every edge of a kind
            re-declares the same def; browsers resolve the shared id to the
            first one, so the duplication is inert. */}
        <defs>
          <marker
            id={variant.markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse">
            <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill={variant.stroke} />
          </marker>
        </defs>
        <BaseEdge
          id={id}
          path={path}
          markerEnd={`url(#${variant.markerId})`}
          style={{
            stroke: variant.stroke,
            strokeWidth: selected ? 2 : 1.5,
            strokeDasharray: '6 4',
          }}
        />
        {selected || hovered ? (
          <EdgeLabelRenderer>
            <span
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              }}
              className={cn(
                'pointer-events-none absolute rounded px-1.5 py-0.5 text-[10px] font-semibold',
                variant.chip,
              )}>
              {variant.label}
            </span>
          </EdgeLabelRenderer>
        ) : null}
      </g>
    );
  }
  AnnotationEdge.displayName = displayName;
  return AnnotationEdge;
}

/** Registered as React Flow edge type `call` — "may invoke at runtime". */
export const CallEdge = makeAnnotationEdge(VARIANTS.call, 'CallEdge');

/**
 * Registered as React Flow edge type `instruction` — "this block's text is
 * appended to that agent's turn".
 */
export const InstructionEdge = makeAnnotationEdge(
  VARIANTS.instruction,
  'InstructionEdge',
);
