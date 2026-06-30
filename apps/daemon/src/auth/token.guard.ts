import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { RUNTIME_TOKEN, type RuntimeInfo } from './runtime';
import { safeEqual } from './safe-equal';

/**
 * Path prefixes reachable without the loopback bearer token: the readiness
 * probe the UI polls, Prometheus metrics, and the local Swagger/Scalar docs.
 */
const PUBLIC_PREFIXES = ['/health', '/metrics', '/swagger-api'];

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
 * Global guard enforcing the loopback bearer token on every HTTP route outside
 * the public allowlist — so any data route added in M2 is gated by default
 * (the WS upgrade is gated separately in ws.ts). OIDC auth from @packages/
 * http-server stays dormant; this is the local single-user gate.
 */
@Injectable()
export class LoopbackTokenGuard implements CanActivate {
  constructor(@Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const path = request.url.split('?')[0] ?? request.url;
    if (isPublic(path)) {
      return true;
    }
    const header = request.headers.authorization;
    return (
      typeof header === 'string' &&
      safeEqual(header, `Bearer ${this.runtime.token}`)
    );
  }
}
