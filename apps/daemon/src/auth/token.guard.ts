import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CallTokenRegistry } from './call-token.registry';
import { RUNTIME_TOKEN, type RuntimeInfo } from './runtime';
import { safeEqual } from './safe-equal';

/**
 * Path prefixes reachable without the loopback bearer token: the readiness
 * probe the UI polls, and the artifact page below. `/metrics` and
 * `/swagger-api` are token-gated — with a deterministic default port, any web
 * page could otherwise read the daemon's Prometheus internals and full API
 * schema cross-origin (the supervisor and any local tooling already hold the
 * pidfile token).
 *
 * **`/v1/artifacts` is not ungated — it is gated somewhere this guard cannot
 * reach.** An artifact page is loaded as an `<iframe src>`, and there is no API
 * by which a frame's request can carry a bearer header, so the credential has
 * to ride the URL. What rides it is a per-ARTIFACT capability the store minted
 * (256 bits) rather than the launch token, which is the master key of the whole
 * daemon and does not belong in a URL handed to a page an agent wrote. The
 * check is enforced inside `ArtifactStoreService.read`, which takes the key as
 * a required argument and compares it in constant time — there is no path that
 * reads a document without presenting one, so nothing here can be bypassed by
 * forgetting a check at the route.
 *
 * It is listed here rather than verified in this guard because the keys live on
 * disk beside the pages and outlive a daemon restart (an old transcript row
 * still opens its page), so an in-memory registry like {@link CallTokenRegistry}
 * could not answer for them — and reaching into a `v1/` feature's file store
 * from this infrastructure guard would invert the layering.
 */
const PUBLIC_PREFIXES = ['/health', '/v1/artifacts'];

/** The per-run MCP endpoint namespace (see McpController). */
const MCP_PREFIX = '/v1/mcp/';

/**
 * True when `path` is the prefix itself or a sub-path under it — a
 * segment-boundary match, so a sibling route like `/health-debug` does NOT
 * inherit the allowlist (a bare `startsWith` would let it bypass auth).
 */
function isPublic(path: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * The `(runId, nodeId)` of an MCP route (`/v1/mcp/<runId>/<nodeId>`), or null
 * off that namespace / when either segment is missing. Fastify hands the path
 * percent-encoded; decode both so the registry lookup sees the same ids the
 * executor issued the token under. Binding to the nodeId (not just the runId)
 * is what stops one caller's token from opening another caller's route.
 */
function mcpTarget(path: string): { runId: string; nodeId: string } | null {
  if (!path.startsWith(MCP_PREFIX)) {
    return null;
  }
  const segments = path.slice(MCP_PREFIX.length).split('/');
  const [rawRun, rawNode] = segments;
  if (!rawRun || !rawNode) {
    return null;
  }
  try {
    return {
      runId: decodeURIComponent(rawRun),
      nodeId: decodeURIComponent(rawNode),
    };
  } catch {
    return null;
  }
}

/**
 * Global guard enforcing the loopback bearer token on every HTTP route outside
 * the public allowlist — so any data route added in M2 is gated by default
 * (the WS handshake is gated in auth/ws-auth.ts — enforceWsHandshakeAuth,
 * shared by every Socket.IO gateway). OIDC auth from @packages/http-server
 * stays dormant; this is the local single-user gate.
 *
 * The `/v1/mcp/<runId>/<nodeId>` namespace additionally accepts that caller
 * node's own call token (minted when the run starts, revoked when it settles)
 * — a caller agent's credential opens exactly its own MCP route and nothing
 * else (not another node's, not another run's, not the REST API), while the
 * launch token stays the master key everywhere.
 */
@Injectable()
export class LoopbackTokenGuard implements CanActivate {
  constructor(
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly callTokens: CallTokenRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const path = request.url.split('?')[0] ?? request.url;
    if (isPublic(path)) {
      return true;
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      return false;
    }
    if (safeEqual(header, `Bearer ${this.runtime.token}`)) {
      return true;
    }
    const target = mcpTarget(path);
    if (target === null) {
      return false;
    }
    const callToken = this.callTokens.get(target.runId, target.nodeId);
    return callToken !== null && safeEqual(header, `Bearer ${callToken}`);
  }
}
