import type { IpcMainInvokeEvent } from 'electron';

/**
 * Whether a channel may also be answered over the LAN gateway's HTTP shim —
 * which lands in main with no WebContents behind it, unlike a real
 * `ipcMain.handle` call. A denied channel carries the reason a refusal would
 * show the person holding the phone, since "no" alone explains nothing when
 * the same channel works fine from the desktop app.
 */
export type RemotePolicy =
  | {
      readonly remote: 'allow';
      /**
       * Narrows this channel's answer before it crosses to a remote client.
       *
       * Some channels are safe to CALL remotely while part of what they
       * return is not safe to SEND — `getStatus` is the case that forced
       * this: a phone genuinely needs to know whether onboarding is done,
       * and the same reply carries the daemon's per-launch bearer token.
       * Declared beside the handler rather than as a rule inside the bridge,
       * so what is withheld is visible where the channel is registered and
       * cannot become a growing list of special cases somewhere else.
       */
      readonly redactForRemote?: (value: unknown) => unknown;
      /**
       * Refuses specific ARGUMENTS before the handler ever runs, for a
       * channel that is safe to call remotely in general but whose payload
       * can carry a field a phone must never set (`updateSettings`'s
       * `cliPaths`/`daemonInspect` — a spawned-agent binary path and the
       * node inspector switch). `redactForRemote` cannot do this job: it
       * only ever sees the handler's REPLY, by which point the field has
       * already taken effect. Returns the refusal reason, or `null` to let
       * the call through unchanged.
       */
      readonly refuseRemoteArgs?: (args: readonly unknown[]) => string | null;
    }
  | { readonly remote: 'deny'; readonly reason: string };

/** The common case: nothing about this channel depends on a WebContents. */
export const ALLOW_REMOTELY: RemotePolicy = { remote: 'allow' };

/** Allowed remotely, but with part of its answer withheld — see {@link RemotePolicy}. */
export function allowRemotelyRedacted(
  redactForRemote: (value: unknown) => unknown,
): RemotePolicy {
  return { remote: 'allow', redactForRemote };
}

/**
 * Allowed remotely, but refusing a call whose FIRST argument (every current
 * caller's patch/input object) carries any of `fields` with a defined value —
 * see {@link RemotePolicy.refuseRemoteArgs}.
 */
export function allowRemotelyExceptFields(
  fields: readonly string[],
  reason: string,
): RemotePolicy {
  return {
    remote: 'allow',
    refuseRemoteArgs: (args) => {
      const patch = args[0];
      if (typeof patch !== 'object' || patch === null) {
        return null;
      }
      const named = fields.filter(
        (field) => (patch as Record<string, unknown>)[field] !== undefined,
      );
      return named.length === 0
        ? null
        : `${reason} (refused: ${named.join(', ')})`;
    },
  };
}

/** A channel the LAN gateway must refuse, with the sentence a refusal shows. */
export function denyRemotely(reason: string): RemotePolicy {
  return { remote: 'deny', reason };
}

/**
 * The shape every `ipcMain.handle` callback already has. `unknown` rather
 * than a per-channel generic: each handler in `ipc.ts` validates its own
 * arguments with its own zod schema, and the registry has no reason to know
 * any channel's particular shape.
 */
export type IpcChannelHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

export interface RegisteredIpcChannel {
  readonly handler: IpcChannelHandler;
  readonly policy: RemotePolicy;
}

/**
 * Every channel `registerIpc` wired up, keyed by its WIRE name (`IPC.x`'s
 * string value — what an HTTP request from the LAN gateway carries) rather
 * than its `GeniroApi` property name. Built once, by `registerIpc`'s own
 * `handle` helper, alongside the matching `ipcMain.handle` call — so the IPC
 * channel and the remote HTTP path can never come to answer one channel two
 * different ways.
 */
export class IpcRegistry {
  private readonly channels = new Map<string, RegisteredIpcChannel>();

  register(
    channel: string,
    policy: RemotePolicy,
    handler: IpcChannelHandler,
  ): void {
    this.channels.set(channel, { handler, policy });
  }

  /** A channel's entry, or `undefined` for a name nothing registered. */
  get(channel: string): RegisteredIpcChannel | undefined {
    return this.channels.get(channel);
  }

  /** Every registered channel's wire name. */
  channelNames(): string[] {
    return [...this.channels.keys()];
  }
}
