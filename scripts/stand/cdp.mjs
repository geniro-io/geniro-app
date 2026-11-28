#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

import { cdpSession, isRendererTarget, pageTargets } from './lib.mjs';

const USAGE = `usage: node scripts/stand/cdp.mjs <cdp port> [tab <n>] [width <px>] <command>
  eval '<js>'            print the value of an expression (promises awaited)
  shot <file.png>        save the viewport
  click '<css>'          click the first visible, uncovered match with a real pointer
  text-click '<text>'    click what reads exactly <text> (its text, own text or aria-label), controls first: dialogs, then main, then the page
  reload                 reload ignoring the cache
  raw <Method> ['<json>'] any other CDP method
  width <px>             emulate a viewport <px> wide for the rest of this call (0 clears); alone it prints the width
  tab                    list the page targets with their index
  tab <n> <command>      run <command> on the n-th page target (default: the renderer)`;

const [, , portArg, ...argv] = process.argv;
if (!portArg || !/^\d+$/.test(portArg) || argv.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

async function pointerClick(call, box) {
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
  });
}

const boxOf = (finder) => `(() => {
  const candidates = (${finder})();
  let covered = null;
  for (const el of candidates) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (top && (el === top || el.contains(top))) {
      return { x, y, tag: el.tagName.toLowerCase() };
    }
    covered ??= top ? (top.closest('[role="dialog"]')?.getAttribute('aria-label') ?? top.tagName.toLowerCase() + (top.className ? '.' + String(top.className).split(' ')[0] : '')) : 'nothing';
  }
  return covered === null ? null : { covered };
})()`;

const cssFinder = (selector) =>
  `() => [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.checkVisibility())`;

const textFinder = (text) => `() => {
  const wanted = ${JSON.stringify(text)}.trim();
  const clickable = 'button, a, [role="button"], [role="option"], [role="menuitem"], [role="tab"], label, summary';
  const reads = (e) =>
    (e.innerText ?? '').trim() === wanted ||
    e.getAttribute('aria-label') === wanted ||
    [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim() === wanted;
  const scopes = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'), ...document.querySelectorAll('main'), document.body];
  const found = [];
  for (const scope of scopes) {
    if (!scope.checkVisibility()) continue;
    const hits = [...scope.querySelectorAll('*')].filter((e) => e.checkVisibility() && reads(e));
    const deepest = hits.filter((e) => !hits.some((other) => other !== e && e.contains(other)));
    for (const e of deepest) {
      const target = e.closest(clickable) ?? e;
      if (!found.includes(target)) found.push(target);
    }
  }
  return [...found.filter((e) => e.matches(clickable)), ...found.filter((e) => !e.matches(clickable))];
}`;

async function run({ call, evaluate }, command, args) {
  switch (command) {
    case 'eval':
      return JSON.stringify(await evaluate(args[0] ?? 'undefined'), null, 2);
    case 'shot': {
      if (!args[0]) throw new Error('shot needs a file path');
      const result = await call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(args[0], Buffer.from(result.data, 'base64'));
      return `saved ${args[0]}`;
    }
    case 'click':
    case 'text-click': {
      if (!args[0]) throw new Error(`${command} needs an argument`);
      const box = await evaluate(
        boxOf(command === 'click' ? cssFinder(args[0]) : textFinder(args[0])),
      );
      if (!box)
        throw new Error(
          command === 'click'
            ? `no visible element matches ${args[0]}`
            : `no visible element reads exactly "${args[0]}"`,
        );
      if (box.covered)
        throw new Error(
          `every match is covered at its centre by ${box.covered}; close what is on top first`,
        );
      await pointerClick(call, box);
      return `clicked ${box.tag} at ${Math.round(box.x)},${Math.round(box.y)}`;
    }
    case 'reload':
      await call('Page.reload', { ignoreCache: true });
      return 'reloaded';
    case 'raw': {
      if (!args[0]) throw new Error('raw needs a CDP method');
      return JSON.stringify(
        (await call(args[0], JSON.parse(args[1] ?? '{}'))) ?? null,
      );
    }
    default:
      throw new Error(`unknown command "${command}"\n${USAGE}`);
  }
}

async function main() {
  const steps = [...argv];
  const targets = await pageTargets(portArg);
  let target = targets.find(isRendererTarget);
  if (steps[0] === 'tab') {
    steps.shift();
    if (steps.length === 0) {
      targets.forEach((t, index) =>
        console.log(`${index}\t${t.url}\t${t.title}`),
      );
      return;
    }
    const index = Number(steps.shift());
    if (!Number.isInteger(index) || !targets[index])
      throw new Error(`no page target ${index}; run "tab" to list them`);
    target = targets[index];
  }
  if (!target)
    throw new Error('no renderer target; run "tab" to list the page targets');

  const session = await cdpSession(target);
  const { call, evaluate } = session;
  try {
    if (steps[0] === 'width') {
      steps.shift();
      const px = Number(steps.shift());
      if (!Number.isInteger(px) || px < 0)
        throw new Error('width needs a whole number of pixels');
      if (px === 0) {
        await call('Emulation.clearDeviceMetricsOverride');
      } else {
        const height = await evaluate('window.innerHeight');
        await call('Emulation.setDeviceMetricsOverride', {
          width: px,
          height,
          deviceScaleFactor: 0,
          mobile: false,
        });
      }
      if (steps.length === 0) {
        console.log(`innerWidth ${await evaluate('window.innerWidth')}`);
        return;
      }
    }
    const [command, ...args] = steps;
    console.log(await run(session, command, args));
  } finally {
    session.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
