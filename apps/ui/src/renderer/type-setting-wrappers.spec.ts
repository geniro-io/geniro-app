import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The convention guard for the `[&_button]` escape hatch documented in
 * `styles/global.css` (around the `button { font-size: var(--text-base); … }`
 * rule) and demonstrated by `SectionLabel` in `chats/block-shell.tsx`.
 *
 * `global.css` gives every bare `<button>` an explicit `font-size` as a
 * DIRECT rule on the element, which wins over whatever an ancestor's own
 * `text-xs`/`text-sm`/`text-[Npx]` class would otherwise make it inherit — a
 * wrapper that sets a smaller type size for its region does not reach a plain
 * `<button>` inside it (measured: 42 buttons rendering larger than their own
 * parent asked for). The fix is never to touch the base rule (that regresses
 * the 189 bare buttons that have no wrapper) — it is for the WRAPPER to also
 * say `[&_button]:text-[Npx]` `[&_button]:font-normal`, which is a compound
 * selector that outranks the plain `button {}` rule. `Button` (the shared
 * primitive) and `Chip` are exempt by construction: their own `cva` base
 * strings always carry an explicit `text-*` class
 * (`components/ui/button.tsx`, `components/ui/chip.tsx`), so a raw `<button>`
 * is the only shape that can leak.
 *
 * This file enumerates every such wrapper the same way the manual sweep did —
 * mechanically, over the real source — and asserts the invariant holds for
 * each one, so the NEXT wrapper added without the override fails a test
 * instead of drifting silently the way the first one did.
 */

const RENDERER_ROOT = __dirname;

/** A class token that sets a smaller-than-base type size on its own element. */
const TYPE_SETTING = /^text-(xs|sm)$/;
const TYPE_SETTING_PX = /^text-\[1[0-3]px\]$/;
/** The escape hatch: a compound selector forcing that size onto descendant buttons. */
const BUTTON_OVERRIDE = /^\[&_button\]:text-/;
/**
 * An explicit font-size token on the button ITSELF. Deliberately narrower
 * than `/^text-/`, which also matches `text-left` (alignment) and
 * `text-muted-foreground` (colour) — either of those would falsely read as
 * "already sized" and hide a real leak.
 */
const SELF_SIZE = /^text-(?:xs|sm|base|lg|xl|[2-9]xl|\[[^\]]+\])$/;

function isTypeSettingToken(token: string): boolean {
  return TYPE_SETTING.test(token) || TYPE_SETTING_PX.test(token);
}

/**
 * Every module-scope `const NAME = '…'` (or a no-substitution template) in one
 * file, so an identifier used as a class string resolves to its text.
 *
 * Without this the sweep is blind to exactly the idiom this codebase uses for a
 * shared class string — `cn(OPTION_ROW, …)` in `chats/group-header.tsx`, and
 * every `cva` base — so a wrapper written that way would pass a guard that
 * cannot see it. Module scope only, and only a literal initializer: anything
 * further is modelling runtime class resolution, which this deliberately does
 * not do.
 */
function moduleStringConsts(source: ts.SourceFile): Map<string, string> {
  const consts = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (
        ts.isIdentifier(decl.name) &&
        init !== undefined &&
        (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))
      ) {
        consts.set(decl.name.text, init.text);
      }
    }
  }
  return consts;
}

/**
 * Collects every string literal / template-literal text segment reachable
 * from a className expression — through `cn(...)` calls, ternaries, `&&`
 * guards, arrays, and module-scope string constants referenced by name —
 * regardless of which branch would actually execute. This is a textual sweep,
 * exactly like the shell grep it replaces: it is over-inclusive on purpose (a
 * token that appears in source at all is enough to call a wrapper
 * "type-setting" or a button "self-sized"), which is the safe direction for a
 * guard whose job is to catch drift rather than to model runtime class
 * resolution precisely.
 *
 * It is not exhaustive, and the gap is worth naming: a class string reached
 * through an IMPORT, a computed key, or a function call is invisible here.
 */
function harvestStrings(
  node: ts.Node,
  out: string[],
  consts: Map<string, string>,
): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node.text);
    return;
  }
  if (ts.isIdentifier(node)) {
    const resolved = consts.get(node.text);
    if (resolved !== undefined) {
      out.push(resolved);
    }
    return;
  }
  if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) {
      out.push(span.literal.text);
      harvestStrings(span.expression, out, consts);
    }
    return;
  }
  node.forEachChild((child) => harvestStrings(child, out, consts));
}

function classTokensOf(
  attrs: ts.JsxAttributes | undefined,
  consts: Map<string, string>,
): string[] {
  if (!attrs) {
    return [];
  }
  const classNameAttr = attrs.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && p.name.getText() === 'className',
  );
  if (!classNameAttr?.initializer) {
    return [];
  }
  let expr: ts.Node = classNameAttr.initializer;
  if (ts.isJsxExpression(expr)) {
    if (!expr.expression) {
      return [];
    }
    expr = expr.expression;
  }
  const strings: string[] = [];
  harvestStrings(expr, strings, consts);
  return strings.flatMap((s) => s.split(/\s+/)).filter(Boolean);
}

type JsxTag = ts.JsxElement | ts.JsxSelfClosingElement;

function isJsxTag(node: ts.Node): node is JsxTag {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function tagNameOf(node: JsxTag): string {
  return (
    ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName
  ).getText();
}

function attributesOf(node: JsxTag): ts.JsxAttributes {
  return ts.isJsxElement(node)
    ? node.openingElement.attributes
    : node.attributes;
}

/** Every NATIVE `<button>` reachable below `node` — never `<Button>`, which is exempt. */
function collectButtons(node: ts.Node, out: JsxTag[]): void {
  if (isJsxTag(node) && tagNameOf(node) === 'button') {
    out.push(node);
  }
  node.forEachChild((child) => collectButtons(child, out));
}

export interface WrapperViolation {
  line: number;
  wrapperClass: string;
}

/**
 * Walks one already-parsed source file and returns every ANCESTOR-wraps-
 * unguarded-button pair: an element whose own className sets a smaller type
 * size, wrapping (as a real JSX descendant, never a sibling) a bare `<button>`
 * that neither sizes itself nor is covered by a `[&_button]` override on the
 * wrapper.
 */
export function findWrapperViolations(
  sourceFile: ts.SourceFile,
): WrapperViolation[] {
  const violations: WrapperViolation[] = [];
  const consts = moduleStringConsts(sourceFile);

  function visit(node: ts.Node): void {
    if (isJsxTag(node)) {
      const tokens = classTokensOf(attributesOf(node), consts);
      if (tokens.some(isTypeSettingToken)) {
        const hasOverride = tokens.some((t) => BUTTON_OVERRIDE.test(t));
        const buttons: JsxTag[] = [];
        // Only real JSX CHILDREN — a JsxSelfClosingElement has none, and a
        // sibling reached through the outer tree is not this element's
        // descendant, however close the lines sit in source.
        if (ts.isJsxElement(node)) {
          for (const child of node.children) {
            collectButtons(child, buttons);
          }
        }
        for (const button of buttons) {
          const buttonTokens = classTokensOf(attributesOf(button), consts);
          const selfSized = buttonTokens.some((t) => SELF_SIZE.test(t));
          if (!selfSized && !hasOverride) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
              button.getStart(sourceFile),
            );
            violations.push({ line: line + 1, wrapperClass: tokens.join(' ') });
          }
        }
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return violations;
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/** Every `.tsx` under the renderer, excluding generated code and specs themselves. */
function collectRendererFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'autogenerated' || entry.name === 'node_modules') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRendererFiles(full, out);
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.spec.')) {
      out.push(full);
    }
  }
}

describe('type-setting wrapper convention (the `[&_button]` escape hatch)', () => {
  it('leaves no type-setting wrapper around an unguarded, unsized button', () => {
    const files: string[] = [];
    collectRendererFiles(RENDERER_ROOT, files);
    expect(files.length).toBeGreaterThan(50); // sanity: the walk actually found the tree

    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const found = findWrapperViolations(parse(file, text));
      for (const v of found) {
        violations.push(
          `${relative(RENDERER_ROOT, file)}:${v.line}  wrapper="${v.wrapperClass}"`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('actually has teeth: flags a wrapper missing the override, clears one that has it', () => {
    // The exact shape of the historical bug — SectionLabel's caption before the
    // fix — reproduced as a minimal fixture rather than depending on any real
    // file staying in this exact shape.
    const bad = parse(
      'bad.tsx',
      `
      const Bad = () => (
        <p className="text-[10px]">
          <button type="button">Task list</button>
        </p>
      );
      `,
    );
    expect(findWrapperViolations(bad)).toHaveLength(1);

    const fixedByOverride = parse(
      'fixed-by-override.tsx',
      `
      const Fixed = () => (
        <p className="text-[10px] [&_button]:text-[10px] [&_button]:font-normal">
          <button type="button">Task list</button>
        </p>
      );
      `,
    );
    expect(findWrapperViolations(fixedByOverride)).toHaveLength(0);

    // A class string reached through a module-scope CONST, which is how this
    // codebase spells a shared one (`cn(OPTION_ROW, …)` in group-header.tsx,
    // and every `cva` base). A walker that only read string literals would see
    // an empty className here and clear both of these silently.
    const badBehindConst = parse(
      'bad-behind-const.tsx',
      `
      const CAPTION = 'text-[10px] uppercase';
      const Bad = () => (
        <p className={cn(CAPTION, 'tracking-wide')}>
          <button type="button">Task list</button>
        </p>
      );
      `,
    );
    expect(findWrapperViolations(badBehindConst)).toHaveLength(1);

    const fixedBehindConst = parse(
      'fixed-behind-const.tsx',
      `
      const ROW = 'text-sm';
      const Fixed = () => (
        <p className="text-[10px]">
          <button type="button" className={cn(ROW, 'font-normal')}>Task list</button>
        </p>
      );
      `,
    );
    expect(findWrapperViolations(fixedBehindConst)).toHaveLength(0);

    const fixedBySelfSizing = parse(
      'fixed-by-self-sizing.tsx',
      `
      const Fixed = () => (
        <p className="text-[10px]">
          <button type="button" className="text-[10px] font-normal">Task list</button>
        </p>
      );
      `,
    );
    expect(findWrapperViolations(fixedBySelfSizing)).toHaveLength(0);

    // A `<button>`'s OWN colour/alignment classes (both spelled `text-…`) must
    // never be mistaken for a size override — that false reading is exactly
    // what would let a real leak through silently.
    const stillUnsized = parse(
      'still-unsized.tsx',
      `
      const StillUnsized = () => (
        <p className="text-[10px]">
          <button type="button" className="text-left text-muted-foreground">Task list</button>
        </p>
      );
      `,
    );
    expect(findWrapperViolations(stillUnsized)).toHaveLength(1);

    // The shared `Button`/`Chip` primitives are capitalized components, never
    // the native tag this guard watches — they are exempt by construction
    // (their own `cva` base string always sets `text-*`), not by escaping
    // detection.
    const sharedButton = parse(
      'shared-button.tsx',
      `
      const Safe = () => (
        <p className="text-xs">
          <Button type="button">Answer</Button>
        </p>
      );
      `,
    );
    expect(findWrapperViolations(sharedButton)).toHaveLength(0);
  });

  it('reads the SHIPPED fix live off disk, and goes red the moment it is reverted', () => {
    // This does not hand-copy SectionLabel's className or the task list's
    // button markup into a fixture — it reads both off the real files, so a
    // future edit to either one is what this test is actually about, not a
    // frozen snapshot of today's classes.
    const blockShellSrc = readFileSync(
      join(RENDERER_ROOT, 'chats', 'block-shell.tsx'),
      'utf8',
    );
    const taskListSrc = readFileSync(
      join(RENDERER_ROOT, 'chats', 'task-list.tsx'),
      'utf8',
    );

    const sectionLabelClass = blockShellSrc.match(
      /<p className="([^"]*\[&_button\]:text-\[\d+px\][^"]*)">\s*\{children\}\s*<\/p>/,
    )?.[1];
    if (sectionLabelClass === undefined) {
      throw new Error(
        'SectionLabel in chats/block-shell.tsx no longer matches the shape ' +
          'this test reads — update the pattern above, do not delete the check.',
      );
    }

    // The ONE real consumer that relies on the wrapper (rather than sizing
    // itself): the task list's disclosure button, rendered inside a bare
    // `<SectionLabel>` with no className of its own.
    const buttonStart = taskListSrc.indexOf('<SectionLabel>');
    if (buttonStart === -1) {
      throw new Error(
        'task-list.tsx no longer wraps its disclosure button in ' +
          '<SectionLabel> — update this test to point at the real consumer.',
      );
    }
    const buttonOpenStart = taskListSrc.indexOf('<button', buttonStart);
    const buttonEnd =
      taskListSrc.indexOf('</button>', buttonOpenStart) + '</button>'.length;
    const buttonSnippet = taskListSrc.slice(buttonOpenStart, buttonEnd);

    const compose = (pClass: string): ts.SourceFile =>
      parse(
        'live.tsx',
        `const X = () => (\n  <p className="${pClass}">\n    ${buttonSnippet}\n  </p>\n);`,
      );

    // As shipped: the wrapper carries its own override, so this passes.
    expect(findWrapperViolations(compose(sectionLabelClass))).toHaveLength(0);

    // Reverted: strip exactly the escape hatch, nothing else, and the same
    // real button now leaks — which is the regression this whole file exists
    // to catch the next time it happens to a DIFFERENT wrapper.
    const reverted = sectionLabelClass
      .replace(/\s*\[&_button\]:text-\[\d+px\]\s*/, ' ')
      .replace(/\s*\[&_button\]:font-normal\s*/, ' ')
      .trim();
    expect(reverted).not.toContain('[&_button]');
    expect(findWrapperViolations(compose(reverted))).toHaveLength(1);
  });
});
