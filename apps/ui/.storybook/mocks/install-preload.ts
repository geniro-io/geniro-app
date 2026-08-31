import { createPreloadStub } from '../../src/renderer/__fixtures__/preload-stub';

/**
 * Puts the stub on `window` as a side effect of being imported.
 *
 * A side-effect module rather than a decorator because a decorator runs during
 * RENDER, which is already too late: Storybook imports every story file — and
 * through them every component module — before the first decorator is called,
 * so a module reading the bridge at import time would throw first. Importing
 * this before anything else in `preview.tsx` is what closes that window.
 */
window.geniro = createPreloadStub();
