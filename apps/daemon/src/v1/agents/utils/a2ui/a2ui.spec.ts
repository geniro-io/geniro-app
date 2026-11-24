import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_UI_COMPONENTS } from '../../chat.types';
import {
  applyA2uiMessages,
  pointerCovers,
  pointerGet,
  pointerSet,
} from './a2ui-apply';
import {
  type A2uiMessage,
  backtracksBadly,
  readA2uiMessages,
} from './a2ui-validate';

const EXAMPLES = JSON.parse(
  readFileSync(
    join(__dirname, '__tests__', 'basic-catalog-examples.v1.json'),
    'utf8',
  ),
) as { file: string; messages: unknown[] }[];

function create(
  components: unknown[],
  dataModel?: Record<string, unknown>,
): unknown[] {
  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 's1',
        components,
        ...(dataModel === undefined ? {} : { dataModel }),
      },
    },
  ];
}

const TEXT_ROOT = { id: 'root', component: 'Text', text: 'Hello' };

function errorOf(messages: unknown): string {
  const reading = readA2uiMessages(messages);
  if (reading.ok) {
    try {
      applyA2uiMessages(null, false, reading.messages);
    } catch (err) {
      return `${(err as { pointer: string }).pointer}: ${(err as Error).message}`;
    }
    return 'valid';
  }
  return reading.error;
}

function applied(messages: unknown): ReturnType<typeof applyA2uiMessages> {
  const reading = readA2uiMessages(messages);
  if (!reading.ok) {
    throw new Error(reading.error);
  }
  return applyA2uiMessages(null, false, reading.messages);
}

const MEDIA = new Set(['Image', 'Video', 'AudioPlayer']);

function bindsMediaUrl(messages: unknown[]): boolean {
  return messages.some((message) =>
    Object.values(message as Record<string, unknown>).some(
      (body) =>
        typeof body === 'object' &&
        body !== null &&
        Array.isArray((body as { components?: unknown }).components) &&
        (body as { components: Record<string, unknown>[] }).components.some(
          (component) =>
            MEDIA.has(String(component.component)) &&
            (typeof component.url === 'object' ||
              typeof component.posterUrl === 'object'),
        ),
    ),
  );
}

describe('readA2uiMessages', () => {
  it.each(
    EXAMPLES.filter((example) => !bindsMediaUrl(example.messages)).map(
      (example) => [example.file, example.messages],
    ),
  )('accepts the official basic catalog example %s', (_file, messages) => {
    expect(errorOf(messages)).toBe('valid');
  });

  it.each(
    EXAMPLES.filter((example) => bindsMediaUrl(example.messages)).map(
      (example) => [example.file, example.messages],
    ),
  )(
    'refuses the official example %s only for its bound media url',
    (_file, messages) => {
      expect(errorOf(messages)).toMatch(
        /\/url: a media url must be a literal string, never bound to the data model$/,
      );
    },
  );

  it('names an unknown component with its pointer', () => {
    expect(errorOf(create([{ id: 'root', component: 'Carousel' }]))).toBe(
      '/messages/0/createSurface/components/0/component: "Carousel" is not a basic catalog component (Text, Image, Icon, Video, AudioPlayer, Row, Column, List, Card, Tabs, Modal, Divider, Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput)',
    );
  });

  it('names a value outside an enum with its pointer and the allowed values', () => {
    expect(
      errorOf(
        create([
          {
            id: 'root',
            component: 'ChoicePicker',
            options: [],
            value: [],
            displayStyle: 'pills',
          },
        ]),
      ),
    ).toBe(
      '/messages/0/createSurface/components/0/displayStyle: "pills" is not one of checkbox, chips',
    );
  });

  it('names a property the component does not take', () => {
    expect(errorOf(create([{ ...TEXT_ROOT, colour: 'red' }]))).toBe(
      '/messages/0/createSurface/components/0/colour: is not a property this component takes',
    );
  });

  it('names a missing required property', () => {
    expect(errorOf(create([{ id: 'root', component: 'Text' }]))).toBe(
      '/messages/0/createSurface/components/0: "text" is required',
    );
  });

  it('refuses a function outside the basic catalog', () => {
    expect(
      errorOf(
        create([
          {
            id: 'root',
            component: 'Text',
            text: { '@call': 'shout', args: {} },
          },
        ]),
      ),
    ).toMatch(
      /^\/messages\/0\/createSurface\/components\/0\/text\/@call: "shout" is not a basic catalog function/,
    );
  });

  it('refuses a media url bound to the data model', () => {
    expect(
      errorOf(
        create([
          { id: 'root', component: 'Image', url: { '@path': '/picture' } },
        ]),
      ),
    ).toBe(
      '/messages/0/createSurface/components/0/url: a media url must be a literal string, never bound to the data model',
    );
  });

  it('refuses a regex pattern past its cap', () => {
    expect(
      errorOf(
        create([
          {
            id: 'root',
            component: 'TextField',
            label: 'Code',
            value: { '@path': '/code' },
            '@checks': [
              {
                condition: {
                  '@call': 'regex',
                  args: { value: 'x', pattern: 'a'.repeat(513) },
                },
              },
            ],
          },
        ]),
      ),
    ).toBe(
      '/messages/0/createSurface/components/0/@checks/0/condition/args/pattern: a pattern may be at most 512 characters',
    );
  });

  it('refuses a button that calls a function other than openUrl', () => {
    expect(
      errorOf(
        create([
          {
            id: 'root',
            component: 'Button',
            child: 'label',
            action: {
              functionCall: { '@call': 'required', args: { value: 'x' } },
            },
          },
          { id: 'label', component: 'Text', text: 'Go' },
        ]),
      ),
    ).toBe(
      '/messages/0/createSurface/components/0/action/functionCall: a button calls a function only to open a link (openUrl); use an event to reach the agent',
    );
  });

  it('refuses two surfaces in one call', () => {
    expect(
      errorOf([
        ...create([TEXT_ROOT]),
        { version: '1.0', deleteSurface: { surfaceId: 'other' } },
      ]),
    ).toBe(
      '/messages/1/deleteSurface/surfaceId: one call draws one surface; this names "other" after "s1"',
    );
  });

  it('refuses the v0.8 message names', () => {
    expect(
      errorOf([{ version: '1.0', surfaceUpdate: { surfaceId: 's1' } }]),
    ).toBe(
      '/messages/0: must hold exactly one of createSurface, updateComponents, updateDataModel, deleteSurface',
    );
  });
});

describe('applyA2uiMessages', () => {
  it('refuses a child id no component has', () => {
    expect(
      errorOf(
        create([
          { id: 'root', component: 'Column', children: ['a', 'missing'] },
          { ...TEXT_ROOT, id: 'a' },
        ]),
      ),
    ).toBe(
      '/messages/0/createSurface/components/0/children/1: names "missing", which no component has as its id',
    );
  });

  it('refuses a cycle', () => {
    expect(
      errorOf(
        create([
          { id: 'root', component: 'Card', child: 'inner' },
          { id: 'inner', component: 'Card', child: 'root' },
        ]),
      ),
    ).toBe(
      '/messages/0/createSurface/components/1/child: "root" contains "inner" already, so this makes a cycle',
    );
  });

  it('refuses a surface with no root', () => {
    expect(errorOf(create([{ id: 'top', component: 'Text', text: 'x' }]))).toBe(
      '/messages: no component has the id "root", where the surface starts',
    );
  });

  it('refuses a surface over the component cap', () => {
    const texts = Array.from({ length: MAX_UI_COMPONENTS }, (_, index) => ({
      id: `t${index}`,
      component: 'Text',
      text: 'x',
    }));
    expect(
      errorOf(
        create([
          {
            id: 'root',
            component: 'Column',
            children: texts.map((text) => text.id),
          },
          ...texts,
        ]),
      ),
    ).toBe(
      `/messages: a surface holds at most ${MAX_UI_COMPONENTS} components (this one would hold ${MAX_UI_COMPONENTS + 1})`,
    );
  });

  it('replaces a component by id and adds new ones on update', () => {
    const first = applied(create([TEXT_ROOT]));
    const reading = readA2uiMessages([
      {
        version: '1.0',
        updateComponents: {
          surfaceId: 's1',
          components: [
            { id: 'root', component: 'Column', children: ['greeting'] },
            { id: 'greeting', component: 'Text', text: 'Hi' },
          ],
        },
      },
    ]);
    if (!reading.ok) {
      throw new Error(reading.error);
    }
    const next = applyA2uiMessages(first.snapshot, false, reading.messages);

    expect(next.created).toBe(false);
    expect(
      next.snapshot.components.map((component) => [
        component.id,
        component.component,
      ]),
    ).toEqual([
      ['root', 'Column'],
      ['greeting', 'Text'],
    ]);
  });

  it('sets and deletes data-model values and reports the pointers it wrote', () => {
    const first = applied(
      create([TEXT_ROOT], { form: { name: 'Ann', age: 3 } }),
    );
    const messages: A2uiMessage[] = [
      {
        kind: 'updateDataModel',
        surfaceId: 's1',
        path: '/form/name',
        value: 'Bob',
      },
      {
        kind: 'updateDataModel',
        surfaceId: 's1',
        path: '/form/age',
        value: null,
      },
    ];
    const next = applyA2uiMessages(first.snapshot, false, messages);

    expect(next.snapshot.dataModel).toEqual({ form: { name: 'Bob' } });
    expect(next.writes).toEqual(['/form/name', '/form/age']);
  });

  it('refuses a second createSurface for a surface that exists', () => {
    const first = applied(create([TEXT_ROOT]));
    const reading = readA2uiMessages(create([TEXT_ROOT]));
    if (!reading.ok) {
      throw new Error(reading.error);
    }
    expect(() =>
      applyA2uiMessages(first.snapshot, false, reading.messages),
    ).toThrow(
      'surface "s1" already exists; change it with updateComponents or updateDataModel',
    );
  });

  it('marks the surface removed on deleteSurface and refuses anything after it', () => {
    const first = applied(create([TEXT_ROOT]));
    const removed = applyA2uiMessages(first.snapshot, false, [
      { kind: 'deleteSurface', surfaceId: 's1' },
    ]);

    expect(removed.removed).toBe(true);
    expect(() =>
      applyA2uiMessages(first.snapshot, false, [
        { kind: 'deleteSurface', surfaceId: 's1' },
        { kind: 'updateDataModel', surfaceId: 's1', path: '/a', value: 1 },
      ]),
    ).toThrow('comes after deleteSurface removed this surface');
  });
});

describe('backtracksBadly', () => {
  it.each(['(a+)+$', '(a|aa)*', '((ab)*)+', '(x{2,})+'])(
    'refuses %s',
    (pattern) => {
      expect(backtracksBadly(pattern)).toBe(true);
    },
  );

  it.each([
    '^[a-z]+$',
    '^(\\d{3})-\\d{4}$',
    '(com|org)',
    '[(]+',
    '^\\(a+\\)+$',
  ])('accepts %s', (pattern) => {
    expect(backtracksBadly(pattern)).toBe(false);
  });
});

describe('json pointers', () => {
  it('reads and writes escaped segments without touching the input', () => {
    const root = { 'a/b': { 'c~d': 1 } };
    const next = pointerSet(root, '/a~1b/c~0d', 2);

    expect(pointerGet(next, '/a~1b/c~0d')).toBe(2);
    expect(root).toEqual({ 'a/b': { 'c~d': 1 } });
  });

  it('treats a parent pointer as covering its children only', () => {
    expect(pointerCovers('/form', '/form/name')).toBe(true);
    expect(pointerCovers('/form/name', '/form')).toBe(false);
    expect(pointerCovers('/formal', '/form/name')).toBe(false);
  });
});
