import { describe, expect, it } from 'vitest';

import {
  MAX_QUESTION_ATTACHMENTS,
  questionAttachmentsOf,
  questionCardText,
} from './question-attachments';

const page = (artifactId: string, title: string, version = 1) => ({
  artifactId,
  title,
  version,
});

const gallery = (seq: number, title: string | null, images = 2) => ({
  seq,
  payload: {
    ...(title === null ? {} : { title }),
    images: Array.from({ length: images }, (_, i) => ({ path: `/tmp/${i}.png` })),
  },
});

const none = { explicit: [], text: '', pages: [], galleries: [], turn: [] };

describe('questionAttachmentsOf', () => {
  it('puts explicit pages first, in the order given', () => {
    const fields = questionAttachmentsOf({
      ...none,
      explicit: ['b-page', 'a-page'],
      pages: [page('a-page', 'Alpha sheet'), page('b-page', 'Beta sheet')],
    });
    expect(fields.attachments.map((a) => a.kind === 'artifact' && a.artifactId)).toEqual([
      'b-page',
      'a-page',
    ]);
  });

  it('attaches a page named by its exact title from an earlier turn', () => {
    const fields = questionAttachmentsOf({
      ...none,
      text: 'Which voice do you prefer on   voice samples — option sheet?',
      pages: [page('voices', 'Voice samples — option sheet', 3)],
    });
    expect(fields).toEqual({
      attachments: [
        {
          kind: 'artifact',
          artifactId: 'voices',
          title: 'Voice samples — option sheet',
          version: 3,
        },
      ],
      moreAttachments: 0,
    });
  });

  it('does not match a title shorter than six characters', () => {
    const fields = questionAttachmentsOf({
      ...none,
      text: 'Is the Plan right?',
      pages: [page('the-plan-page', 'Plan')],
    });
    expect(fields.attachments).toEqual([]);
  });

  it('matches a page id only as a whole token', () => {
    const pages = [page('report-v2', 'Quarterly numbers')];
    expect(
      questionAttachmentsOf({ ...none, text: 'see report-v2, then pick', pages })
        .attachments,
    ).toHaveLength(1);
    expect(
      questionAttachmentsOf({ ...none, text: 'see report-v23 then pick', pages })
        .attachments,
    ).toEqual([]);
  });

  it('follows with the asking turn, newest first, after named ones', () => {
    const fields = questionAttachmentsOf({
      ...none,
      text: 'About Gamma report, which one?',
      pages: [
        page('alpha', 'Alpha sheet'),
        page('beta', 'Beta sheet'),
        page('gamma', 'Gamma report'),
      ],
      galleries: [gallery(7, 'Logo drafts')],
      turn: [{ artifactId: 'alpha' }, { gallerySeq: 7 }],
    });
    expect(
      fields.attachments.map((a) =>
        a.kind === 'artifact' ? a.artifactId : `gallery:${a.seq}`,
      ),
    ).toEqual(['gamma', 'gallery:7', 'alpha']);
  });

  it('keeps one entry per page however often it is named and shown', () => {
    const fields = questionAttachmentsOf({
      ...none,
      explicit: ['alpha'],
      text: 'Alpha sheet: alpha?',
      pages: [page('alpha', 'Alpha sheet', 4)],
      turn: [{ artifactId: 'alpha' }, { artifactId: 'alpha' }],
    });
    expect(fields.attachments).toEqual([
      { kind: 'artifact', artifactId: 'alpha', title: 'Alpha sheet', version: 4 },
    ]);
  });

  it('caps at three and counts the rest', () => {
    const pages = ['one', 'two', 'three', 'four', 'five'].map((id) =>
      page(`page-${id}`, `Sheet number ${id}`),
    );
    const fields = questionAttachmentsOf({
      ...none,
      pages,
      turn: pages.map((p) => ({ artifactId: p.artifactId })),
    });
    expect(fields.attachments).toHaveLength(MAX_QUESTION_ATTACHMENTS);
    expect(fields.moreAttachments).toBe(2);
  });

  it('never attaches a page the run did not publish', () => {
    const fields = questionAttachmentsOf({
      ...none,
      explicit: ['elsewhere'],
      text: 'Pick from Other thread sheet',
      pages: [],
      turn: [{ artifactId: 'elsewhere' }],
    });
    expect(fields.attachments).toEqual([]);
  });

  it('attaches a picture set named by title with its count and payload', () => {
    const set = gallery(12, 'Logo drafts', 3);
    const fields = questionAttachmentsOf({
      ...none,
      text: 'Which of the logo drafts?',
      galleries: [set],
    });
    expect(fields.attachments).toEqual([
      {
        kind: 'gallery',
        seq: 12,
        title: 'Logo drafts',
        count: 3,
        gallery: set.payload,
      },
    ]);
  });
});

describe('questionCardText', () => {
  it('reads the title and every question, header and option word', () => {
    expect(
      questionCardText('Pick one', [
        {
          question: 'Which?',
          header: 'Voice',
          options: [{ label: 'A', description: 'warm', preview: 'p' }],
        },
        'not a question',
      ]),
    ).toBe(['Pick one', 'Which?', 'Voice', 'A', 'warm', 'p'].join('\n'));
  });
});
