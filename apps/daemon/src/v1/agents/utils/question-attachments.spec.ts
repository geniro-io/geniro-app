import { describe, expect, it } from 'vitest';

import {
  MAX_QUESTION_ATTACHMENTS,
  questionAttachmentsOf,
} from './question-attachments';

const page = (artifactId: string, title: string, version = 1) => ({
  artifactId,
  title,
  version,
});

describe('questionAttachmentsOf', () => {
  it('attaches nothing when the agent passed no page, whatever the run published', () => {
    expect(
      questionAttachmentsOf(
        [],
        [page('plan', 'Launch plan'), page('chart', 'Quarterly chart')],
      ),
    ).toEqual({ attachments: [] });
  });

  it('attaches exactly the pages passed, in the order given', () => {
    const fields = questionAttachmentsOf(
      ['b-page', 'a-page'],
      [
        page('a-page', 'Alpha sheet'),
        page('b-page', 'Beta sheet'),
        page('c-page', 'Gamma sheet'),
      ],
    );
    expect(fields).toEqual({
      attachments: [
        {
          kind: 'artifact',
          artifactId: 'b-page',
          title: 'Beta sheet',
          version: 1,
        },
        {
          kind: 'artifact',
          artifactId: 'a-page',
          title: 'Alpha sheet',
          version: 1,
        },
      ],
    });
  });

  it('attaches a page passed twice once, at its newest version', () => {
    expect(
      questionAttachmentsOf(['plan', 'plan'], [page('plan', 'Launch plan', 3)])
        .attachments,
    ).toEqual([
      {
        kind: 'artifact',
        artifactId: 'plan',
        title: 'Launch plan',
        version: 3,
      },
    ]);
  });

  it('never attaches a page the run did not publish', () => {
    expect(
      questionAttachmentsOf(
        ['elsewhere', 'plan'],
        [page('plan', 'Launch plan')],
      ).attachments,
    ).toEqual([
      {
        kind: 'artifact',
        artifactId: 'plan',
        title: 'Launch plan',
        version: 1,
      },
    ]);
  });

  it('caps the pages at three', () => {
    const pages = ['one', 'two', 'three', 'four'].map((id) =>
      page(`page-${id}`, `Sheet ${id}`),
    );
    const fields = questionAttachmentsOf(
      pages.map((p) => p.artifactId),
      pages,
    );
    expect(fields.attachments).toHaveLength(MAX_QUESTION_ATTACHMENTS);
  });
});
