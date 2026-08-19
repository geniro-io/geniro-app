import { describe, expect, it } from 'vitest';

import { UPDATE_COMMAND, type UpdateState } from '../../shared/contracts';
import { footerUpdate } from './update-status';

/** An `UpdateState` with only the fields a case cares about spelled out. */
function updateState(patch: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    version: null,
    progress: null,
    message: null,
    currentVersion: '1.2.3',
    canInstall: true,
    ...patch,
  };
}

describe('footerUpdate', () => {
  it('reports an install swap in progress as a non-pressable percentage-less readout', () => {
    // `installing` carries no `progress` field at all — unlike `downloading`,
    // there is no fraction to show, so the label is the word rather than a
    // stale or fabricated number.
    expect(
      footerUpdate(
        updateState({ phase: 'installing', version: '1.47.0' }),
        false,
      ),
    ).toEqual({
      kind: 'progress',
      label: 'installing',
      title: 'Installing Geniro 1.47.0…',
    });
  });

  it('labels a download with no progress yet as "updating", never "0%"', () => {
    // `progress` is null until the first chunk lands. "0%" beside an offer
    // that has begun reads as one that is stuck, so the row says only that
    // something is moving until there is a real fraction to state.
    expect(
      footerUpdate(
        updateState({
          phase: 'downloading',
          version: '1.47.0',
          progress: null,
        }),
        false,
      ),
    ).toEqual({
      kind: 'progress',
      label: 'updating',
      title: 'Downloading Geniro 1.47.0…',
    });
  });

  it('offers a non-pressable readout, never a dead button, for an update this install cannot apply', () => {
    // `canInstall: false` is a real shipped state — a Homebrew install, a
    // translocated quarantine copy — and the row is this copy's only
    // remaining update channel, so it must say SOMETHING rather than fall to
    // `none` the way a dead button would have to.
    expect(
      footerUpdate(
        updateState({
          phase: 'available',
          version: '1.47.0',
          canInstall: false,
          message: `Update with: ${UPDATE_COMMAND}`,
        }),
        false,
      ),
    ).toEqual({
      kind: 'readout',
      label: '1.47.0',
      // main's own words, carried through rather than re-worded here.
      title: `Update with: ${UPDATE_COMMAND}`,
    });
  });

  it('falls back to naming the command itself when main sent no message', () => {
    // The type still allows a null message here; without a fallback this
    // would read as a title of literally nothing rather than the one command
    // that can apply the update.
    expect(
      footerUpdate(
        updateState({
          phase: 'available',
          version: '1.47.0',
          canInstall: false,
          message: null,
        }),
        false,
      ),
    ).toEqual({
      kind: 'readout',
      label: '1.47.0',
      title: `Update with: ${UPDATE_COMMAND}`,
    });
  });
});
