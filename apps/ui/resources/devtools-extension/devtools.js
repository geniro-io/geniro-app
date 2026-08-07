/**
 * Registers the "Geniro" tab in Chrome DevTools, beside Elements and Network.
 *
 * This page exists only to make that one call — it has no UI of its own. The
 * panel's document (`panel.html`) is instantiated by DevTools the first time
 * the tab is selected, and lives for as long as the DevTools window does.
 */
chrome.devtools.panels.create(
  'Geniro',
  '',
  'panel.html',
  // No callback body: the panel drives itself. A `panel.onShown` hook here
  // would only duplicate what the panel's own load handler already does, and
  // it fires per-show rather than once.
  () => {},
);
