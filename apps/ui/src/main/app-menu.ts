import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

import { IPC } from '../shared/contracts';

/**
 * The macOS menu bar — Electron's own default, minus the one entry that is
 * about debugging this app rather than using it.
 *
 * Without a call to `Menu.setApplicationMenu` Electron builds a default menu,
 * and its View submenu opens with Reload, Force Reload and **Toggle Developer
 * Tools**. That last one was REPORTED ("давай уберем вот эту вот кнопочку
 * дебага… в меню приложения") and it is the whole reason this file exists: a
 * menu bar is the app's most public surface, and a row that opens Chromium's
 * inspector belongs to whoever is building the app, not to whoever is using it.
 *
 * So the template restates the default rather than inventing one — four role
 * menus (`appMenu`/`fileMenu`/`editMenu`/`windowMenu`) reproduce their halves
 * byte for byte, with the platform's own labels and accelerators, and only View
 * is spelled out because only View changes. Dumped from a probe Electron before
 * writing it, so this is a copy of what shipped rather than of the docs.
 *
 * macOS only, like the app.
 */
export function applicationMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        // Beside the two Reloads because it is the same act one layer down:
        // Reload throws away what the WINDOW holds, this throws away what the
        // DAEMON holds about the CLIs — their models, the settings each model
        // offers, the MCP servers a folder loads. ASKED FOR as "на мыши нужно
        // сделать сброс кэша… как дополнительную функцию" against a menu bar
        // that had no such row.
        //
        // No accelerator: every other row here has the platform's own, and
        // inventing one for a maintenance action is how a chord comes to be
        // pressed by accident.
        {
          label: 'Clear Agent Cache',
          click: () => sendToFocusedWindow(IPC.onClearAgentCaches),
        },
        // HIDDEN, not deleted. The report is about the menu, and a hidden item
        // is not in the menu — while Electron keeps its accelerator registered
        // (`acceleratorWorksWhenHidden` defaults to true on macOS), so ⌥⌘I goes
        // on opening the inspector for anyone who knows to press it. Deleting
        // the row would leave the debug panel's own DevTools button as the only
        // way in, which is two chords deep now that the title bar's trigger is
        // gone as well.
        { role: 'toggleDevTools', visible: false },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}

/**
 * Hand one menu press to the window the user is actually looking at.
 *
 * The FOCUSED window and not every window: a menu row acts on the window whose
 * menu bar was clicked, and broadcasting would have a second window clear its
 * caches and flash a confirmation nobody asked for. Silently does nothing when
 * there is none — a menu is reachable while every window is closed, and the
 * work belongs to a renderer.
 */
function sendToFocusedWindow(channel: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel);
}

/** Replace Electron's default menu with {@link applicationMenuTemplate}. */
export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate()));
}
