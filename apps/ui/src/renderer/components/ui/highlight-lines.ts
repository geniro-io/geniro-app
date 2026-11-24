import { createElement, Fragment, type ReactNode } from 'react';
import { refractor } from 'refractor';

import { registered } from './code-language';

type HighlightedTree = ReturnType<typeof refractor.highlight>;
type TreeNode = HighlightedTree['children'][number];
type TokenNode = Extract<TreeNode, { type: 'element' }>;

export function highlightLines(
  lines: readonly string[],
  language: string | null,
): ReactNode[] {
  const grammar = registered(language);
  if (grammar === null || lines.length === 0) {
    return [...lines];
  }
  let tree: HighlightedTree;
  try {
    tree = refractor.highlight(lines.join('\n'), grammar);
  } catch {
    return [...lines];
  }
  const split: ReactNode[][] = [[]];
  for (const node of tree.children) {
    appendNode(node, [], split);
  }
  if (split.length !== lines.length) {
    return [...lines];
  }
  return split.map((children, index) =>
    createElement(Fragment, { key: index }, ...children),
  );
}

function appendNode(
  node: TreeNode,
  classes: readonly string[],
  split: ReactNode[][],
): void {
  if (node.type === 'text') {
    node.value.split('\n').forEach((part, index) => {
      if (index > 0) {
        split.push([]);
      }
      if (part !== '') {
        split[split.length - 1]!.push(wrap(part, classes));
      }
    });
    return;
  }
  if (node.type === 'element') {
    const enclosing = [...classes, classNameOf(node)];
    for (const child of node.children) {
      appendNode(child, enclosing, split);
    }
  }
}

function wrap(text: string, classes: readonly string[]): ReactNode {
  return classes.reduceRight<ReactNode>(
    (child, className) => createElement('span', { className }, child),
    text,
  );
}

function classNameOf(node: TokenNode): string {
  const { className } = node.properties;
  return Array.isArray(className)
    ? className.join(' ')
    : String(className ?? '');
}
