// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './approval-card';
import {
  BrowserHostCard,
  type BrowserHostRequest,
  readBrowserHostRequest,
} from './browser-host-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST: BrowserHostRequest = {
  host: 'staging.acme.dev',
  url: 'https://staging.acme.dev/login',
  memberName: 'QA',
};

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

const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );

function press(label: string): void {
  act(() => button(label)!.click());
}

describe('the new-host card', () => {
  it('names the agent and the host, with the whole address beneath', () => {
    act(() =>
      root.render(
        <BrowserHostCard
          request={REQUEST}
          verdict={null}
          onRespond={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain(
      'QA wants to open staging.acme.dev in the browser',
    );
    expect(container.textContent).toContain('https://staging.acme.dev/login');
  });

  it('sends Approve and Deny as a plain verdict', () => {
    const onRespond = vi.fn();
    act(() =>
      root.render(
        <BrowserHostCard
          request={REQUEST}
          verdict={null}
          onRespond={onRespond}
        />,
      ),
    );
    press('Approve');
    expect(onRespond).toHaveBeenCalledWith(true);
  });

  it('sends Deny as a refusal', () => {
    const onRespond = vi.fn();
    act(() =>
      root.render(
        <BrowserHostCard
          request={REQUEST}
          verdict={null}
          onRespond={onRespond}
        />,
      ),
    );
    press('Deny');
    expect(onRespond).toHaveBeenCalledWith(false);
  });

  it('sends Allow for this session as optionId session', () => {
    const onRespond = vi.fn();
    act(() =>
      root.render(
        <BrowserHostCard
          request={REQUEST}
          verdict={null}
          onRespond={onRespond}
        />,
      ),
    );
    press('Allow for this session');
    expect(onRespond).toHaveBeenCalledWith(
      true,
      undefined,
      undefined,
      'session',
    );
  });

  it('shows the outcome once a verdict row arrived, with no buttons', () => {
    act(() =>
      root.render(
        <BrowserHostCard
          request={REQUEST}
          verdict
          verdictOption="Allow for this session"
          onRespond={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain('✓ approved');
    expect(container.textContent).toContain('Allow for this session');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('holds both approving buttons behind a hazard acknowledgement', () => {
    act(() =>
      root.render(
        <BrowserHostCard
          request={{ ...REQUEST, url: 'https://staging.acme.dev/‮login' }}
          verdict={null}
          onRespond={vi.fn()}
        />,
      ),
    );
    expect(button('Approve')!.disabled).toBe(true);
    expect(button('Allow for this session')!.disabled).toBe(true);
    expect(button('Deny')!.disabled).toBe(false);
  });
});

describe('an approval row for browser_host', () => {
  function draw(input: unknown, onRespond = vi.fn()): void {
    act(() =>
      root.render(
        <ApprovalCard
          toolName="browser_host"
          input={input}
          verdict={null}
          onRespond={onRespond}
        />,
      ),
    );
  }

  it('is drawn as the new-host card', () => {
    draw({ ...REQUEST });
    expect(container.querySelector('[data-slot="browser-host-card"]')).not.toBe(
      null,
    );
    expect(button('Allow for this session')).toBeDefined();
  });

  it('falls back to the permission body for an unreadable input', () => {
    draw({ host: 'staging.acme.dev' });
    expect(container.querySelector('[data-slot="browser-host-card"]')).toBe(
      null,
    );
    expect(container.textContent).toContain('Agent asks to run a tool');
    expect(button('Approve')).toBeDefined();
    expect(button('Deny')).toBeDefined();
  });
});

describe('readBrowserHostRequest', () => {
  it('wants a host, an address and an agent', () => {
    expect(readBrowserHostRequest(REQUEST)).toEqual(REQUEST);
    expect(readBrowserHostRequest({ ...REQUEST, memberName: ' ' })).toBeNull();
    expect(readBrowserHostRequest(null)).toBeNull();
    expect(readBrowserHostRequest('staging.acme.dev')).toBeNull();
  });
});
