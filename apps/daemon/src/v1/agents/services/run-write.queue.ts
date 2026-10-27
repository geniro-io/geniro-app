import { Injectable } from '@nestjs/common';

import { KeyedChain } from '../utils/keyed-chain';

@Injectable()
export class RunWriteQueue extends KeyedChain {}
