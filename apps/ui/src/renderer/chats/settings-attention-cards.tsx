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
  appUpdateUnsettled,
  appUpdateWaits,
  configDirName,
  newestNoticeVersion,
  type ShareWait,
  shareWaitOf,
  signInNoticeKey,
} from './settings-attention';
import type { SettingsNoticeRowView } from './settings-notice-payload';
import { SettingsNoticesContext } from './settings-notices-context';

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
  const dismissable =
    rows.length > 0 && login.starting === null && login.login === null;
  return (
    <NoticeCard
      slot={SLOT}
      kind="agent-sign-in"
      icon={KeyRound}
      label="Sign-in needed"
      heading={plural(rows.length, 'account', 'accounts')}
      settled={rows.length === 0}
      settledIcon={CircleCheck}
      settledLabel="Signed in"
      onDismiss={dismissable ? onDismiss : undefined}>
      {rows.length === 0 ? null : (
        <Rows>
          {rows.map((row) => {
            const name = nameOf(row.kind);
            const text =
              row.configDir === null
                ? name
                : `${name} · ${configDirName(row.configDir, profiles)}`;
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
    state !== null && (appUpdateWaits(state) || state.phase === 'error')
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
  onDismiss,
}: {
  wait: ShareWait;
  api: DaemonApis['shares'];
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
        uploaded. {wait.reason}.
      </p>
      <SignInAction
        api={api}
        destinationId={wait.destinationId}
        label={wait.label}
        className="self-start"
      />
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

/**
 * A Settings notice's row in the manager chat: the card Settings' own live
 * readings draw for it while the notice stands and was not dismissed, nothing
 * otherwise. While a live reading is not known (a check under way, an account
 * not asked yet) the card is drawn from what the notice holds. A sign-in under
 * way keeps its card until it ends.
 */
export function SettingsNoticeCard({
  row,
}: {
  row: SettingsNoticeRowView;
}): React.JSX.Element | null {
  const store = useContext(SettingsNoticesContext);
  const identities = useContext(AgentIdentityContext);
  if (store === null) {
    return null;
  }
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
  const onDismiss = (): void => store.dismiss(row.noticeId);
  const nameOf = (kind: string): string => agentDisplayName(identities, kind);
  const detections = store.detections ?? [];
  switch (row.kind) {
    case 'app-update':
      return appUpdateWaits(store.update.state) ||
        appUpdateUnsettled(store.update.state) ? (
        <AppUpdateCard
          update={store.update}
          remote={store.remote}
          offered={offered}
          onDismiss={onDismiss}
        />
      ) : null;
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
      return rows.length === 0 ? null : (
        <AgentUpdatesCard
          rows={rows}
          updates={store.cliUpdates}
          nameOf={nameOf}
          onDismiss={onDismiss}
        />
      );
    }
    case 'agent-sign-in': {
      const rows = detections
        .flatMap(accountLogins)
        .filter(
          (account) =>
            account.loggedIn !== true && row.key === signInNoticeKey(account),
        )
        .map(({ kind, configDir }) => ({ kind, configDir }));
      return rows.length === 0 && !signingIn ? null : (
        <AgentSignInCard
          rows={rows}
          login={store.login}
          nameOf={nameOf}
          profiles={store.profiles}
          ownsLogin={ownsLogin}
          onDismiss={onDismiss}
        />
      );
    }
    case 'share-sign-in': {
      const wait = shareWaitOf(store.shareWaits, row.key);
      return wait === null ? null : (
        <ShareSignInCard
          wait={wait}
          api={store.apis.shares}
          onDismiss={onDismiss}
        />
      );
    }
    case 'memory-conflicts':
      return store.conflictIds.length === 0 ? null : (
        <MemoryConflictsCard
          findingIds={store.conflictIds}
          onOpen={store.onOpenMemoryConflicts}
          onDismiss={onDismiss}
        />
      );
  }
}
