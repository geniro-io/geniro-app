/**
 * The app tokens an artifact page is given, under the names the tool's own
 * description promises an agent it can use.
 *
 * RENAMED rather than passed through, and the rename is the contract: a page
 * written against `--geniro-fg` goes on working when this app's internal token
 * vocabulary changes, and an agent reading the tool description learns a short
 * list instead of the whole design system. The mapping is the one place the
 * two vocabularies meet.
 *
 * TWIN PARSER: the `show_artifact` tool description in
 * `apps/daemon/src/v1/graphs/services/mcp-server.service.ts` lists these names
 * to the model. A name added here that is not listed there is a token no agent
 * knows to reach for; one listed there and missing here renders as its
 * fallback. Both halves move together.
 *
 * TWIN PARSER: `FALLBACK` in `apps/daemon/src/v1/agents/utils/artifact-runtime.ts`
 * — the value each of these names takes before the host's theme lands, which
 * is the light theme's value of the app token mapped here.
 * `artifact-runtime.spec.ts` reads this map and `light.css` and fails when the
 * three disagree.
 *
 * It lives in its own module because there are TWO consumers and they deliver
 * the same values by different means — the frame POSTS them to a live document
 * (`artifact-frame.tsx`), and the export BAKES them into a file that will be
 * opened with no host at all (`artifact-export.ts`). A second copy of the list
 * is how a saved page would come to be themed differently from the one on
 * screen.
 */
export const THEME_TOKENS: Record<string, string> = {
  '--geniro-fg': '--foreground',
  '--geniro-muted': '--muted-foreground',
  '--geniro-bg': '--background',
  '--geniro-surface': '--card',
  '--geniro-border': '--border',
  '--geniro-primary': '--primary',
  '--geniro-primary-fg': '--primary-foreground',
  '--geniro-subtle': '--muted',
  '--geniro-font': '--font-family-sans',
  '--geniro-font-mono': '--font-family-mono',
  '--geniro-radius': '--radius',
  '--geniro-success': '--success',
  '--geniro-warning': '--warning',
  '--geniro-danger': '--destructive',
  // The Stats page's series palette, ordered and checked for colour-blind
  // separation there — a page's chart takes its series colours in this order.
  '--geniro-chart-1': '--chart-1',
  '--geniro-chart-2': '--chart-2',
  '--geniro-chart-3': '--chart-3',
  '--geniro-chart-4': '--chart-4',
  '--geniro-chart-5': '--chart-5',
};

/**
 * The resolved VALUES of the tokens above, read off the live document.
 *
 * Values rather than names, because an artifact is a separate document that has
 * never loaded this app's stylesheets — `var(--foreground)` means nothing
 * inside it. `getComputedStyle` is what turns a token into the colour the user
 * is actually looking at, including whichever theme is in force.
 */
export function themeVars(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const [outer, inner] of Object.entries(THEME_TOKENS)) {
    const value = computed.getPropertyValue(inner).trim();
    if (value.length > 0) {
      vars[outer] = value;
    }
  }
  return vars;
}
