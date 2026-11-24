import { type ParseArrayOptions, ParseArrayPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import { ValidationPipe } from './validation.pipe';

export class ArrayValidationPipe extends ParseArrayPipe {
  constructor(options?: ParseArrayOptions) {
    super({
      skipMissingProperties: false,
      skipUndefinedProperties: false,
      skipNullProperties: false,
      whitelist: true,
      //transformerPackage: Transformer,
      exceptionFactory: (errors: ValidationError[]) =>
        ValidationPipe.getExceptionFactory(errors),
      ...(options || {}),
    });
  }
}
