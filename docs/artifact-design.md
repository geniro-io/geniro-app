# Artifact design: research and implementation

Geniro can reuse the public Anthropic skills. The strongest immediate change is
to teach every artifact author how to make and critique design decisions, then
use the existing renderer for the result. A component library alone cannot pick
a good composition or notice that labels collide.

## What we found

Reviewed on 2026-10-10. These are public skills, not a verified copy of Claude's
private product prompt. The findings do not establish why Claude performs better
on a particular task or guarantee equivalent model output.

| Resource                                                                                                                                                                                                                                                                                       | What it contributes                                                                                  | Fit for Geniro                                                                                                                                               | Reuse                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [Anthropic frontend-design](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design)                                                                                                                                                         | Subject-specific visual direction, a compact design system, deliberate composition and self-critique | Best foundation for artifact authoring. Adapt the process, retain the user's brief and Geniro's theme/runtime constraints                                    | The skill's own LICENSE.txt is Apache-2.0                                                     |
| [Anthropic web-artifacts-builder](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/web-artifacts-builder)                                                                                                                                             | React + TypeScript + Tailwind + shadcn/ui scaffolding and bundling into a single HTML file           | Useful for complex stateful artifacts. Its final bundled document fits Geniro; its Claude-specific publishing step must use show_artifact instead            | The skill's own LICENSE.txt is Apache-2.0                                                     |
| [Vercel web-design-guidelines](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines) and [interface rules](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md) | A practical UI review checklist: semantics, focus, form feedback, typography and responsive layout   | Complements visual direction with usability checks. The skill normally fetches fresh rules; Geniro's essential guidance should work without that download    | Review skill/source licenses separately before copying. The interface-rules repository is MIT |
| [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/50d8a7de0900119855614541f15a1a616691eb33)                                                                                                                                                                         | Searchable product styles, palettes, typography and stack-specific guidance                          | Good optional reference for a substantial design task; its local scripts/data are heavier than the core artifact prompt and are not necessary for every page | MIT                                                                                           |

The skill instruction format is portable; the agent's ability to discover a
skill and execute its scripts still depends on its CLI and installed tools.
Geniro discovers skills from each adapter's project/user/profile locations in
`SkillsService`. Installing into one account does not enable it for every CLI,
profile or workflow node. No global skills or plugins were installed by this
change, and no upstream code or skill text was vendored.

For a source-quality check, skills.sh reported approximately 971k installs for
[frontend-design](https://skills.sh/anthropics/skills/frontend-design), 108k for
[web-artifacts-builder](https://skills.sh/anthropics/skills/web-artifacts-builder),
719k for [web-design-guidelines](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines)
and 390k for [UI UX Pro Max](https://skills.sh/nextlevelbuilder/ui-ux-pro-max-skill/ui-ux-pro-max).
GitHub reported approximately 180k, 32k and 134k stars for the Anthropic, Vercel
and UI UX Pro Max repositories respectively. These are rounded observations at
the review date, not quality scores; recommendations above follow inspection
of the actual instructions and compatibility.

## Gaps in the previous authoring guidance

The shared `show_artifact` description already documents the sandbox, CDN
libraries, theme helpers, optional classes and revision protocol. It did include
basic design advice. The remaining gaps were:

- No explicit subject/audience/visual-direction pass before markup.
- Little guidance on choosing a composition from the content, beyond chart type.
- A large catalogue of cards and tiles presented as the easiest default.
- An unconditional ban on custom colours and a transparent page requirement,
  even when the brief called for a product mockup or a distinct visual identity.
- No explicit rendered review at narrow/wide sizes, interaction check or honest
  fallback when browser tools are unavailable.
- No explanation of how richer React/component-library output can fit the
  single-document renderer.

These are authoring gaps inferred from the code, not measured model benchmarks.

## Implemented

`apps/daemon/src/v1/agents/utils/artifact-design.ts` provides original, compact
guidance in the shared MCP tool description, before the technical catalogue.
It applies to all agent kinds and workflow nodes receiving `show_artifact`,
without an installation or new skill-loading protocol:

1. Identify the reader's job and choose a direction grounded in the brief.
2. Pick a composition that explains the content, with one dominant element.
3. Build consistent typography, spacing and useful interactions.
4. Handle responsive layout, legible data, keyboard use and relevant states.
5. Inspect the rendered page, exercise it and revise before publishing.

The component kit is now explicitly optional. App tokens and a transparent
outer page remain the default; a distinct brief may use scoped surfaces, colours
and type. Custom themes must pair readable foreground/background colours and
follow `geniro.theme().dark` and the `geniro:theme` event, because system
`prefers-color-scheme` may disagree with the user's selected Geniro theme.
The runtime and network policy are unchanged.

The description also explains that complex React/Radix/shadcn artifacts must be
built outside the iframe and bundled into one HTML document with inline code,
styles and assets. It does not add a bundler or automatically install libraries.

## Library choices

| Need                                              | Recommended starting point                                                                              | Runtime constraint                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Small tool, explainer, plan                       | Semantic HTML/CSS/JS + Geniro's optional kit                                                            | No build or network dependency required                                                                  |
| Several coordinated stateful controls             | Existing [Preact + htm](https://github.com/developit/htm#preact) UMD build                              | Plain script on an allowed CDN; no JSX compiler needed                                                   |
| Full application prototype, complex menus/dialogs | [React + shadcn/ui](https://ui.shadcn.com/docs) with its accessible primitives                          | Compile locally and inline the complete output. shadcn is component source, not a drop-in CDN stylesheet |
| Interactive quantitative views                    | Existing [ECharts](https://echarts.apache.org/handbook/en/get-started/) via `geniro.chart`, or Chart.js | ECharts helper follows the host theme; set a container height and readable axes/units                    |
| Relationships or sequences                        | Existing Mermaid; authored SVG when custom spatial layout is necessary                                  | Mermaid is auto-themed; SVG needs container-based dimensions and readable labels                         |
| Charts with specialised marks                     | [D3](https://d3js.org/getting-started) when ECharts cannot express the design                           | Use a pinned plain-script build on an allowed CDN or inline it; embed data locally                       |
| Styling, icons, tables, dragging                  | Existing Tailwind, Lucide, Grid.js, SortableJS                                                          | Load only what the artifact uses; dragging needs a keyboard alternative                                  |

The sandbox permits inline scripts/styles, data assets and its existing CDN
allowlist. It does not permit data fetching, app storage, a dev server, remote
images or arbitrary local JS/CSS paths. Inline all output chunks and fonts/assets
needed offline, avoid runtime imports/lazy loading, and keep HTML below 512 KiB.
An ordinary Vite build produces separate assets; [Vite's build guide](https://vite.dev/guide/build.html)
is not itself a single-file bundler. Anthropic's builder explicitly adds a build
and asset-inlining step. Its pinned dependencies and scripts need review before
we ship them as a maintained Geniro tool.

## Review example and limits

[`examples/artifact-design.html`](examples/artifact-design.html) is a standalone
interactive reference showing three different compositions for a plan, a system
and a calculator. It uses embedded data, native controls and no remote assets,
and follows host theme changes when served as a Geniro artifact. Its scenario
and timings are explicitly illustrative. It is a hand-authored reference, not
an A/B test demonstrating that every future model output will improve.

This change deliberately leaves automatic React scaffolding/bundling, a new
component dependency and a model-quality benchmark unimplemented. The next
quality assessment should run identical briefs through the previous and updated
guidance and judge screenshots for fidelity, composition, responsiveness,
interaction completeness and theme legibility. That comparison is needed before
claiming parity with Claude or a measured reduction in design gaps.
