import { describe, expect, it } from 'vitest';

import {
  composeTurnInstructions,
  GENIRO_UI_PREAMBLE,
} from './agent-instructions';

describe('GENIRO_UI_PREAMBLE', () => {
  it('contradicts the terminal claim rather than only stating the truth', () => {
    // The CLI's own system prompt says the output goes to a terminal, and
    // `--append-system-prompt` cannot delete that line. Dropping the rebuttal
    // and keeping only "you are in a desktop app" is the regression this pins:
    // the preamble would then read as a second opinion, not a correction.
    expect(GENIRO_UI_PREAMBLE).toContain('terminal');
    expect(GENIRO_UI_PREAMBLE.toLowerCase()).toContain('disregard');
  });

  it('tells the agent how to embed an image', () => {
    expect(GENIRO_UI_PREAMBLE).toContain('![alt](path)');
  });

  it('does not promise remote image URLs, which the renderer CSP refuses', () => {
    // `img-src 'self' data:` means an http(s) source renders as a broken box.
    // Promising it is the one instruction here that would visibly damage a
    // transcript, so the preamble must name it as unsupported — and must never
    // drift into presenting it as a working option.
    const [renders, doesNotRender] =
      GENIRO_UI_PREAMBLE.split('Does not render:');
    expect(doesNotRender).toBeDefined();
    expect(renders).not.toContain('http');
    expect(doesNotRender).toContain('http');
  });
});

describe('composeTurnInstructions', () => {
  it('always leads with the preamble, even when the turn contributes nothing', () => {
    expect(composeTurnInstructions({})).toBe(GENIRO_UI_PREAMBLE);
  });

  it('orders the parts general → specific, call surface last', () => {
    const composed = composeTurnInstructions({
      customInstructions: 'GLOBAL',
      systemPrompt: 'NODE_ROLE',
      callSurfacePrompt: 'MAY_CALL',
    });

    expect(composed).toBe(
      `${GENIRO_UI_PREAMBLE}\n\nGLOBAL\n\nNODE_ROLE\n\nMAY_CALL`,
    );
  });

  it('keeps a node role ranked above the global instructions', () => {
    // Specific beats general: a node authored for one job outranks a
    // preference the user set once for every agent. Position IS the precedence
    // mechanism here, so swapping these two is a real behaviour change.
    const composed = composeTurnInstructions({
      customInstructions: 'GLOBAL',
      systemPrompt: 'NODE_ROLE',
    });

    expect(composed.indexOf('GLOBAL')).toBeLessThan(
      composed.indexOf('NODE_ROLE'),
    );
  });

  it('drops a blank part instead of joining it as an empty paragraph', () => {
    // A cleared settings textarea arrives as '' at least as often as it
    // arrives absent, and a whitespace-only value is the same intent.
    expect(
      composeTurnInstructions({ customInstructions: '', systemPrompt: 'ROLE' }),
    ).toBe(`${GENIRO_UI_PREAMBLE}\n\nROLE`);
    expect(
      composeTurnInstructions({
        customInstructions: '   \n  ',
        systemPrompt: 'ROLE',
      }),
    ).toBe(`${GENIRO_UI_PREAMBLE}\n\nROLE`);
  });

  it('drops a null part the same way it drops an absent one', () => {
    expect(
      composeTurnInstructions({
        customInstructions: null,
        systemPrompt: null,
        callSurfacePrompt: null,
      }),
    ).toBe(GENIRO_UI_PREAMBLE);
  });

  it('trims a part rather than carrying the user’s trailing newlines into argv', () => {
    expect(
      composeTurnInstructions({ customInstructions: '  BE TERSE\n\n' }),
    ).toBe(`${GENIRO_UI_PREAMBLE}\n\nBE TERSE`);
  });
});

describe('composeTurnInstructions — instruction blocks', () => {
  // Order IS precedence here, and the block sits between the two fields it is
  // a peer of: below a preference the user set for every agent, above the role
  // of the one node it happens to reach.
  it('ranks the blocks below the user instructions and above the node role', () => {
    expect(
      composeTurnInstructions({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        instructionBlocks: 'BLOCK',
        systemPrompt: 'ROLE',
        callSurfacePrompt: 'CALLS',
      }),
    ).toBe('GLOBAL\n\nBLOCK\n\nROLE\n\nCALLS');
  });

  it('drops a blank block instead of joining an empty paragraph', () => {
    expect(
      composeTurnInstructions({
        includePreamble: false,
        customInstructions: 'GLOBAL',
        instructionBlocks: '   ',
        systemPrompt: 'ROLE',
      }),
    ).toBe('GLOBAL\n\nROLE');
  });

  it('is absent for a plain chat turn, which has no canvas to wire one on', () => {
    expect(
      composeTurnInstructions({
        includePreamble: false,
        customInstructions: 'GLOBAL',
      }),
    ).toBe('GLOBAL');
  });
});
