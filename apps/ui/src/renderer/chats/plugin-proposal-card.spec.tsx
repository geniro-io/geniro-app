// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SAVE_PLUGIN } from './geniro-tool';
import {
  type PluginCard,
  pluginCardOf,
  PluginProposalCard,
} from './plugin-proposal-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = [
  { id: 'root', component: 'Column', children: ['title'] },
  { id: 'title', component: 'Text', text: { '@path': '/data/title' } },
];

const SAVE_INPUT = {
  summary: 'Weather for the open folder',
  slug: 'weather',
  name: 'Weather',
  command: 'node weather.js',
  folders: [],
  refreshMinutes: 5,
  timeoutSeconds: 30,
  buttons: [
    { id: 'refresh', command: 'node weather.js --now', confirm: false },
    { id: 'publish', command: 'node publish.js', confirm: true },
  ],
  view: VIEW,
  sample: { title: 'Rain at noon' },
  new_string: 'name: Weather\n',
};

const CARD: PluginCard = {
  summary: 'Weather for the open folder',
  slug: 'weather',
  name: 'Weather',
  command: 'node weather.js',
  folders: [],
  refreshMinutes: 5,
  timeoutSeconds: 30,
  buttons: [
    { id: 'refresh', command: 'node weather.js --now', confirm: false },
    { id: 'publish', command: 'node publish.js', confirm: true },
  ],
  view: VIEW,
  sample: { title: 'Rain at noon' },
  oldText: null,
  newText: 'name: Weather\n',
};

describe('pluginCardOf', () => {
  it('reads a save_plugin input into the card', () => {
    expect(pluginCardOf(SAVE_PLUGIN, SAVE_INPUT)).toEqual(CARD);
  });

  it('reads an update with the text it replaces', () => {
    expect(
      pluginCardOf(SAVE_PLUGIN, {
        ...SAVE_INPUT,
        old_string: 'name: Old\n',
      }),
    ).toEqual({ ...CARD, oldText: 'name: Old\n' });
  });

  it('refuses another tool', () => {
    expect(pluginCardOf('Write', SAVE_INPUT)).toBeNull();
  });

  it('refuses an input that does not read', () => {
    expect(pluginCardOf(SAVE_PLUGIN, null)).toBeNull();
    expect(
      pluginCardOf(SAVE_PLUGIN, { ...SAVE_INPUT, folders: 'every' }),
    ).toBeNull();
    expect(
      pluginCardOf(SAVE_PLUGIN, { ...SAVE_INPUT, refreshMinutes: '5' }),
    ).toBeNull();
    expect(
      pluginCardOf(SAVE_PLUGIN, { ...SAVE_INPUT, new_string: 42 }),
    ).toBeNull();
  });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface RenderProps {
  verdict?: boolean | null;
  answer?: string | null;
  outcome?: unknown;
  onRespond?: (allow: boolean) => void;
}

function renderCard(card: PluginCard, props: RenderProps = {}): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <PluginProposalCard
        card={card}
        verdict={props.verdict ?? null}
        answer={props.answer ?? null}
        outcome={props.outcome ?? null}
        expired={false}
        onRespond={props.onRespond ?? vi.fn()}
      />,
    );
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

function buttonNamed(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
  if (found === undefined) {
    throw new Error(`no "${text}" button`);
  }
  return found;
}

function itemWith(el: HTMLElement, text: string): HTMLLIElement {
  const found = [...el.querySelectorAll<HTMLLIElement>('li')].find((item) =>
    item.textContent.includes(text),
  );
  if (found === undefined) {
    throw new Error(`no list item with "${text}"`);
  }
  return found;
}

describe('PluginProposalCard', () => {
  it('shows what it runs, where it shows and how often it refreshes', () => {
    const el = renderCard(CARD);

    expect(el.textContent).toContain('node weather.js');
    expect(el.textContent).toContain('every chat');
    expect(el.textContent).toContain('stopped after 30 s');
    expect(el.textContent).toContain('on open, every 5 min while visible, ↻');
  });

  it('asks to save the plugin by name, with the agent summary under it', () => {
    const el = renderCard(CARD);

    expect(el.textContent).toContain(`Save plugin “${CARD.name}”?`);
    expect(el.textContent).toContain('Weather for the open folder');
  });

  it('lists the folders the plugin shows in, shortened, in place of every chat', () => {
    const el = renderCard({
      ...CARD,
      folders: ['/Users/me/Projects/shop/apps/web'],
    });

    const item = itemWith(el, 'chats under');
    expect(item.textContent).toBe('chats under …/shop/apps/web');
    expect(item.title).toBe('/Users/me/Projects/shop/apps/web');
    expect(el.textContent).not.toContain('every chat');
  });

  it('marks each button as asking first or running at once', () => {
    const el = renderCard(CARD);

    expect(itemWith(el, 'refresh').textContent).toContain('runs at once');
    expect(itemWith(el, 'publish').textContent).toContain('asks first');
  });

  it('draws the preview from the agent sample through the view', () => {
    const el = renderCard(CARD);

    expect(
      el.querySelector('[data-slot="plugin-preview"]')?.textContent,
    ).toContain('Rain at noon');
  });

  it('draws the change only for an update', () => {
    expect(renderCard(CARD).textContent).not.toContain('What changes');

    const el = renderCard({ ...CARD, oldText: 'name: Old\n' });

    expect(el.textContent).toContain('What changes');
    expect(el.textContent).toContain('name: Old');
  });

  it('Approve answers true once', () => {
    const onRespond = vi.fn<(allow: boolean) => void>();
    const el = renderCard(CARD, { onRespond });

    click(buttonNamed(el, 'Approve'));

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith(true);
  });

  it('shows the verdict "Not saved" with the answer when the save did not land', () => {
    const el = renderCard(CARD, {
      verdict: true,
      outcome: 'not-saved',
      answer: 'the folder is gone',
    });

    expect(el.textContent).toContain('✗ Not saved — the folder is gone');
  });

  it('shows "Saved" once a save lands', () => {
    const el = renderCard(CARD, { verdict: true, outcome: 'saved' });

    expect(el.textContent).toContain('✓ Saved');
  });
});
