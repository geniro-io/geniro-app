import { Injectable } from '@nestjs/common';
import { BaseLogger, DefaultLogger } from '@packages/common';

import { RequestContextService } from './request-context.service';

@Injectable()
export class RequestContextLogger extends BaseLogger {
  constructor(
    private readonly logger: DefaultLogger,
    private readonly requestContextService: RequestContextService,
  ) {
    super(logger.params);
  }

  public getCustomPayload() {
    const requestData = this.requestContextService.getRequestData();

    return {
      ...requestData,
      ...this.logger.getCustomPayload(),
    };
  }
}
