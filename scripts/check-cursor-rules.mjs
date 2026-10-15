#!/usr/bin/env node
/**
 * Fail when `.cursor/rules/` drifts from `.claude/rules/`.
 *
 *   node scripts/check-cursor-rules.mjs
 *
 * Cursor reads each rule through `.cursor/rules/<name>.mdc`, a tracked symlink
 * to `../../.claude/rules/<name>.md` (AGENTS.md → Repository rules). Every rule
 * needs its link, every link must be a symlink with exactly that target and
 * resolve, and no `.mdc` may outlive its rule. Prints the command that fixes
 * each problem. Dependency-free; CI's Build and Lint job and `pnpm full-check`
 * run it.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rulesDir = join(root, '.claude/rules');
const cursorDir = join(root, '.cursor/rules');

const list = (dir, ext) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .map((f) => f.slice(0, -ext.length))
    : [];

const rules = new Set(list(rulesDir, '.md'));
const links = new Set(list(cursorDir, '.mdc'));
const target = (name) => `../../.claude/rules/${name}.md`;
const link = (name) => `.cursor/rules/${name}.mdc`;
const relink = (name) => `ln -sf ${target(name)} ${link(name)}`;

const problems = [];

for (const name of rules) {
  if (!links.has(name)) {
    problems.push([`${link(name)} is missing`, relink(name)]);
  }
}

for (const name of links) {
  if (!rules.has(name)) {
    problems.push([
      `${link(name)} has no .claude/rules/${name}.md behind it`,
      `rm ${link(name)}`,
    ]);
    continue;
  }
  const path = join(cursorDir, `${name}.mdc`);
  if (!lstatSync(path).isSymbolicLink()) {
    problems.push([
      `${link(name)} is a plain file, not a symlink`,
      relink(name),
    ]);
    continue;
  }
  const actual = readlinkSync(path);
  if (actual !== target(name)) {
    const dangles = existsSync(path) ? '' : ' (dangling)';
    problems.push([
      `${link(name)} points to ${actual}${dangles}, not ${target(name)}`,
      relink(name),
    ]);
  }
}

if (problems.length > 0) {
  console.error(
    '.cursor/rules/ has drifted from .claude/rules/ (AGENTS.md → Repository rules):',
  );
  for (const [what, fix] of problems) {
    console.error(`  - ${what}\n      fix: ${fix}`);
  }
  process.exit(1);
}
console.log(`.cursor/rules/: ${rules.size} rules, each linked.`);
