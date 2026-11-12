// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  browserWindowApp: vi.fn(() => () => null),
  App: function MockApp() {
    return null;
  },
  createRoot: vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() })),
}));

// The real tree pulls in the whole app; this spec is about what runs BEFORE it.
vi.mock('react-dom/client', () => ({ createRoot: mocks.createRoot }));
vi.mock('./App', () => ({ App: mocks.App }));
vi.mock('./chats/browser/browser-window-root', () => ({
  browserWindowApp: mocks.browserWindowApp,
}));
vi.mock('./components/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./styles/global.css', () => ({}));

function containsType(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => containsType(child, type));
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) {
    return false;
  }
  const element = node as { type: unknown; props: { children?: unknown } };
  return element.type === type || containsType(element.props.children, type);
}

function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: dark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  vi.resetModules();
  delete document.documentElement.dataset.theme;
  document.body.innerHTML = '<div id="root"></div>';
  mocks.createRoot.mockReset();
  mocks.createRoot.mockImplementation(() => ({
    render: vi.fn(),
    unmount: vi.fn(),
  }));
  vi.stubGlobal('geniro', undefined);
  (window as unknown as { geniro: unknown }).geniro = {
    getSettings: mocks.getSettings,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
  mocks.browserWindowApp.mockClear();
});

describe('renderer entry', () => {
  it('themes the document BEFORE mounting React, so the first paint is not the wrong palette', async () => {
    stubMatchMedia(true);
    mocks.getSettings.mockReturnValue(new Promise(() => {}));
    // Sampled INSIDE the mount, which is the only place the ordering is
    // observable: asserting after the module body has run reads the same value
    // whichever order the two statements are in.
    let atMount: string | undefined;
    mocks.createRoot.mockImplementation(() => {
      atMount = document.documentElement.dataset.theme;
      return { render: vi.fn(), unmount: vi.fn() };
    });

    await import('./main');

    expect(atMount).toBe('dark');
    expect(mocks.createRoot).toHaveBeenCalledOnce();
  });

  it('adopts the stored preference once it arrives', async () => {
    // The OS says dark; the user pinned light. Only the settings read knows.
    stubMatchMedia(true);
    mocks.getSettings.mockResolvedValue({ theme: 'light' });

    await import('./main');
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('light'),
    );
  });

  it('keeps the seeded theme when the settings read fails', async () => {
    stubMatchMedia(true);
    mocks.getSettings.mockRejectedValue(new Error('no main process'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await import('./main');
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    // A failed read must not clear the attribute — an unthemed document is a
    // worse answer than a media-query-resolved one.
    expect(document.documentElement.dataset.theme).toBe('dark');
    error.mockRestore();
  });

  it("renders only the chat's browser in a pop-out window, never the app", async () => {
    stubMatchMedia(false);
    mocks.getSettings.mockReturnValue(new Promise(() => {}));
    window.location.hash = '#browser-window?run=run-1&title=Fix+the+build';
    const render = vi.fn();
    mocks.createRoot.mockImplementation(() => ({ render, unmount: vi.fn() }));

    await import('./main');

    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    expect(mocks.browserWindowApp).toHaveBeenCalledExactlyOnceWith({
      runId: 'run-1',
      title: 'Fix the build',
    });
    expect(render).toHaveBeenCalledOnce();
    expect(containsType(render.mock.calls[0]?.[0], mocks.App)).toBe(false);
  });

  it('renders the app, not the pop-out browser, on an app route', async () => {
    stubMatchMedia(false);
    mocks.getSettings.mockReturnValue(new Promise(() => {}));
    window.location.hash = '#chats/run-1';
    let rendered: unknown;
    mocks.createRoot.mockImplementation(() => ({
      render: vi.fn((tree: unknown) => {
        rendered = tree;
      }),
      unmount: vi.fn(),
    }));

    await import('./main');

    await vi.waitFor(() => expect(rendered).toBeDefined());
    expect(mocks.browserWindowApp).not.toHaveBeenCalled();
    expect(containsType(rendered, mocks.App)).toBe(true);
  });
});
