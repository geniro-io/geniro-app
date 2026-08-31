// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel, SettingsPanelRow } from './settings-panel';
import { Switch } from './ui/switch';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SettingsPanelRow', () => {
  it('makes the label press the control it names', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        <SettingsPanel>
          <SettingsPanelRow
            label="Show system notifications"
            htmlFor="spec-notifications"
            description="Banners when an agent asks something.">
            <Switch
              id="spec-notifications"
              checked={false}
              onCheckedChange={onCheckedChange}
            />
          </SettingsPanelRow>
        </SettingsPanel>,
      );
    });

    // The whole reason the row takes `htmlFor` at all: the control moved to the
    // far side of the row, so the words are the large target and the switch is
    // the small one. A row that renders the label without the association reads
    // identically and cannot be clicked.
    act(() => {
      container
        .querySelector<HTMLLabelElement>('label')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('renders no heading for a row that is not a setting', () => {
    act(() => {
      root.render(
        <SettingsPanel>
          <SettingsPanelRow>
            <button type="button">Send a test</button>
          </SettingsPanelRow>
        </SettingsPanel>,
      );
    });

    // A panel carries rows that ACT rather than set — the notification test,
    // the update buttons. Without this arm each would need a label invented to
    // give it one, which is how a screen grows words nobody needed.
    expect(container.querySelector('label')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Send a test');
  });

  it('drops the right-hand column in the block layout', () => {
    act(() => {
      root.render(
        <SettingsPanel>
          <SettingsPanelRow layout="block" label="Theme">
            <span>swatches</span>
          </SettingsPanelRow>
        </SettingsPanel>,
      );
    });

    const row = container.querySelector<HTMLElement>(
      '[data-slot="settings-panel-row"]',
    );
    // jsdom computes no layout and resolves no container query, so the CLASS is
    // the observable — and here it is the mechanism rather than a proxy for it:
    // `inline` is the row turning into two columns at `26rem`, and `block` is
    // exactly the absence of that. A block row that kept the `flex-row` would
    // right-align a run of swatches into a cell that cannot hold them.
    expect(row?.className).not.toContain('@[26rem]:flex-row');
    expect(row?.className).toContain('flex-col');
  });
});
