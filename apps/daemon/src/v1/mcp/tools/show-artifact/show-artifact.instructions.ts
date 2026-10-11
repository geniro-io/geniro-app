import {
  MAX_ARTIFACT_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGES,
  megabytes,
} from '../../../agents/utils/artifact-image-policy';

/**
 * What a model reads about `show_artifact`.
 *
 * TWIN PARSER: the tokens, `g-*` classes and Tailwind colours this
 * description names are defined in `agents/utils/artifact-runtime.ts`
 * (ARTIFACT_TOKEN_NAMES, ARTIFACT_KIT_STYLE, ARTIFACT_TAILWIND_THEME)
 * and handed over by the renderer's `THEME_TOKENS`; the description
 * audit in mcp-server.service.spec.ts fails on a name nothing defines.
 */
export function showArtifactInstructions(): string {
  return (
    'Publish a PAGE you have written — one HTML document this app shows beside the ' +
    'conversation and opens full-screen, with your own layout, your own styling and working ' +
    'interaction. ' +
    'Use it when the answer is a THING TO LOOK AT rather than something to read in order: a plan laid ' +
    'out as phases with their dependencies, a mechanism drawn as a diagram, an architecture the reader ' +
    'should be able to explore, a comparison with controls to filter it, a small calculator they can ' +
    'type into. ' +
    'Do NOT use it for an answer that reads fine as prose — a paragraph, a list, a short table all ' +
    'render in this transcript already, and putting them behind a click makes them harder to read, not ' +
    'easier. ' +
    'Do NOT use it in place of the tools that already draw one shape well: several readings of one ' +
    'measure is show_chart, a few headline figures is show_metrics, options judged against criteria is ' +
    'show_comparison, pictures already on disk is show_gallery, and a plan you want APPROVED before ' +
    'you start is propose_plan — that one blocks on the user, this one does not ask them anything. ' +
    'Reach for this when what you need is a layout none of those can express. ' +
    'Write one HTML document: your own markup, inline <style> and <script>. ' +
    'PICTURES on this machine go in by their absolute path — <img src="/tmp/shots/after.png"> — and the app ' +
    'copies each one into the page when you publish it, so the picture survives a restart and a revision, ' +
    'and the HTML stays small. PREFER that to a data: URI, which sits inside the HTML and counts against its ' +
    'size limit. ' +
    'A local picture must be a png, jpeg, webp, gif or avif, judged by its contents rather than its name ' +
    `(an svg is refused), at most ${megabytes(MAX_ARTIFACT_IMAGE_BYTES)} MB each, ` +
    `${megabytes(MAX_ARTIFACT_PAGE_IMAGE_BYTES)} MB in all (a picture counts each time the page ` +
    `shows it) and ${MAX_ARTIFACT_PAGE_IMAGES} different pictures per page. A local picture must lie under /tmp, ` +
    'the system temp folder or this run’s project ' +
    'folder. A picture that breaks any of that REFUSES the whole page, with the reason, rather than showing ' +
    'a broken one. Remote pictures do not load. Close every tag, and write a > inside an attribute value as ' +
    '&gt; — a page with a tag that does not close is refused. ' +
    'LIBRARIES load from public CDNs with a plain <script src> in <head> — these exact URLs ' +
    'are pinned and allowed: ' +
    'ECharts https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js — draw every chart ' +
    "with `geniro.chart('#el', option)` (the element needs a height), which applies the app's palette " +
    'and follows theme switches; ' +
    'Chart.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js (themed ' +
    'automatically); ' +
    'Mermaid https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js — write flowcharts, ' +
    'sequence, gantt, timeline or kanban diagrams in <pre class="mermaid">, drawn and themed for you; ' +
    'Lucide icons https://cdn.jsdelivr.net/npm/lucide@1.52.0/dist/umd/lucide.min.js — ' +
    '<i data-lucide="check"></i>, drawn on load (call geniro.icons() after adding more); ' +
    'SortableJS https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.7/Sortable.min.js for drag and drop; ' +
    'Grid.js https://cdnjs.cloudflare.com/ajax/libs/gridjs/6.2.0/gridjs.umd.js for sortable, searchable ' +
    'tables (its stylesheet: https://cdnjs.cloudflare.com/ajax/libs/gridjs/6.2.0/theme/mermaid.min.css); ' +
    'highlight.js https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.2/highlight.min.js — ' +
    '<pre><code class="language-ts">, highlighted on load; ' +
    'Tailwind https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js — its ' +
    'colours bg-surface, text-fg, text-muted, border-border, bg-subtle, text-primary, text-success, ' +
    'text-danger and text-chart-1…5 are the app theme; ' +
    'Preact + htm https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.umd.js (global htmPreact: ' +
    'html, render, useState) for stateful UI without a build step. ' +
    'Other packages from cdnjs, cdn.jsdelivr.net/npm or unpkg load too, and Google Fonts stylesheets. ' +
    'Everything else is blocked without an error: the page has no network of its own, so fetch(), XHR ' +
    'and WebSockets silently fail — put the data in the page. ' +
    'Ready-made classes need no CSS of your own: g-card (+ g-card-title), g-grid of g-stat tiles ' +
    '(g-stat-label, g-stat-value, g-delta with g-delta-good / g-delta-bad), g-badge (+ -success, ' +
    '-warning, -danger, -info), g-table inside a g-table-wrap (g-num on numeric cells), g-kanban > ' +
    'g-kanban-col > g-kanban-head + g-kanban-list > g-kanban-card, g-btn (+ g-btn-secondary), g-row, ' +
    "g-muted. Your own rules always win over them — except CSS you put in Tailwind's @layer base, which " +
    "ranks below geniro's base styles (body padding, link colour); write those rules unlayered. " +
    "The page is shown on the app's own background, so " +
    'set none; take every colour from the CSS variables, never a literal, or half your readers get ' +
    'black text on black: --geniro-fg, --geniro-muted, --geniro-bg, --geniro-surface, --geniro-subtle, ' +
    '--geniro-border, --geniro-primary, --geniro-primary-fg, --geniro-success, --geniro-warning, ' +
    '--geniro-danger, --geniro-chart-1…5 (series colours, in order), --geniro-radius, --geniro-font ' +
    'and --geniro-font-mono, each with a fallback (`var(--geniro-fg, #111)`). ' +
    'DESIGN IT, do not just emit markup — this page is the whole answer. Summary first, detail after; ' +
    'one clear hierarchy, one type scale, generous space on a 4/8/12/16/24px scale, alignment you can ' +
    'see down the page, numbers in tabular figures. For a chart pick the FORM before the colour (change ' +
    'over time is a line, a ranking is a bar, a single headline is a stat tile, not a chart), one y-axis ' +
    'per chart, a legend whenever there are two or more series, tooltips on, labels that name real ' +
    'values. State is never colour alone — a badge says "failing" as well as being red. Avoid the ' +
    'generic AI look: no gradient hero, no emoji as section markers, not everything centred, not every ' +
    'block a rounded shadowed card. A margin or width does nothing on an inline element, so anything ' +
    'you space or stack is a block. ' +
    'It is shown BOTH in a narrow inline frame and full-screen, and in the light and the dark theme: no ' +
    'fixed pixel widths, let rows wrap, keep text to a readable measure, and put a wide table or ' +
    'diagram in its own scrolling box rather than letting the page scroll sideways. ' +
    'To REVISE a page you already published, call this again with the SAME artifact_id — it replaces ' +
    'the page in place as a new version rather than adding a second one, which is how a plan stays ' +
    'current while you work. A different id, or none, makes a new page. ' +
    'Call it ONCE per page, and do not also write the content out as text: the user sees the page, so ' +
    'restating it shows the same thing twice. Say what it SHOWS, and what you want them to notice. ' +
    'The result is a short receipt naming the artifact_id and version, never the document.'
  );
}
