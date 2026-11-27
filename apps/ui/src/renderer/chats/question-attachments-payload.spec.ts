import { describe, expect, it } from 'vitest';

import {
  questionAttachmentSetOf,
  readQuestionAttachmentSet,
} from './question-attachments-payload';

const IMAGE = { path: 'a.png', caption: null, description: null, source: null };

describe('readQuestionAttachmentSet', () => {
  it('reads nothing from a record written before attachments existed', () => {
    expect(readQuestionAttachmentSet({ questions: [] })).toBeNull();
    expect(questionAttachmentSetOf(null)).toBeNull();
  });

  it('reads an empty list as a question that attached nothing', () => {
    expect(readQuestionAttachmentSet({ attachments: [] })).toEqual({
      attachments: [],
      moreAttachments: 0,
    });
  });

  it('keeps the well-formed entries and drops each malformed one alone', () => {
    const set = readQuestionAttachmentSet({
      attachments: [
        { kind: 'artifact', artifactId: '', title: 'No id', version: 1 },
        { kind: 'artifact', artifactId: 'plan', title: 'Plan', version: 2 },
        { kind: 'artifact', artifactId: 'x', title: 'Old', version: 0 },
        { kind: 'unknown' },
        { kind: 'gallery', seq: 4, gallery: { images: [] } },
        {
          kind: 'gallery',
          seq: 5,
          gallery: { title: 'Trip', images: [IMAGE] },
        },
      ],
      moreAttachments: 2,
    });

    expect(set).toEqual({
      attachments: [
        { kind: 'artifact', artifactId: 'plan', title: 'Plan', version: 2 },
        {
          kind: 'gallery',
          seq: 5,
          gallery: { title: 'Trip', images: [IMAGE] },
        },
      ],
      moreAttachments: 2,
    });
  });

  it('reads a missing or malformed more-count as none', () => {
    expect(
      readQuestionAttachmentSet({ attachments: [] })?.moreAttachments,
    ).toBe(0);
    expect(
      readQuestionAttachmentSet({ attachments: [], moreAttachments: -1 })
        ?.moreAttachments,
    ).toBe(0);
  });
});
