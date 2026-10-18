/**
 * Keep the global `fetch` main uses from crashing the process with
 * `setTypeOfService EINVAL`.
 *
 * The undici that Node 24 bundles (7.x) sets a type of service on every plain
 * HTTP/1 socket the first time it writes a request on it — `writeH1` calls
 * `socket.setTypeOfService(0)` with no try/catch — and Node's `net` throws
 * any errno that comes back. macOS answers EINVAL once the peer has reset the
 * connection, and undici routinely holds a connected socket with nothing to
 * send (the requests it was opened for having failed on an earlier reset), so
 * under load the next loopback POST lands on a dead socket, the throw escapes
 * from a microtask, and Electron shows its "A JavaScript error occurred in the
 * main process" dialog. Fixed upstream in undici 8 (nodejs/undici#5547), which
 * no Node 24 or Electron release ships yet.
 *
 * The way around it uses only undici's public options: an Agent whose sockets
 * are CREATED with `typeOfService: 0`. Node then applies it at connect, where a
 * refusal is reported as the socket's `error` event and fails the request like
 * any other connection error; and `writeH1`'s later call carries the value the
 * socket already has, which `net` skips without a syscall. Only plain-http
 * sockets were ever exposed — a TLS socket has no type-of-service handle — so
 * in this process it is the loopback calls to the daemon this protects.
 */

/**
 * Where undici keeps the dispatcher every global `fetch` uses. Node's bundled
 * undici reads the `.1` key; undici 7+ also writes `.2`, so both are set.
 */
const GLOBAL_DISPATCHER_KEYS = [
  Symbol.for('undici.globalDispatcher.1'),
  Symbol.for('undici.globalDispatcher.2'),
] as const;

interface AgentOptions {
  connect: { typeOfService: number };
}

type AgentClass = new (options: AgentOptions) => object;

/**
 * Swap the global dispatcher for undici's own Agent with the type of service
 * set at connect. Returns null when installed, or why it left the dispatcher
 * alone: anything other than undici's default Agent (a proxy agent from
 * `NODE_USE_ENV_PROXY`, say) is someone's deliberate choice and is never
 * replaced.
 */
export function installFetchDispatcher(
  scope: Record<PropertyKey, unknown> = globalThis as unknown as Record<
    PropertyKey,
    unknown
  >,
): string | null {
  // Node loads its undici lazily, and only loading it installs the default
  // dispatcher; reading one of its globals is what loads it.
  void scope.Headers;
  const current = scope[GLOBAL_DISPATCHER_KEYS[0]];
  if (typeof current !== 'object' || current === null) {
    return 'no global fetch dispatcher to replace';
  }
  const Agent = current.constructor as AgentClass | undefined;
  if (typeof Agent !== 'function' || Agent.name !== 'Agent') {
    return `the global fetch dispatcher is ${Agent?.name ?? 'unnamed'}, not undici's default Agent`;
  }
  const replacement = new Agent({ connect: { typeOfService: 0 } });
  for (const key of GLOBAL_DISPATCHER_KEYS) {
    scope[key] = replacement;
  }
  return null;
}
