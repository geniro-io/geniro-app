import { UnauthorizedException } from '@packages/common';
import type { FastifyRequest } from 'fastify';

import type { IContextData } from './auth.types';

export class AuthContextStorage<T extends IContextData = IContextData> {
  constructor(
    protected readonly contextData: T | undefined,
    protected readonly request: FastifyRequest,
  ) {}

  public get sub(): string | undefined {
    return this.contextData?.sub;
  }

  public checkSub(): string {
    const sub = this.sub;

    if (!sub) {
      throw new UnauthorizedException('UNAUTHORIZED', 'No sub');
    }

    return sub;
  }

  public context(): T | undefined {
    return this.contextData;
  }

  public get isAuthorized() {
    return !!this.contextData;
  }
}
