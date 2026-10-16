import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ForbiddenException } from '@packages/common';
import type { FastifyRequest } from 'fastify';

import { cameViaRemote } from './remote-marker';

/**
 * Refuses a request the LAN gateway proxied from a paired device — for routes
 * that act with the Mac user's own logins (an upload through their CLI, a
 * Keychain write), which a phone on the same network must not be able to
 * trigger. Applied per controller, on top of the global launch-token guard.
 */
@Injectable()
export class DesktopOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (cameViaRemote(request.headers)) {
      throw new ForbiddenException(
        'DESKTOP_ONLY',
        'this is only available on the Mac, not from a paired device',
      );
    }
    return true;
  }
}
