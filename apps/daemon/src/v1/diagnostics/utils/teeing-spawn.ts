import { basename } from 'node:path';

import type { SpawnedProcess, SpawnFn } from '../../agents/utils/spawn-cli';
import { debugSink } from './debug-sink';

/**
 * Wrap a {@link SpawnFn} so every byte to and from the child is copied into
 * the debug log.
 *
 * The SPAWN is the seam, deliberately, and it is the only one that would not
 * have cost something. The alternatives were worse in ways the project's own
 * rules name: threading a tee callback through `AgentTurnInput` puts a
 * diagnostic concern into the adapter contract every CLI has to carry, and
 * hooking each adapter's own stdio handling means two implementations of one
 * thing that must not drift. A `SpawnFn` is already an injectable option on
 * every adapter (`AgentAdapterOptions.spawn`) — so this composes with the ONE
 * thing all of them share and knows nothing about any CLI.
 *
 * **What it can and cannot say about a line.** It knows the command, the pid
 * and the working directory, because those are what a spawn has. It does NOT
 * know the run: `AgentTurnInput` carries no run id (the adapter layer has no
 * business with one), and inventing an ambient one would be wrong under graph
 * fan-out, where N turns spawn concurrently. So entries are tagged by pid and
 * folder, which is enough to follow one process — and ambiguous only between
 * two chats open on the same folder at the same moment.
 */
export function createTeeingSpawn(inner: SpawnFn): SpawnFn {
  return (command, args, options) => {
    const child = inner(command, args, options);
    // Gated per call, not once: the channel is a live toggle, and a session
    // spawned while it was off must start reporting when it is turned on.
    const context = (): Record<string, string> => ({
      pid: String(child.pid ?? -1),
      command: basename(command),
      cwd: options.cwd,
    });
    debugSink.record(
      'agent-stdio',
      'info',
      `spawn ${basename(command)} ${args.join(' ')}`,
      context(),
    );

    // `data` listeners do not CONSUME — every listener receives every chunk —
    // so this observes without competing with the real reader. Attached in the
    // same tick as the spawn and before `runCliSession` attaches its own, so
    // no chunk can arrive in between (a stream emits nothing until the next
    // tick at the earliest).
    tap(child.stdout, (text) =>
      debugSink.record('agent-stdio', 'trace', `← ${text}`, context()),
    );
    tap(child.stderr, (text) =>
      debugSink.record('agent-stdio', 'warn', `⚠ ${text}`, context()),
    );

    child.on('exit', (code, signal) => {
      debugSink.record(
        'agent-stdio',
        code === 0 ? 'info' : 'warn',
        `exit ${basename(command)} code=${code} signal=${signal}`,
        context(),
      );
    });

    // stdin is a WRITE side, so it cannot be observed by listening — it has to
    // be wrapped. A Proxy rather than a subclass keeps every other member
    // (`end`, `once`, `destroyed`, the EventEmitter surface) identical to the
    // real stream, which is what the CLI session machinery drives it through.
    const stdin = child.stdin ? teeWrites(child.stdin, context) : child.stdin;

    // A fresh object rather than a mutation: `stdin` is a getter on a real
    // ChildProcess and assigning to it throws. Every other member delegates to
    // the actual child, so `kill` and `on` still act on the real process.
    const wrapped: SpawnedProcess = {
      get pid() {
        return child.pid;
      },
      get stdout() {
        return child.stdout;
      },
      get stderr() {
        return child.stderr;
      },
      stdin,
      on: (event: never, listener: never) => {
        (child.on as (e: never, l: never) => unknown)(event, listener);
        // `this`, the way a ChildProcess does — callers chain off it, and
        // returning the raw child here would hand them the UNWRAPPED stdin.
        return wrapped;
      },
      kill: (signal?: NodeJS.Signals) => child.kill(signal),
    } as SpawnedProcess;
    return wrapped;
  };
}

/** Copy a readable's chunks into the sink without consuming them. */
function tap(
  stream: NodeJS.ReadableStream | null,
  emit: (text: string) => void,
): void {
  if (!stream) {
    return;
  }
  stream.on('data', (chunk: Buffer | string) => {
    if (!debugSink.isEnabled('agent-stdio')) {
      return;
    }
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const trimmed = text.replace(/\n+$/, '');
    if (trimmed.length > 0) {
      emit(trimmed);
    }
  });
}

/** A writable that records what is written to it, then writes it on. */
function teeWrites(
  stream: NodeJS.WritableStream,
  context: () => Record<string, string>,
): NodeJS.WritableStream {
  return new Proxy(stream, {
    get(target, prop) {
      if (prop !== 'write') {
        const value = Reflect.get(target, prop, target) as unknown;
        // Methods are bound to the REAL stream: handed back unbound they would
        // run with the proxy as `this`, and node's internals reach for private
        // fields that only exist on the target.
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      }
      return (...writeArgs: unknown[]): unknown => {
        if (debugSink.isEnabled('agent-stdio')) {
          const [chunk] = writeArgs;
          const text =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : '';
          const trimmed = text.replace(/\n+$/, '');
          if (trimmed.length > 0) {
            debugSink.record('agent-stdio', 'debug', `→ ${trimmed}`, context());
          }
        }
        return (target.write as unknown as (...a: unknown[]) => unknown).apply(
          target,
          writeArgs,
        );
      };
    },
  }) as NodeJS.WritableStream;
}
