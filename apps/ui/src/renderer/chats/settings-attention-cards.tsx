import {
  CircleArrowUp,
  CircleCheck,
  Download,
  GitCompareArrows,
  KeyRound,
  Link2,
} from 'lucide-react';
import { useContext } from 'react';

import type { CliDetection, ConfigProfile } from '../../shared/contracts';
import { agentDisplayName, AgentIdentityContext } from '../agent-identity';
import { accountLogins, type SignedOutAccount } from '../cli-sign-ins';
import { AppUpdateActions } from '../components/app-update-actions';
import { CliLoginProgress } from '../components/cli-login-progress';
import { ErrorText } from '../components/error-text';
import { SignInAction } from '../components/sign-in-action';
import { Button } from '../components/ui/button';
import type { DaemonApis } from '../daemon-api';
import type { CliUpdatesController } from '../settings/use-cli-updates';
import { updateStatusText } from '../updates/update-status';
import type { UpdateController } from '../updates/use-update-state';
import { type CliLoginController, loginUnderWay } from '../use-cli-login';
import { NoticeCard } from './notice-card';
import {
  appInstallFailed,
  appUpdateUnsettled,
  appUpdateWaits,
  configDirName,
  newestNoticeVersion,
  type ShareWait,
  shareWaitOf,
  signInNoticeKey,
  storedShareWait,
} from './settings-attention';
import type { SettingsNoticeRowView } from './settings-notice-payload';
import {
  SettingsNoticesContext,
  type SettingsNoticesStore,
} from './settings-notices-context';

const SLOT = 'settings-attention';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Rows({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
      {children}
    </ul>
  );
}

function Row({
  slot,
  text,
  action,
  children,
}: {
  slot: string;
  text: string;
  action: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li
      data-slot={slot}
      className="flex min-w-0 flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-3 [&>button]:shrink-0">
        <span className="min-w-0 flex-1 text-sm break-words">{text}</span>
        {action}
      </div>
      {children}
    </li>
  );
}

export function AgentUpdatesCard({
  rows,
  updates,
  nameOf,
  onDismiss,
}: {
  rows: readonly CliDetection[];
  updates: CliUpdatesController;
  nameOf: (kind: string) => string;
  onDismiss?: () => void;
}): React.JSX.Element {
  return (
    <NoticeCard
      slot={SLOT}
      kind="agent-updates"
      icon={CircleArrowUp}
      label="Update available"
      heading={plural(rows.length, 'agent', 'agents')}
      onDismiss={onDismiss}>
      <Rows>
        {rows.map((detection) => {
          const running = updates.updating.has(detection.kind);
          const result = updates.results[detection.kind];
          const versions =
            detection.update.latestVersion === null
              ? (detection.version ?? '')
              : `${detection.version ?? '?'} → ${detection.update.latestVersion}`;
          return (
            <Row
              key={detection.kind}
              slot="settings-attention-update"
              text={`${nameOf(detection.kind)} ${versions}`.trim()}
              action={
                <Button
                  type="button"
                  variant="update"
                  size="sm"
                  disabled={running}
                  title={`Install the newer version of ${nameOf(detection.kind)}, as Settings does`}
                  onClick={() => void updates.update(detection.kind)}>
                  {running ? 'Updating…' : 'Update'}
                </Button>
              }>
              {result !== undefined && !result.ok && !running ? (
                <ErrorText>
                  {result.output ?? 'The update did not finish.'}
                </ErrorText>
              ) : null}
            </Row>
          );
        })}
      </Rows>
    </NoticeCard>
  );
}

export function AgentSignInCard({
  rows,
  login,
  nameOf,
  profiles,
  onDismiss,
  ownsLogin = true,
}: {
  rows: readonly SignedOutAccount[];
  login: CliLoginController;
  nameOf: (kind: string) => string;
  profiles: readonly ConfigProfile[];
  onDismiss?: () => void;
  /** Whether the sign-in under way, or just ended, is this card's: only then is its progress drawn here. */
  ownsLogin?: boolean;
}): React.JSX.Element {
  const busy = loginUnderWay(login);
  const signingHere = ownsLogin && busy;
  const signing = login.starting ?? login.login;
  const accountName = (kind: string, configDir: string | null): string =>
    configDir === null
      ? nameOf(kind)
      : `${nameOf(kind)} · ${configDirName(configDir, profiles)}`;
  const heading =
    rows.length === 0 && signingHere && signing !== null
      ? accountName(signing.kind, signing.configDir)
      : plural(rows.length, 'account', 'accounts');
  return (
    <NoticeCard
      slot={SLOT}
      kind="agent-sign-in"
      icon={KeyRound}
      label={rows.length === 0 && signingHere ? 'Signing in' : 'Sign-in needed'}
      heading={heading}
      settled={rows.length === 0 && !signingHere}
      settledIcon={CircleCheck}
      settledLabel="Signed in"
      onDismiss={rows.length > 0 && !signingHere ? onDismiss : undefined}>
      {rows.length === 0 ? null : (
        <Rows>
          {rows.map((row) => {
            const text = accountName(row.kind, row.configDir);
            const starting =
              login.starting?.kind === row.kind &&
              login.starting.server === null &&
              login.starting.configDir === row.configDir;
            return (
              <Row
                key={`${row.kind}:${row.configDir ?? ''}`}
                slot="settings-attention-sign-in"
                text={text}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title={`Sign ${text} in again, here, as Settings does`}
                    onClick={() => void login.start(row.kind, row.configDir)}>
                    {starting ? 'Signing in…' : 'Sign in'}
                  </Button>
                }
              />
            );
          })}
        </Rows>
      )}
      {login.login === null || !ownsLogin ? null : (
        <CliLoginProgress
          variant="inline"
          session={login.login.session}
          error={login.error}
          onSubmitCode={(code) => void login.submitCode(code)}
          onCancel={() => void login.cancel()}
          onDismiss={login.dismiss}
        />
      )}
    </NoticeCard>
  );
}

export function AppUpdateCard({
  update,
  remote,
  offered = null,
  onDismiss,
}: {
  update: UpdateController;
  remote: boolean;
  /** The version the notice offered, said while this launch does not know whether it still waits. */
  offered?: string | null;
  onDismiss?: () => void;
}): React.JSX.Element | null {
  const state = update.state;
  const text =
    state !== null && (appUpdateWaits(state) || appInstallFailed(state))
      ? updateStatusText(state)
      : offered === null
        ? null
        : `Geniro ${offered} is available.`;
  if (text === null) {
    return null;
  }
  return (
    <NoticeCard
      slot={SLOT}
      kind="app-update"
      icon={Download}
      label="Update available"
      heading="Geniro"
      onDismiss={onDismiss}>
      <div className="flex min-w-0 items-center gap-3 [&>button]:shrink-0">
        <p
          data-slot="settings-attention-app-update"
          className="m-0 min-w-0 flex-1 text-sm break-words">
          {text}
        </p>
        {remote ? null : <AppUpdateActions update={update} />}
      </div>
      {remote ? (
        <p className="m-0 text-xs text-muted-foreground">
          Install it on the Mac.
        </p>
      ) : null}
    </NoticeCard>
  );
}

export function ShareSignInCard({
  wait,
  api,
  remote,
  onDismiss,
}: {
  wait: ShareWait;
  api: DaemonApis['shares'];
  /** A paired device: the storage is signed in to on the Mac, so the card says so instead of offering it. */
  remote: boolean;
  onDismiss?: () => void;
}): React.JSX.Element {
  return (
    <NoticeCard
      slot={SLOT}
      kind="share-sign-in"
      icon={Link2}
      label="Waiting for sign-in"
      heading={wait.label}
      onDismiss={onDismiss}>
      <p
        data-slot="settings-attention-share-count"
        className="m-0 text-sm break-words">
        {plural(wait.count, 'shared link waits', 'shared links wait')} to be
        uploaded.{wait.reason === null ? null : ` ${wait.reason}.`}
      </p>
      {remote ? (
        <p className="m-0 text-xs text-muted-foreground">Sign in on the Mac.</p>
      ) : (
        <SignInAction
          api={api}
          destinationId={wait.destinationId}
          label={wait.label}
          className="self-start"
        />
      )}
    </NoticeCard>
  );
}

export function MemoryConflictsCard({
  findingIds,
  onOpen,
  onDismiss,
}: {
  findingIds: readonly string[];
  onOpen: (() => void) | null;
  onDismiss?: () => void;
}): React.JSX.Element {
  const count = findingIds.length;
  return (
    <NoticeCard
      slot={SLOT}
      kind="memory-conflicts"
      icon={GitCompareArrows}
      label="Waiting for your decision"
      heading={plural(count, 'memory conflict', 'memory conflicts')}
      onDismiss={onDismiss}>
      <p
        data-slot="settings-attention-conflicts"
        className="m-0 text-sm break-words">
        {count === 1
          ? '1 pair of memory entries repeats or contradicts itself.'
          : `${count} pairs of memory entries repeat or contradict each other.`}
      </p>
      {onOpen === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          Decide them in Settings → Memory → Clean up.
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          title="Open Settings → Memory → Clean up on its Conflicts tab"
          onClick={onOpen}>
          Review conflicts
        </Button>
      )}
    </NoticeCard>
  );
}

/** What a Settings notice's card draws now, or null while it draws nothing. */
export type SettingsNoticeView =
  | { kind: 'app-update'; offered: string | null }
  | { kind: 'agent-updates'; rows: CliDetection[] }
  | { kind: 'agent-sign-in'; rows: SignedOutAccount[]; ownsLogin: boolean }
  | { kind: 'share-sign-in'; wait: ShareWait }
  | { kind: 'memory-conflicts'; findingIds: readonly string[] };

/**
 * What a Settings notice's card shows: what Settings' own live readings hold
 * for it while the notice stands and was not dismissed, nothing otherwise.
 * While a live reading is not known (a check under way, an account not asked
 * yet, shares a paired device cannot read) it is what the notice holds. A
 * sign-in under way keeps its card until it ends.
 */
export function settingsNoticeView(
  store: SettingsNoticesStore,
  row: SettingsNoticeRowView,
): SettingsNoticeView | null {
  const notice = store.notices?.get(row.noticeId);
  const signing = store.login.starting ?? store.login.login;
  const ownsLogin =
    row.kind === 'agent-sign-in' &&
    signing !== null &&
    signing.server === null &&
    row.key === signInNoticeKey(signing);
  const signingIn = ownsLogin && loginUnderWay(store.login);
  if (
    notice === undefined ||
    (!signingIn && (notice.resolvedAt !== null || notice.dismissedAt !== null))
  ) {
    return null;
  }
  const offered = newestNoticeVersion(notice.items);
  const detections = store.detections ?? [];
  switch (row.kind) {
    case 'app-update':
      return appUpdateWaits(store.update.state) ||
        appUpdateUnsettled(store.update.state)
        ? { kind: 'app-update', offered }
        : null;
    case 'agent-updates': {
      const rows = detections
        .filter(
          (detection) =>
            row.key === `agent-updates:${detection.kind}` &&
            detection.found &&
            detection.update.available !== false &&
            (detection.update.available === true || offered !== null),
        )
        .map((detection) =>
          offered === null
            ? detection
            : {
                ...detection,
                update: { ...detection.update, latestVersion: offered },
              },
        );
      return rows.length === 0 ? null : { kind: 'agent-updates', rows };
    }
    case 'agent-sign-in': {
      const rows = detections
        .flatMap(accountLogins)
        .filter(
          (account) =>
            account.loggedIn !== true && row.key === signInNoticeKey(account),
        )
        .map(({ kind, configDir }) => ({ kind, configDir }));
      return rows.length === 0 && !signingIn
        ? null
        : { kind: 'agent-sign-in', rows, ownsLogin };
    }
    case 'share-sign-in': {
      const wait =
        store.shareWaits === null
          ? storedShareWait(notice)
          : shareWaitOf(store.shareWaits, row.key);
      return wait === null ? null : { kind: 'share-sign-in', wait };
    }
    case 'memory-conflicts': {
      const findingIds = store.conflictIds ?? notice.items;
      return findingIds.length === 0
        ? null
        : { kind: 'memory-conflicts', findingIds };
    }
  }
}

/** A Settings notice's row in the manager chat, and its card in the Needs you gallery. */
export function SettingsNoticeCard({
  row,
}: {
  row: SettingsNoticeRowView;
}): React.JSX.Element | null {
  const store = useContext(SettingsNoticesContext);
  const identities = useContext(AgentIdentityContext);
  const view = store === null ? null : settingsNoticeView(store, row);
  if (store === null || view === null) {
    return null;
  }
  const onDismiss = (): void => store.dismiss(row.noticeId);
  const nameOf = (kind: string): string => agentDisplayName(identities, kind);
  switch (view.kind) {
    case 'app-update':
      return (
        <AppUpdateCard
          update={store.update}
          remote={store.remote}
          offered={view.offered}
          onDismiss={onDismiss}
        />
      );
    case 'agent-updates':
      return (
        <AgentUpdatesCard
          rows={view.rows}
          updates={store.cliUpdates}
          nameOf={nameOf}
          onDismiss={onDismiss}
        />
      );
    case 'agent-sign-in':
      return (
        <AgentSignInCard
          rows={view.rows}
          login={store.login}
          nameOf={nameOf}
          profiles={store.profiles}
          ownsLogin={view.ownsLogin}
          onDismiss={onDismiss}
        />
      );
    case 'share-sign-in':
      return (
        <ShareSignInCard
          wait={view.wait}
          api={store.apis.shares}
          remote={store.remote}
          onDismiss={onDismiss}
        />
      );
    case 'memory-conflicts':
      return (
        <MemoryConflictsCard
          findingIds={view.findingIds}
          onOpen={store.onOpenMemoryConflicts}
          onDismiss={onDismiss}
        />
      );
  }
}
