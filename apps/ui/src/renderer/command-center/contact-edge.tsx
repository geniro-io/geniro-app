import { type Edge, type EdgeProps, getStraightPath } from '@xyflow/react';
import { cva } from 'class-variance-authority';
import { useEffect, useState } from 'react';

export const CONTACT_LIT_MS = 5 * 60 * 1000;
export const PULSE_TRAVEL_MS = 1200;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface ContactState {
  lastAt: string | null;
  awaitingReply: boolean;
}

export interface ContactPulse {
  id: string;
  threadId: string;
  at: string;
  direction: 'out' | 'in';
}

export type EdgeState = 'lit' | 'awaiting' | 'idle';

export function edgeStateOf(
  contact: ContactState | undefined,
  threadPulses: readonly Pick<ContactPulse, 'at'>[],
  now: number,
): EdgeState {
  if (contact?.awaitingReply) {
    return 'awaiting';
  }
  const touches = [
    ...threadPulses.map((pulse) => pulse.at),
    ...(contact?.lastAt ? [contact.lastAt] : []),
  ];
  return touches.some((at) => now - Date.parse(at) < CONTACT_LIT_MS)
    ? 'lit'
    : 'idle';
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const edgeVariants = cva('fill-none transition-[opacity,stroke] duration-200', {
  variants: {
    state: {
      lit: 'stroke-foreground/70 opacity-100',
      awaiting: 'stroke-warning opacity-100',
      idle: 'stroke-border-strong opacity-50',
    } satisfies Record<EdgeState, string>,
  },
});

function TravelDot({
  path,
  reverse,
}: {
  path: string;
  reverse: boolean;
}): React.JSX.Element | null {
  const [travelling, setTravelling] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setTravelling(false),
      PULSE_TRAVEL_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);
  if (!travelling) {
    return null;
  }
  return (
    <circle data-slot="contact-dot" r={3.5} className="fill-primary">
      <animateMotion
        dur={`${PULSE_TRAVEL_MS}ms`}
        fill="freeze"
        calcMode="linear"
        keyPoints={reverse ? '1;0' : '0;1'}
        keyTimes="0;1"
        path={path}
      />
    </circle>
  );
}

export interface ContactEdgeLineProps {
  id: string;
  path: string;
  state: EdgeState;
  pulses: readonly ContactPulse[];
  now: number;
}

export function ContactEdgeLine({
  id,
  path,
  state,
  pulses,
  now,
}: ContactEdgeLineProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const travelling = reducedMotion
    ? []
    : pulses.filter((pulse) => now - Date.parse(pulse.at) < PULSE_TRAVEL_MS);
  return (
    <g data-slot="contact-edge" data-edge={id} data-state={state}>
      <path
        aria-hidden="true"
        d={path}
        className={edgeVariants({ state })}
        strokeWidth={state === 'idle' ? 1.25 : 2}
        strokeDasharray={state === 'idle' ? '4 4' : undefined}
        strokeLinecap="round"
      />
      {travelling.map((pulse) => (
        <TravelDot
          key={pulse.id}
          path={path}
          reverse={pulse.direction === 'in'}
        />
      ))}
    </g>
  );
}

export interface ContactEdgeData extends Record<string, unknown> {
  state: EdgeState;
  pulses: readonly ContactPulse[];
  now: number;
}

export type ContactFlowEdge = Edge<ContactEdgeData, 'contact'>;

export function ContactEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<ContactFlowEdge>): React.JSX.Element {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const { state, pulses, now } = data!;
  return (
    <ContactEdgeLine
      id={id}
      path={path}
      state={state}
      pulses={pulses}
      now={now}
    />
  );
}
