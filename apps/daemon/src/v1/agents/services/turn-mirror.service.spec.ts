import { describe, expect, it } from 'vitest';

import {
  MAX_MIRRORS,
  MIRROR_BUFFER_CAP,
  TurnMirrorService,
} from './turn-mirror.service';

const RUN = 'run-1';
const NODE = 'main';

/** Collect everything a subscriber is handed, in order. */
function collect(
  service: TurnMirrorService,
  runId = RUN,
  nodeId = NODE,
): { chunks: string[]; completed: boolean } {
  const seen = { chunks: [] as string[], completed: false };
  service.stream(runId, nodeId).subscribe({
    next: (chunk) => seen.chunks.push(chunk),
    complete: () => {
      seen.completed = true;
    },
  });
  return seen;
}

describe('TurnMirrorService — what a mirror shows', () => {
  it('banners the argv, passes stdout through verbatim, and marks the end', () => {
    const service = new TurnMirrorService();
    const sink = service.sink(RUN, NODE);

    sink.spawned('claude', ['-p', '--model', 'claude-opus-5']);
    sink.data('stdout', '{"type":"system"}\n');
    sink.settled();

    const snapshot = service.snapshot(RUN, NODE);
    expect(snapshot).toContain('$ claude -p --model claude-opus-5');
    // Verbatim: the mirror's whole value is that it cannot drift from what the
    // process actually printed, so nothing here reformats or re-encodes it.
    expect(snapshot).toContain('{"type":"system"}\n');
    expect(snapshot).toContain('turn ended');
  });

  it('spans TURNS, not processes — the second turn appends to the first', () => {
    // The reason a mirror follows a conversation at all. A per-process buffer
    // would blank between turns, which is the standstill this replaces.
    const service = new TurnMirrorService();

    const first = service.sink(RUN, NODE);
    first.spawned('claude', ['-p']);
    first.data('stdout', 'turn one\n');
    first.settled();

    const second = service.sink(RUN, NODE);
    second.data('stdout', 'turn two\n');

    const snapshot = service.snapshot(RUN, NODE);
    expect(snapshot).toContain('turn one');
    expect(snapshot).toContain('turn two');
  });

  it('tints stderr so it is distinguishable, without altering its bytes', () => {
    // stderr appears on no other surface in the app: `runHeadlessCli` keeps
    // only a tail, and only for a failure message.
    const service = new TurnMirrorService();
    service.sink(RUN, NODE).data('stderr', 'a warning');

    const snapshot = service.snapshot(RUN, NODE);
    expect(snapshot).toContain('a warning');
    expect(snapshot).toContain('\u001b[31m');
    expect(snapshot).toContain('\u001b[0m');
  });

  it('quotes only an argument that needs it', () => {
    // The banner is meant to be pasteable back into a shell; quoting every
    // argument would make the common line unreadable for no gain.
    const service = new TurnMirrorService();
    service
      .sink(RUN, NODE)
      .spawned('claude', ['--append-system-prompt', 'You are a reviewer']);

    expect(service.snapshot(RUN, NODE)).toContain(
      "--append-system-prompt 'You are a reviewer'",
    );
  });

  it('delivers appends to a subscriber that attached first', () => {
    const service = new TurnMirrorService();
    const seen = collect(service);

    service.sink(RUN, NODE).data('stdout', 'live');

    expect(seen.chunks).toContain('live');
  });

  it('drops an empty chunk instead of publishing a no-op', () => {
    // An empty write from a child is real (a flush with nothing buffered) and
    // would otherwise wake every attached mirror for nothing.
    const service = new TurnMirrorService();
    const seen = collect(service);

    service.sink(RUN, NODE).data('stdout', '');

    expect(seen.chunks).toHaveLength(0);
  });
});

describe('TurnMirrorService — keying', () => {
  it('does not mix two nodes of one run', () => {
    // Under graph fan-out several agents run at once; one shared buffer would
    // interleave them into something unreadable.
    const service = new TurnMirrorService();
    service.sink(RUN, 'node-a').data('stdout', 'from a');
    service.sink(RUN, 'node-b').data('stdout', 'from b');

    expect(service.snapshot(RUN, 'node-a')).toBe('from a');
    expect(service.snapshot(RUN, 'node-b')).toBe('from b');
  });

  it('does not let one key be spelled two ways', () => {
    // The NUL separator: a node id is user-authored in workflow YAML, so any
    // printable separator is a character a node could legitimately contain.
    const service = new TurnMirrorService();
    service.sink('a', 'b:c').data('stdout', 'first');
    service.sink('a:b', 'c').data('stdout', 'second');

    expect(service.snapshot('a', 'b:c')).toBe('first');
    expect(service.snapshot('a:b', 'c')).toBe('second');
  });

  it('says nothing for a node that has never run', () => {
    expect(new TurnMirrorService().snapshot(RUN, 'never')).toBe('');
  });
});

describe('TurnMirrorService — bounds', () => {
  it('trims the oldest chunks past the buffer cap', () => {
    const service = new TurnMirrorService();
    const sink = service.sink(RUN, NODE);

    sink.data('stdout', 'OLDEST');
    sink.data('stdout', 'x'.repeat(MIRROR_BUFFER_CAP));

    const snapshot = service.snapshot(RUN, NODE);
    expect(snapshot).not.toContain('OLDEST');
    expect(snapshot.length).toBeLessThanOrEqual(MIRROR_BUFFER_CAP);
  });

  it('keeps the newest chunk even when it alone exceeds the cap', () => {
    // The trim stops at one chunk on purpose: emptying the buffer to satisfy
    // the cap would show a blank mirror for a turn that is producing output.
    const service = new TurnMirrorService();
    service.sink(RUN, NODE).data('stdout', 'y'.repeat(MIRROR_BUFFER_CAP + 10));

    expect(service.snapshot(RUN, NODE)).toHaveLength(MIRROR_BUFFER_CAP + 10);
  });

  it('evicts the least recently touched IDLE buffer past the mirror cap', () => {
    const service = new TurnMirrorService();
    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      const sink = service.sink(`run-${i}`, NODE);
      // spawned() BEFORE settled(): the incumbents are evictable only because
      // `settled` released the live-turn count. Without the spawn they would
      // start at zero and this would pass with the release deleted.
      sink.spawned('claude', ['-p']);
      sink.data('stdout', `output ${i}`);
      sink.settled();
    }
    // Touch the very first so it is no longer the oldest. (`snapshot` does not
    // touch; the `sink` call on the next line is what does.)
    expect(service.snapshot('run-0', NODE)).toContain('output 0');
    service.sink('run-0', NODE).data('stdout', 'still here');

    service.sink('one-too-many', NODE).data('stdout', 'newcomer');

    expect(service.snapshot('run-1', NODE)).toBe('');
    expect(service.snapshot('run-0', NODE)).toContain('still here');
    expect(service.snapshot('one-too-many', NODE)).toContain('newcomer');
  });

  it('never evicts a buffer whose turn is still running', () => {
    // The defensive branch: evicting mid-turn would blind a mirror the user is
    // watching, and the turn would go on writing into a buffer nothing holds.
    const service = new TurnMirrorService();
    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      // `spawned` raises the live-turn count and nothing settles it.
      service.sink(`run-${i}`, NODE).spawned('claude', ['-p']);
    }

    service.sink('one-too-many', NODE).data('stdout', 'newcomer');

    // Every incumbent survived, and the newcomer was still created.
    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      expect(service.snapshot(`run-${i}`, NODE)).not.toBe('');
    }
    expect(service.snapshot('one-too-many', NODE)).toContain('newcomer');
  });

  it('forgets an evicted buffer without declaring the node ended', () => {
    // Eviction ages history out; it is not a lifecycle event. Completing the
    // subject would tell a mirror the node finished — which `drop()` means and
    // eviction does not. (Only an UNWATCHED buffer is evictable at all, pinned
    // by the watched-buffer cases below.)
    const service = new TurnMirrorService();
    service.sink('victim', NODE).data('stdout', 'doomed');
    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      service.sink(`filler-${i}`, NODE).data('stdout', 'x');
    }

    expect(service.snapshot('victim', NODE)).toBe('');
    // A fresh subscriber gets a working stream, not an already-completed one.
    const seen = collect(service, 'victim', NODE);
    service.sink('victim', NODE).data('stdout', 'a later turn');
    expect(seen.completed).toBe(false);
    expect(seen.chunks).toContain('a later turn');
  });
});

describe('TurnMirrorService — dropping a deleted run', () => {
  it('forgets every node of the run and completes their streams', () => {
    const service = new TurnMirrorService();
    service.sink(RUN, 'node-a').data('stdout', 'a');
    service.sink(RUN, 'node-b').data('stdout', 'b');
    const seen = collect(service, RUN, 'node-a');

    service.drop(RUN);

    expect(service.snapshot(RUN, 'node-a')).toBe('');
    expect(service.snapshot(RUN, 'node-b')).toBe('');
    expect(seen.completed).toBe(true);
  });

  it('stays forgotten when a straggler turn writes after the drop', () => {
    // The delete path cancels, waits for the in-flight turn, then drops — but
    // that wait is bounded, and `settled` lands on a later tick regardless. A
    // sink that re-resolves its key on every write therefore RE-CREATES the
    // buffer of a run no route can reach any more: history nothing will ever
    // drop again, pressing on the mirror ceiling until eviction happens to
    // reach it.
    const service = new TurnMirrorService();
    const sink = service.sink(RUN, NODE);
    sink.spawned('claude', ['-p']);
    sink.data('stdout', 'before the delete');

    service.drop(RUN);
    sink.data('stdout', 'a chunk the cancelled turn was still flushing');
    sink.settled();

    expect(service.snapshot(RUN, NODE)).toBe('');
  });

  it('leaves another run alone, including one whose id shares a prefix', () => {
    // `drop` scans by key prefix; without the NUL boundary, deleting `run-1`
    // would take `run-10` with it.
    const service = new TurnMirrorService();
    service.sink('run-1', NODE).data('stdout', 'one');
    service.sink('run-10', NODE).data('stdout', 'ten');

    service.drop('run-1');

    expect(service.snapshot('run-1', NODE)).toBe('');
    expect(service.snapshot('run-10', NODE)).toBe('ten');
  });
});

describe('TurnMirrorService — a node running several turns at once', () => {
  it('ends only when the LAST turn does, not the first', () => {
    // A callable DAG node holds its own turn plus up to MAX_PARALLEL_SUB_TURNS
    // callee sub-turns, and they share one buffer. With a boolean flag the
    // first finisher printed "turn ended" into a stream still being written and
    // re-exposed the buffer to eviction mid-run.
    const service = new TurnMirrorService();
    const dagTurn = service.sink(RUN, NODE);
    const subTurn = service.sink(RUN, NODE);
    dagTurn.spawned('claude', ['-p']);
    subTurn.spawned('claude', ['-p']);

    dagTurn.settled();
    expect(service.snapshot(RUN, NODE)).not.toContain('turn ended');

    subTurn.data('stdout', 'the sub-turn is still working');
    subTurn.settled();
    expect(service.snapshot(RUN, NODE)).toContain('turn ended');
  });

  it('stays un-evictable while any of its turns is still running', () => {
    const service = new TurnMirrorService();
    const dagTurn = service.sink(RUN, NODE);
    const subTurn = service.sink(RUN, NODE);
    dagTurn.spawned('claude', ['-p']);
    subTurn.spawned('claude', ['-p']);
    dagTurn.settled();

    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      service.sink(`filler-${i}`, NODE).data('stdout', 'x');
    }

    // Survived the eviction sweep — one turn is still writing to it.
    expect(service.snapshot(RUN, NODE)).not.toBe('');
  });

  it('a turn that never spawned cannot release a sibling’s live count', () => {
    // `AgentAdapter.start` reports `settled` on its SYNCHRONOUS-throw path too
    // — a turn whose argv build or per-turn resource failed before any spawn
    // (the executor guards that path explicitly). Such a turn never raised the
    // count, so releasing one steals the slot of the sibling turn still writing
    // to the same node: the buffer announces "turn ended" mid-run and goes back
    // on the eviction list while the agent is still printing.
    const service = new TurnMirrorService();
    const running = service.sink(RUN, NODE);
    const neverSpawned = service.sink(RUN, NODE);
    running.spawned('claude', ['-p']);

    neverSpawned.settled();

    expect(service.snapshot(RUN, NODE)).not.toContain('turn ended');
    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      service.sink(`filler-${i}`, NODE).data('stdout', 'x');
    }
    expect(service.snapshot(RUN, NODE)).not.toBe('');
  });

  it('lets a turn release only what it took, however often it settles', () => {
    // `settled` is reached on several exit paths, so a sink can hear it twice.
    // The release is per-sink, not a bare decrement: a second one must not free
    // a count this turn no longer holds and declare a sibling finished.
    const service = new TurnMirrorService();
    const first = service.sink(RUN, NODE);
    const second = service.sink(RUN, NODE);
    first.spawned('claude', ['-p']);
    first.settled();
    first.settled();
    second.spawned('claude', ['-p']);

    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      service.sink(`filler-${i}`, NODE).data('stdout', 'x');
    }

    expect(service.snapshot(RUN, NODE)).not.toBe('');
  });
});

describe('TurnMirrorService — a buffer somebody is watching', () => {
  it('is never evicted, so the NEXT turn still reaches the subscriber', () => {
    // Eviction completes the subject, and a mirror session reads that as "the
    // stream ended". The next turn would then get a brand-new subject and the
    // panel would sit on "ended" while the agent runs — the exact standstill
    // this feature exists to remove.
    const service = new TurnMirrorService();
    const seen = collect(service, 'watched', NODE);
    service.sink('watched', NODE).data('stdout', 'first turn');

    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      service.sink(`filler-${i}`, NODE).data('stdout', 'x');
    }
    service.sink('watched', NODE).data('stdout', 'second turn');

    expect(seen.completed).toBe(false);
    expect(seen.chunks).toContain('second turn');
  });

  it('becomes evictable again once nobody is watching', () => {
    // Otherwise one panel opened long ago would pin a buffer for the daemon's
    // life and quietly shrink the ceiling.
    const service = new TurnMirrorService();
    const sub = service.stream('watched', NODE).subscribe();
    service.sink('watched', NODE).data('stdout', 'x');
    sub.unsubscribe();

    for (let i = 0; i < MAX_MIRRORS; i += 1) {
      service.sink(`filler-${i}`, NODE).data('stdout', 'x');
    }

    expect(service.snapshot('watched', NODE)).toBe('');
  });

  it("drops a straggler write rather than resurrecting a deleted run's buffer", () => {
    // The sink is created once per turn but the buffer can be removed under it:
    // the teardown waits a bounded 5s for in-flight work and then drops anyway,
    // and `settled` always lands a tick after the child exits. Re-resolving
    // through `ensure` would recreate the buffer — holding a deleted run's raw
    // stdio in a slot nothing would ever drop again — so the writer resolves
    // WITHOUT creating and a straggler's output simply goes nowhere.
    const service = new TurnMirrorService();
    const sink = service.sink(RUN, NODE);
    sink.spawned('claude', ['-p']);

    service.drop(RUN);
    sink.data('stdout', 'a chunk the cancelled turn was still writing');
    sink.settled();

    expect(service.snapshot(RUN, NODE)).toBe('');
  });
});
