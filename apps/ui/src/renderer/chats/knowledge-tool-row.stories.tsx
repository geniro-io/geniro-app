import type { Meta, StoryObj } from '@storybook/react-vite';

import { KnowledgeOpenContext, KnowledgeToolRow } from './knowledge-tool-row';

const COMMIT_FORMAT = {
  handle: 'commit-format',
  title: 'Commit format',
  whenToRead: 'Writing a commit.',
  level: 'global',
  reviewed: true,
} as const;

const RELEASE_CHECKLIST = {
  handle: 'release-checklist',
  title: 'Release checklist',
  whenToRead: 'Cutting a release.',
  level: 'project',
  reviewed: false,
} as const;

const meta = {
  title: 'Chats/KnowledgeToolRow',
  component: KnowledgeToolRow,
  args: { status: 'done' },
  decorators: [
    (story) => (
      <KnowledgeOpenContext.Provider value={() => {}}>
        <div className="w-[560px] bg-background p-4">{story()}</div>
      </KnowledgeOpenContext.Provider>
    ),
  ],
} satisfies Meta<typeof KnowledgeToolRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Searched: Story = {
  args: {
    entry: {
      tool: 'knowledge_search',
      query: 'release',
      count: 2,
      documents: [COMMIT_FORMAT, RELEASE_CHECKLIST],
      failure: null,
    },
  },
};

export const Searching: Story = {
  args: {
    status: 'running',
    entry: {
      tool: 'knowledge_search',
      query: 'release',
      count: null,
      documents: [],
      failure: null,
    },
  },
};

export const SearchRefused: Story = {
  args: {
    status: 'error',
    entry: {
      tool: 'knowledge_search',
      query: 'release',
      count: null,
      documents: [],
      failure: 'the user has turned knowledge off; work without it.',
    },
  },
};

export const Read: Story = {
  args: {
    entry: {
      tool: 'knowledge_read',
      handle: 'release-checklist',
      rev: 7,
      documents: [RELEASE_CHECKLIST],
      changed: false,
      failure: null,
    },
  },
};

export const ReadChanged: Story = {
  args: {
    entry: {
      tool: 'knowledge_read',
      handle: 'release-checklist',
      rev: null,
      documents: [],
      changed: true,
      failure: null,
    },
  },
};

export const ReadNotFound: Story = {
  args: {
    status: 'error',
    entry: {
      tool: 'knowledge_read',
      handle: 'ghost',
      rev: null,
      documents: [],
      changed: false,
      failure:
        'this run sees no knowledge document `ghost`. Did you mean `ghost-2`?',
    },
  },
};

export const Saved: Story = {
  args: {
    entry: {
      tool: 'knowledge_save',
      handle: 'commit-format',
      title: 'Commit format',
      whenToRead: 'Writing a commit.',
      outcome: 'saved',
      created: false,
      note: null,
      documents: [
        {
          handle: 'commit-format',
          title: 'Commit format',
          whenToRead: 'Writing a commit.',
          level: null,
          reviewed: null,
        },
      ],
    },
  },
};

export const ProposedNewDocument: Story = {
  args: {
    entry: {
      tool: 'knowledge_save',
      handle: 'release-notes',
      title: 'Release notes',
      whenToRead: 'Tagging a release.',
      outcome: 'proposed',
      created: true,
      note: null,
      documents: [
        {
          handle: 'release-notes',
          title: 'Release notes',
          whenToRead: 'Tagging a release.',
          level: null,
          reviewed: null,
        },
      ],
    },
  },
};

export const ProposedChange: Story = {
  args: {
    entry: {
      tool: 'knowledge_save',
      handle: 'commit-format',
      title: null,
      whenToRead: null,
      outcome: 'proposed',
      created: false,
      note: null,
      documents: [
        {
          handle: 'commit-format',
          title: null,
          whenToRead: null,
          level: null,
          reviewed: null,
        },
      ],
    },
  },
};

export const SaveChangedSinceRead: Story = {
  args: {
    entry: {
      tool: 'knowledge_save',
      handle: null,
      title: null,
      whenToRead: null,
      outcome: 'stale',
      created: false,
      note: null,
      documents: [],
    },
  },
};

export const SaveRefused: Story = {
  args: {
    status: 'error',
    entry: {
      tool: 'knowledge_save',
      handle: null,
      title: 'Deploy key',
      whenToRead: 'Deploying.',
      outcome: 'refused',
      created: false,
      note: 'agents may only read knowledge here.',
      documents: [],
    },
  },
};

export const WithoutAKnowledgePage: Story = {
  args: {
    entry: {
      tool: 'knowledge_read',
      handle: 'release-checklist',
      rev: 7,
      documents: [RELEASE_CHECKLIST],
      changed: false,
      failure: null,
    },
  },
  decorators: [
    (story) => (
      <KnowledgeOpenContext.Provider value={null}>
        {story()}
      </KnowledgeOpenContext.Provider>
    ),
  ],
};
