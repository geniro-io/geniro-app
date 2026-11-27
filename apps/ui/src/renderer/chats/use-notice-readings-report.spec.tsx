// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDetection, UpdateState } from '../../shared/contracts';
import {
  detection as det,
  updateAvailable as withUpdate,
  updateState,
} from '../__tests__/settings-attention-fixtures';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { useNoticeReadingsReport } from './use-notice-readings-report';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let reportCommandCenterNoticeReadings: ReturnType<typeof vi.fn>;
let reconnected: (() => void) | null;
let apis: DaemonApis;

const client = {
  onReconnect: (listener: () => void) => {
    reconnected = listener;
    return () => {
      reconnected = null;
    };
  },
} as unknown as DaemonClient;

function Reporter(props: {
  detections: readonly CliDetection[] | null;
  update: UpdateState | null;
  remote: boolean;
}): null {
  useNoticeReadingsReport({ apis, client, ...props });
  return null;
}

async function draw(
  props: Partial<{
    detections: readonly CliDetection[] | null;
    update: UpdateState | null;
    remote: boolean;
  }> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <Reporter
        detections={props.detections ?? null}
        update={props.update ?? null}
        remote={props.remote ?? false}
      />,
    );
  });
}

beforeEach(() => {
  reconnected = null;
  reportCommandCenterNoticeReadings = vi.fn(() => Promise.resolve());
  apis = {
    commandCenter: { reportCommandCenterNoticeReadings },
  } as unknown as DaemonApis;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useNoticeReadingsReport', () => {
  it('reports the Geniro update and the agent CLIs with no manager chat on screen', async () => {
    await draw({
      update: updateState({ phase: 'available', version: '2.4.0' }),
      detections: [
        det('claude', { update: withUpdate('2.0.0') }),
        det('codex', { loggedIn: false }),
      ],
    });

    expect(reportCommandCenterNoticeReadings).toHaveBeenCalledTimes(1);
    expect(reportCommandCenterNoticeReadings).toHaveBeenLastCalledWith({
      settingsNoticeReadingsDto: {
        readings: [
          { kind: 'app-update', items: ['2.4.0'], unsettled: [] },
          {
            kind: 'agent-updates',
            items: ['claude@2.0.0'],
            unsettled: ['codex@'],
          },
          { kind: 'agent-sign-in', items: ['codex:'], unsettled: [] },
        ],
      },
    });
  });

  it('reports again when the reading changes, never for the same reading drawn again', async () => {
    const signedOut = [det('codex', { loggedIn: false })];
    await draw({ detections: signedOut });
    await draw({ detections: [det('codex', { loggedIn: false })] });
    expect(reportCommandCenterNoticeReadings).toHaveBeenCalledTimes(1);

    await draw({ detections: [det('codex')] });

    expect(reportCommandCenterNoticeReadings).toHaveBeenCalledTimes(2);
    expect(reportCommandCenterNoticeReadings).toHaveBeenLastCalledWith({
      settingsNoticeReadingsDto: {
        readings: [
          { kind: 'agent-updates', items: [], unsettled: ['codex@'] },
          { kind: 'agent-sign-in', items: [], unsettled: [] },
        ],
      },
    });
  });

  it('reports the same reading again after a reconnect, for a daemon that restarted', async () => {
    await draw({ detections: [det('codex', { loggedIn: false })] });

    await act(async () => {
      reconnected?.();
    });

    expect(reportCommandCenterNoticeReadings).toHaveBeenCalledTimes(2);
  });

  it('reports nothing from a paired device, or before main has read anything', async () => {
    await draw();
    await draw({
      remote: true,
      update: updateState({ phase: 'available', version: '2.4.0' }),
    });
    await act(async () => {
      reconnected?.();
    });

    expect(reportCommandCenterNoticeReadings).not.toHaveBeenCalled();
  });
});
