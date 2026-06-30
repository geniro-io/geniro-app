import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../guards/auth.guard';
import { RoleGuard } from '../guards/role.guard';

export const REQUIRED_ROLES_KEY = 'requiredRoles';

export interface OnlyForAuthorizedOptions {
  roles?: string[];
}

export const OnlyForAuthorized = (options?: OnlyForAuthorizedOptions) => {
  const decorators = [UseGuards(AuthGuard)];

  if (options?.roles?.length) {
    decorators.push(
      SetMetadata(REQUIRED_ROLES_KEY, options.roles),
      UseGuards(RoleGuard),
    );
  }

  return applyDecorators(...decorators);
};
