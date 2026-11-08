import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { KnowledgeForm, type KnowledgeFormValue } from './knowledge-form';

const VALUE: KnowledgeFormValue = {
  title: 'Release checklist',
  whenToRead: 'Cutting a release or bumping a version.',
  handle: 'release-checklist',
  body: '# Before you start\n\nWork from `main` with a clean tree.',
  place: 'project:p1',
};

const PLACES = [
  { key: 'project:p1', label: 'Atlas', hint: 'atlas-app', kind: 'project' },
  { key: 'team:delivery', label: 'Delivery team', kind: 'team' },
  { key: 'global', label: 'Global', kind: 'global' },
] as const;

function Stateful(
  props: Omit<
    React.ComponentProps<typeof KnowledgeForm>,
    'value' | 'onChange'
  > & {
    initial: KnowledgeFormValue;
  },
): React.JSX.Element {
  const { initial, ...rest } = props;
  const [value, setValue] = useState(initial);
  return <KnowledgeForm {...rest} value={value} onChange={setValue} />;
}

const meta: Meta<typeof Stateful> = {
  title: 'Knowledge/KnowledgeForm',
  component: Stateful,
  args: {
    initial: VALUE,
    places: PLACES,
    isNew: false,
    busy: false,
    errors: {},
    submitLabel: 'Save',
    onCancel: () => {},
    onSubmit: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof Stateful>;

export const Edit: Story = {};

export const New: Story = {
  args: {
    isNew: true,
    submitLabel: 'Create',
    initial: { ...VALUE, title: '', whenToRead: '', handle: '', body: '' },
  },
};

export const HandleTaken: Story = {
  args: { errors: { handle: 'This handle is taken in this place.' } },
};
