import { useCallback, useEffect, useState } from 'react';

/**
 * Whether the nav rail is collapsed, remembered across launches.
 *
 * Lifted out of `nav-rail.tsx` when the toggle moved into the title bar: the
 * button and the rail it resizes are now in two different components, so the
 * state cannot live inside either. Two `useState`s reading the same setting
 * would be two answers to one question, and the first press would make them
 * disagree.
 */
export interface SidebarCollapsed {
  collapsed: boolean;
  /**
   * Whether the stored choice has been applied yet.
   *
   * Until it has, the rail's width is NOT animated: the settings read resolves
   * a frame or two after mount, and an animated correction would show every
   * launch sliding the rail shut — which looks like the app forgetting and then
   * remembering, rather than opening the way it was left.
   */
  hydrated: boolean;
  toggle: () => void;
}

export function useSidebarCollapsed(): SidebarCollapsed {
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.geniro
      .getSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setCollapsed(settings.sidebarCollapsed);
        setHydrated(true);
      })
      // Swallowed to the DEFAULT, not to a broken rail: an unreadable settings
      // file must cost the remembered width and nothing else.
      .catch(() => {
        if (!cancelled) {
          setHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((): void => {
    setCollapsed((prev) => {
      const next = !prev;
      // Fire-and-forget: the rail has already moved, and a settings write that
      // fails must not undo the gesture the user just made.
      void window.geniro.updateSettings({ sidebarCollapsed: next });
      return next;
    });
  }, []);

  return { collapsed, hydrated, toggle };
}
