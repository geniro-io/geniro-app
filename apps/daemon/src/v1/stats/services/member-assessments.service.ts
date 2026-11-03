import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import { MemberAssessmentDao } from '../dao/member-assessment.dao';
import type {
  CardAssessmentVerdictsWire,
  MemberAssessmentUserVerdict,
} from '../stats.types';

/**
 * The user's own verdicts on an analysis's marks of a team's members — kept
 * on the assessment ledger, where the team's statistics and the next analysis
 * read them beside the marks.
 */
@Injectable()
export class MemberAssessmentsService {
  constructor(
    private readonly em: EntityManager,
    private readonly assessments: MemberAssessmentDao,
  ) {}

  async setVerdict(request: {
    chatRunId: string;
    cardSeq: number;
    memberId: string;
    verdict: MemberAssessmentUserVerdict | null;
    note?: string | null;
  }): Promise<CardAssessmentVerdictsWire> {
    const em = this.em.fork();
    const note = request.note?.trim() || null;
    const saved = await this.assessments.setUserVerdict(
      request,
      request.verdict === null ? null : { verdict: request.verdict, note },
      new Date(),
      em,
    );
    if (!saved) {
      throw new NotFoundException(
        'ASSESSMENT_NOT_FOUND',
        `no assessment of ${request.memberId} on card ${request.cardSeq} of ${request.chatRunId}`,
      );
    }
    return this.verdictsOfCard(request.chatRunId, request.cardSeq, em);
  }

  async verdictsOfCard(
    chatRunId: string,
    cardSeq: number,
    em: EntityManager = this.em.fork(),
  ): Promise<CardAssessmentVerdictsWire> {
    const rows = await this.assessments.verdictsOfCard(chatRunId, cardSeq, em);
    return {
      verdicts: rows.map((row) => ({
        memberId: row.memberId,
        userVerdict:
          row.userVerdict === null
            ? null
            : {
                verdict: row.userVerdict.verdict,
                note: row.userVerdict.note,
                at: row.userVerdict.at.toISOString(),
              },
      })),
    };
  }
}
